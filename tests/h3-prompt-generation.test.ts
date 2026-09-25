import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import * as languages from "../src/utils/videoLanguages";
import * as contract from "../src/utils/h3PromptContract";
import * as slots from "../src/utils/h3ReferenceSlots";
import * as plans from "../src/utils/h3ReferencePlan";
import * as stateGuard from "../src/utils/h3VisualStateGuard";
import { validateFields } from "../src/middleware/middleware";

for (const scenario of [
  { mode: "single", replaceBasePrompt: undefined },
  { mode: "single", replaceBasePrompt: true },
  { mode: "batch", replaceBasePrompt: true },
] as const) {
test(`H3 ${scenario.mode} prompt API preserves requested language isolation with replaceBasePrompt=${String(scenario.replaceBasePrompt)}`, async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  for (const [name, columns] of Object.entries({
    o_project: ['id', 'artStyle'], o_videoTrack: ['id', 'projectId', 'prompt', 'duration', 'state', 'reason'],
    o_assets: ['projectId', 'id', 'assetsId', 'type', 'name', 'describe', 'prompt', 'imageId', 'faceReferencePath', 'fullBodyReferencePath', 'sideReferencePath', 'backReferencePath'],
    o_image: ['id', 'filePath'], o_assetsRole2Audio: ['assetsRoleId', 'assetsAudioId'],
    o_prompt: ['type','data','useData'], o_modelPrompt: ['vendorId','model','path'],
  })) await db.schema.createTable(name, t => { columns.forEach(c => c === "id" || c === "projectId" || c === "imageId" ? t.integer(c) : t.text(c)); });
  await languages.migrateVideoLanguages(db);
  await db('o_project').insert({ id: 1, artStyle: 'realistic_3d_anime' });
  await db('o_videoTrack').insert({ id: 2, projectId: 1, prompt: 'old base', duration: 6 });
  await db('o_image').insert({ id: 3, filePath: 'sheet.png' });
  await db('o_assets').insert({ id: 4, projectId: 1, type: 'role', name: 'Ava', describe: 'old trousers', prompt: 'old trousers', imageId: 3, faceReferencePath: 'face.png', fullBodyReferencePath: 'body.png' });
  await db('o_videoPromptVariant').insert({ trackId: 2, language: 'ja-JP', prompt: 'keep manual edit', state: '已完成' });
  const valid = `subject_definitions:
<Subject 1> is Ava from <Picture 1> and <Picture 2>, with a red sweater and black skirt.
summary:
[reference generation] <Subject 1> stands on deck.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - Face and wardrobe retained.
detailed_description:
Detailed 3D with fine hair and skin texture.
[Shot 1] <Subject 1> (S1) says, (spoken locale: en-US) <d>[English] Hello.</d>
overall_soundscape:
Wind.
non_diegetic_music:
N/A`;
  const raw = valid.replace("(spoken locale: en-US) <d>[English]", "<d>[English] (en-US)");
  const calls: any[] = [], loaded: string[] = [];
  const u = { db, error: (e: any) => e, getArtPrompt: () => 'Keep restrained eyes and skin texture.', getPath: () => 'data/modelPrompt',
    oss: { getImageBase64: async (p: string) => { loaded.push(p); return 'data:image/png;base64,' + Buffer.from(p).toString('base64'); } },
    Ai: { Text: () => ({ invoke: async (request: any) => {
      calls.push(structuredClone(request));
      if (calls.length === 3) {
        // The validated base and its exact plan must be committed before translation begins.
        assert.equal((await db("o_videoTrack").where({ id: 2 }).first()).prompt, scenario.replaceBasePrompt ? valid : "old base");
        assert.deepEqual((await plans.loadH3ReferencePlan(db, 2, valid))?.slots.map(slot => slot.path), ["face.png", "body.png"]);
      }
      return { text: calls.length === 1 ? raw.replace('<Subject 1> (appears', '<Picture 1> (appears') : ` \n${raw}\n ` };
    } }) },
  };
  const imports: Record<string, unknown> = {
    '@/utils': u, '@/utils/db': { db }, '@/utils/videoLanguages': languages, '@/utils/h3PromptContract': contract,
    '@/utils/h3ReferenceSlots': slots, '@/utils/h3ReferencePlan': plans, '@/utils/h3VisualStateGuard': stateGuard, '@/middleware/middleware': { validateFields },
    '@/lib/responseFormat': { success: (data: unknown) => ({ data }), error: (message: string) => ({message}) },
  };
  const localRequire = createRequire(`${process.cwd()}/package.json`), mod = {exports: {} as any};
  const service = { exports: {} as any };
  new Function('require','module','exports',transform(readFileSync('src/utils/videoPromptGeneration.ts','utf8'), {transforms:['typescript','imports']}).code)((id: string) => imports[id] || localRequire(id),service,service.exports);
  imports['@/utils/videoPromptGeneration'] = service.exports;
  const routeName = scenario.mode === 'single' ? 'generateVideoPrompt' : 'batchGeneratePrompt';
  const code = transform(readFileSync(`src/routes/production/workbench/${routeName}.ts`,'utf8'), {transforms:['typescript','imports']}).code;
  new Function('require','module','exports',code)((id: string) => imports[id] || localRequire(id),mod,mod.exports);
  const app=express(); app.use(express.json()); app.use('/',mod.exports.default);
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));
  try {
    const info = [{ id: 4, sources: 'assets' }];
    const requestBody = { projectId: 1, languages: ['en-US'], regenerate: true, replaceBasePrompt: scenario.replaceBasePrompt, model: 'comfyui_local:MiniMax-H3-local', mode: '["imageReference:9"]',
      ...(scenario.mode === 'single' ? { trackId: 2, info } : { trackData: [{ trackId: 2, info }] }),
    };
    const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody)});
    assert.equal(response.status,200,await response.text());
    if (scenario.mode === 'batch') {
      for (let i = 0; i < 100 && (await db('o_videoTrack').where({ id: 2 }).first()).state === '生成中'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const savedTrack = await db('o_videoTrack').where({ id: 2 }).first();
    assert.equal(savedTrack.state, '已完成', savedTrack.reason);
    assert.equal(savedTrack.prompt, scenario.replaceBasePrompt ? valid : 'old base');
    if (scenario.replaceBasePrompt) assert.deepEqual(await plans.loadH3ReferencePlan(db, 2, savedTrack.prompt), await plans.loadH3ReferencePlan(db, 2, valid));
    else assert.equal(await plans.loadH3ReferencePlan(db, 2, savedTrack.prompt), null);
    assert.deepEqual(loaded,['face.png','body.png']);
    assert.equal(calls.length,3);
    assert.equal((await plans.loadH3ReferencePlan(db, 2, valid))?.slots.length, 2);
    assert.match(calls[0].system,/restrained eyes/);
    assert.doesNotMatch(calls[0].messages[0].content[0].text, /old trousers|legacyVisualPrompt/);
    assert.match(calls[0].messages[0].content[0].text, /appearanceAuthority=the actual attached current image/);
    const imageParts=calls[0].messages[0].content.filter((p: any)=>p.type==='image');
    assert.deepEqual(imageParts.map((p: any)=>Buffer.from(p.image).toString()),['face.png','body.png']);
    assert.match(calls[1].messages.at(-1).content,/Validation error/);
    assert.equal((await db('o_videoPromptVariant').where({language:'en-US'}).first()).prompt,valid);
    assert.equal((await db('o_videoPromptVariant').where({language:'ja-JP'}).first()).prompt,'keep manual edit');
  } finally { await new Promise<void>(r=>server.close(()=>r())); await db.destroy(); }
});
}

async function makeBudgetFixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  for (const [name, columns] of Object.entries({
    o_project: ["id", "artStyle"], o_videoTrack: ["id", "projectId", "prompt", "duration", "state", "reason"],
    o_assets: ["id", "projectId", "assetsId", "type", "name", "describe", "prompt", "imageId", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath"],
    o_image: ["id", "filePath"], o_assetsRole2Audio: ["assetsRoleId", "assetsAudioId"],
    o_prompt: ["type", "data", "useData"], o_modelPrompt: ["vendorId", "model", "path"],
  })) await db.schema.createTable(name, t => columns.forEach(c => c === "id" || c === "projectId" || c === "imageId" ? t.integer(c) : t.text(c)));
  await db("o_project").insert({ id: 1, artStyle: "realistic_3d_anime" });
  await db("o_videoTrack").insert([{ id: 2, projectId: 1, duration: 11, prompt: "keep old prompt" }, { id: 3, projectId: 1, duration: 11 }]);
  for (let id = 1; id <= 10; id++) {
    await db("o_image").insert({ id, filePath: `asset-${id}.png` });
    await db("o_assets").insert({ id, projectId: 1, type: id <= 3 ? "role" : id <= 5 ? "scene" : "tool", name: `asset${id}`, imageId: id,
      faceReferencePath: id <= 3 ? `face-${id}.png` : null, fullBodyReferencePath: id <= 3 ? `body-${id}.png` : null });
  }
  const calls: any[] = [];
  const u = { db, error: (e: any) => e, getArtPrompt: () => "Detailed stylized 3D.", getPath: () => "data/modelPrompt",
    oss: { getImageBase64: async (p: string) => "data:image/png;base64," + Buffer.from(p).toString("base64") },
    Ai: { Text: () => ({ invoke: async (request: any) => {
      calls.push(request);
      const text = request.messages[0].content[0].text;
      const groups = new Map<string, string[]>();
      for (const match of text.matchAll(/<reference slot="(\d+)" sources="assets" id="(\d+)"/g)) {
        const pictures = groups.get(match[2]) || []; pictures.push(`<Picture ${match[1]}>`); groups.set(match[2], pictures);
      }
      assert.ok(groups.size, text);
      const subjects = [...groups.values()];
      return { text: `subject_definitions:\n${subjects.map((refs, i) => `<Subject ${i + 1}> is the asset from ${refs.join(" and ")}.`).join("\n")}\nsummary:\n[reference generation] <Subject 1> appears.\nretention_analysis:\n${subjects.map((_, i) => `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - Its appearance is retained.`).join("\n")}\ndetailed_description:\nDetailed stylized 3D.\n[Shot 1] All subjects stand still.\noverall_soundscape:\nWind.\nnon_diegetic_music:\nN/A` };
    } }) },
  };
  const imports: Record<string, any> = { "@/utils": u, "@/utils/db": { db }, "@/utils/videoLanguages": languages,
    "@/utils/h3PromptContract": contract, "@/utils/h3ReferenceSlots": slots, "@/utils/h3ReferencePlan": plans,
    "@/utils/h3VisualStateGuard": stateGuard, "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
  };
  const localRequire = createRequire(`${process.cwd()}/package.json`);
  const load = (file: string) => {
    const mod = { exports: {} as any };
    new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)((id: string) => imports[id] || localRequire(id), mod, mod.exports);
    return mod.exports;
  };
  imports["@/utils/videoPromptGeneration"] = load("src/utils/videoPromptGeneration.ts");
  const app = express(); app.use(express.json());
  for (const route of ["generateVideoPrompt", "batchGeneratePrompt", "updateVideoPrompt"]) app.use(`/${route}`, load(`src/routes/production/workbench/${route}.ts`).default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  return { db, calls, post: async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }, close: async () => { await new Promise<void>(r => server.close(() => r())); await db.destroy(); } };
}
const budgetBody = { projectId: 1, model: "test:MiniMax-H3-local", mode: '["imageReference:9"]', info: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, sources: "assets" })) };

test("single and batch prompt routes retain all seven assets in nine actual pictures and persist the identical reference plan", async () => {
  const f = await makeBudgetFixture();
  try {
    const single = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    const batch = await f.post("batchGeneratePrompt", { ...budgetBody, trackData: [{ trackId: 3, info: budgetBody.info }] });
    assert.equal(batch.status, 200);
    for (let i = 0; i < 100 && (await f.db("o_videoTrack").where({ id: 3 }).first()).state === "生成中"; i++) await new Promise(r => setTimeout(r, 10));
    const track = await f.db("o_videoTrack").where({ id: 3 }).first();
    assert.equal(track.state, "已完成", track.reason);
    const expected = ["face-1.png", "body-1.png", "face-2.png", "body-2.png", "body-3.png", "asset-4.png", "asset-5.png", "asset-6.png", "asset-7.png"];
    for (const call of f.calls) assert.deepEqual(call.messages[0].content.filter((p: any) => p.type === "image").map((p: any) => Buffer.from(p.image).toString()), expected);
    assert.equal(f.calls.length, 2);
    const plan = await plans.loadH3ReferencePlan(f.db, 2, single.body.data);
    assert.deepEqual(plan?.slots.map(s => s.path), expected);
    assert.equal(new Set(plan?.slots.map(s => s.assetId)).size, 7);
    assert.deepEqual(await plans.loadH3ReferencePlan(f.db, 3, track.prompt), plan);
    const edited = single.body.data.replace("stand still", "walk slowly");
    assert.equal((await f.post("updateVideoPrompt", { id: 2, prompt: edited })).status, 200);
    assert.deepEqual(await plans.loadH3ReferencePlan(f.db, 2, edited), plan);
    assert.equal((await f.post("updateVideoPrompt", { id: 2, prompt: edited.replaceAll("<Picture 9>", "<Picture 10>") })).status, 409);
    assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).prompt, edited);
  } finally { await f.close(); }
});

test("preflight overflow and missing crops finish failed without calling a model or replacing the saved prompt", async () => {
  const f = await makeBudgetFixture();
  try {
    const overflow = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2, info: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, sources: "assets" })) });
    assert.equal(overflow.status, 400);
    assert.match(overflow.body.message, /9/);
    let track = await f.db("o_videoTrack").where({ id: 2 }).first();
    assert.equal(track.state, "生成失败"); assert.equal(track.prompt, "keep old prompt");
    await f.db("o_assets").where({ id: 3 }).update({ fullBodyReferencePath: null });
    const missing = await f.post("batchGeneratePrompt", { ...budgetBody, trackData: [{ trackId: 2, info: budgetBody.info }] });
    assert.equal(missing.status, 200);
    for (let i = 0; i < 100 && (await f.db("o_videoTrack").where({ id: 2 }).first()).state === "生成中"; i++) await new Promise(r => setTimeout(r, 10));
    track = await f.db("o_videoTrack").where({ id: 2 }).first();
    assert.equal(track.state, "生成失败"); assert.match(track.reason, /正面全身/); assert.equal(track.prompt, "keep old prompt");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
