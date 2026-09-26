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
<Subject 1> is Ava from <Picture 1>, with a red sweater and black skirt.
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
  const generatedBase = valid.replace('<Subject 1> (appears', '<Picture 1> (appears');
  const calls: any[] = [], loaded: string[] = [];
  const u = { db, error: (e: any) => e, getArtPrompt: () => 'Keep restrained eyes and skin texture.', getPath: () => 'data/modelPrompt',
    oss: { getImageBase64: async (p: string) => { loaded.push(p); return 'data:image/png;base64,' + Buffer.from(p).toString('base64'); } },
    Ai: { Text: () => ({ invoke: async (request: any) => {
      if (String(request.system).startsWith("H3_SEMANTIC_REVIEW")) return { text: '{"issues":[]}' };
      calls.push(structuredClone(request));
      if (calls.length === 3) {
        // The validated base and its exact plan must be committed before translation begins.
        assert.equal((await db("o_videoTrack").where({ id: 2 }).first()).prompt, scenario.replaceBasePrompt ? generatedBase : "old base");
        assert.deepEqual((await plans.loadH3ReferencePlan(db, 2, generatedBase))?.slots.map(slot => slot.path), ["sheet.png"]);
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
    assert.equal(savedTrack.prompt, scenario.replaceBasePrompt ? generatedBase : 'old base');
    if (scenario.replaceBasePrompt) assert.deepEqual(await plans.loadH3ReferencePlan(db, 2, savedTrack.prompt), await plans.loadH3ReferencePlan(db, 2, generatedBase));
    else assert.equal(await plans.loadH3ReferencePlan(db, 2, savedTrack.prompt), null);
    assert.deepEqual(loaded,['sheet.png']);
    assert.equal(calls.length,2);
    assert.equal((await plans.loadH3ReferencePlan(db, 2, generatedBase))?.slots.length, 1);
    assert.match(calls[0].system,/restrained eyes/);
    assert.doesNotMatch(calls[0].messages[0].content[0].text, /old trousers|legacyVisualPrompt/);
    assert.match(calls[0].messages[0].content[0].text, /appearanceAuthority=the actual attached current image/);
    const imageParts=calls[0].messages[0].content.filter((p: any)=>p.type==='image');
    assert.deepEqual(imageParts.map((p: any)=>Buffer.from(p.image).toString()),['sheet.png']);
    assert.doesNotMatch(calls[1].system,/Mandatory H3 output syntax|ALL SIX SECTIONS/);
    assert.equal((await db('o_videoPromptVariant').where({language:'en-US'}).first()).prompt,valid);
    assert.equal((await db('o_videoPromptVariant').where({language:'ja-JP'}).first()).prompt,'keep manual edit');
  } finally { await new Promise<void>(r=>server.close(()=>r())); await db.destroy(); }
});
}

async function makeBudgetFixture(reply?: (prompt: string, call: number, request: any) => string, audit?: (call: number, request: any) => string, visualManual = "Detailed stylized 3D.") {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  for (const [name, columns] of Object.entries({
    o_project: ["id", "artStyle"], o_videoTrack: ["id", "projectId", "prompt", "duration", "state", "reason"],
    o_assets: ["id", "projectId", "assetsId", "type", "name", "describe", "prompt", "imageId", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath"],
    o_image: ["id", "filePath"], o_assetsRole2Audio: ["assetsRoleId", "assetsAudioId"],
    o_prompt: ["type", "data", "useData"], o_modelPrompt: ["vendorId", "model", "path"],
  })) await db.schema.createTable(name, t => columns.forEach(c => c === "id" || c === "projectId" || c === "imageId" ? t.integer(c) : t.text(c)));
  await languages.migrateVideoLanguages(db);
  await db("o_project").insert({ id: 1, artStyle: "realistic_3d_anime" });
  await db("o_videoTrack").insert([{ id: 2, projectId: 1, duration: 11, prompt: "keep old prompt" }, { id: 3, projectId: 1, duration: 11 }]);
  for (let id = 1; id <= 10; id++) {
    await db("o_image").insert({ id, filePath: `asset-${id}.png` });
    await db("o_assets").insert({ id, projectId: 1, type: id <= 3 ? "role" : id <= 5 ? "scene" : "tool", name: `asset${id}`, imageId: id,
      faceReferencePath: id <= 3 ? `face-${id}.png` : null, fullBodyReferencePath: id <= 3 ? `body-${id}.png` : null });
  }
  const calls: any[] = [], audits: any[] = [];
  const u = { db, error: (e: any) => e, getArtPrompt: () => visualManual, getPath: () => "data/modelPrompt",
    oss: { getImageBase64: async (p: string) => "data:image/png;base64," + Buffer.from(p).toString("base64") },
    Ai: { Text: () => ({ invoke: async (request: any) => {
      if (String(request.system).startsWith("H3_SEMANTIC_REVIEW")) {
        audits.push(structuredClone(request));
        return { text: audit ? audit(audits.length, request) : '{"issues":[]}' };
      }
      calls.push(structuredClone(request));
      if (typeof request.messages[0].content === "string") {
        const source = request.messages[0].content;
        return { text: reply ? reply(source, calls.length, request) : source };
      }
      const text = request.messages[0].content[0].text;
      const groups = new Map<string, string[]>();
      for (const match of text.matchAll(/<reference slot="(\d+)" sources="assets" id="(\d+)"/g)) {
        const pictures = groups.get(match[2]) || []; pictures.push(`<Picture ${match[1]}>`); groups.set(match[2], pictures);
      }
      assert.ok(groups.size, text);
      const subjects = [...groups.values()];
      const draft = `subject_definitions:\n${subjects.map((refs, i) => `<Subject ${i + 1}> is the asset from ${refs.join(" and ")}.`).join("\n")}\nsummary:\n[reference generation] <Subject 1> appears.\nretention_analysis:\n${subjects.map((_, i) => `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - Its appearance is retained.`).join("\n")}\ndetailed_description:\nDetailed stylized 3D.\n[Shot 1] ${subjects.map((_, i) => `<Subject ${i + 1}>`).join(", ")} stand still.\noverall_soundscape:\nWind.\nnon_diegetic_music:\nN/A`;
      return { text: reply ? reply(draft, calls.length, request) : draft };
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
  return { db, calls, audits, post: async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }, close: async () => { await new Promise<void>(r => server.close(() => r())); await db.destroy(); } };
}
const budgetBody = { projectId: 1, model: "test:MiniMax-H3-local", mode: '["imageReference:9"]', info: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, sources: "assets" })) };

test("single and batch prompt routes retain all seven assets in seven complete asset pictures and persist the identical reference plan", async () => {
  const f = await makeBudgetFixture();
  try {
    await f.db("o_assets").update({ faceReferencePath: null, fullBodyReferencePath: null, sideReferencePath: null, backReferencePath: null });
    const single = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    const batch = await f.post("batchGeneratePrompt", { ...budgetBody, trackData: [{ trackId: 3, info: budgetBody.info }] });
    assert.equal(batch.status, 200);
    for (let i = 0; i < 100 && (await f.db("o_videoTrack").where({ id: 3 }).first()).state === "生成中"; i++) await new Promise(r => setTimeout(r, 10));
    const track = await f.db("o_videoTrack").where({ id: 3 }).first();
    assert.equal(track.state, "已完成", track.reason);
    const expected = ["asset-1.png", "asset-2.png", "asset-3.png", "asset-4.png", "asset-5.png", "asset-6.png", "asset-7.png"];
    for (const call of f.calls) assert.deepEqual(call.messages[0].content.filter((p: any) => p.type === "image").map((p: any) => Buffer.from(p.image).toString()), expected);
    assert.equal(f.calls.length, 2);
    const plan = await plans.loadH3ReferencePlan(f.db, 2, single.body.data);
    assert.deepEqual(plan?.slots.map(s => s.path), expected);
    assert.equal(new Set(plan?.slots.map(s => s.assetId)).size, 7);
    assert.deepEqual(await plans.loadH3ReferencePlan(f.db, 3, track.prompt), plan);
    const edited = single.body.data.replace("stand still", "walk slowly");
    assert.equal((await f.post("updateVideoPrompt", { id: 2, prompt: edited })).status, 200);
    assert.deepEqual(await plans.loadH3ReferencePlan(f.db, 2, edited), plan);
    const freelyEdited = edited.replaceAll("<Picture 7>", "<Picture 10>");
    assert.equal((await f.post("updateVideoPrompt", { id: 2, prompt: freelyEdited })).status, 200);
    assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).prompt, freelyEdited);
  } finally { await f.close(); }
});

test("preflight overflow and missing boards finish failed without calling a model or replacing the saved prompt", async () => {
  const f = await makeBudgetFixture();
  try {
    const overflow = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2, info: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, sources: "assets" })) });
    assert.equal(overflow.status, 400);
    assert.match(overflow.body.message, /9/);
    let track = await f.db("o_videoTrack").where({ id: 2 }).first();
    assert.equal(track.state, "生成失败"); assert.equal(track.prompt, "keep old prompt");
    await f.db("o_image").where({ id: 3 }).update({ filePath: null });
    const missing = await f.post("batchGeneratePrompt", { ...budgetBody, trackData: [{ trackId: 2, info: budgetBody.info }] });
    assert.equal(missing.status, 200);
    for (let i = 0; i < 100 && (await f.db("o_videoTrack").where({ id: 2 }).first()).state === "生成中"; i++) await new Promise(r => setTimeout(r, 10));
    track = await f.db("o_videoTrack").where({ id: 2 }).first();
    assert.equal(track.state, "生成失败"); assert.match(track.reason, /参考图缺失/); assert.equal(track.prompt, "keep old prompt");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("H3 always loads its Ref2VA rules even when a vendor is bound to a legacy template", async () => {
  const f = await makeBudgetFixture();
  try {
    await f.db("o_modelPrompt").insert({ vendorId: "test", model: "MiniMax-H3-local", path: "video/universalFirstAndLastFrameMode.md" });
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.match(f.calls[0].system, /MiniMax H3 Ref2VA prompt writer/);
    assert.match(f.calls[0].system, /references\/ref-en\.txt/);
    assert.match(f.calls[0].system, /references\/base-en\.txt/);
  } finally { await f.close(); }
});

test("H3 generation no longer hard-rejects a prompt because fixed sections are missing", async () => {
  const f = await makeBudgetFixture((draft, call) => call === 1 ? draft.slice(draft.indexOf("summary:")) : draft);
  try {
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(f.calls[0].system, /Mandatory H3 output syntax|ALL SIX SECTIONS/);
    assert.ok(result.body.data.startsWith("summary:"));
    assert.equal((await plans.loadH3ReferencePlan(f.db, 2, result.body.data))?.slots.length, 7);
  } finally { await f.close(); }
});

test("H3 generation persists the selected template output without fixed-format repair retries", async () => {
  const f = await makeBudgetFixture((draft, call) => call === 1
    ? draft.replace("fully_preserved", "invalid_marker")
    : draft.slice(draft.indexOf("detailed_description:")));
  try {
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.calls.length, 1);
    const track = await f.db("o_videoTrack").where({ id: 2 }).first();
    assert.match(track.prompt, /invalid_marker/);
    assert.equal(track.state, "已完成");
    assert.equal((await plans.loadH3ReferencePlan(f.db, 2, track.prompt))?.slots.length, 7);
  } finally { await f.close(); }
});

test("translation also accepts the source template structure without fixed-section repair", async () => {
  const f = await makeBudgetFixture((draft, call) => call === 2 ? draft.slice(draft.indexOf("summary:")) : draft);
  try {
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2, languages: ["en-US"], regenerate: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.calls.length, 2);
    assert.doesNotMatch(f.calls[1].system, /Mandatory H3 output syntax|ALL SIX SECTIONS/);
    const variant = await f.db("o_videoPromptVariant").where({ trackId: 2, language: "en-US" }).first();
    assert.equal(variant.state, "已完成", variant.reason);
    assert.ok(variant.prompt.startsWith("summary:"));
    assert.equal((await plans.loadH3ReferencePlan(f.db, 2, variant.prompt))?.slots.length, 7);
    assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).prompt, "keep old prompt");
  } finally { await f.close(); }
});

test("translation review restores the saved Picture order when the request supplies the same assets in reverse", async () => {
  const f = await makeBudgetFixture();
  try {
    const originalInfo = [{ id: 2, sources: "assets" }, { id: 1, sources: "assets" }];
    const generated = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2, info: originalInfo });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const source = generated.body.data;
    const originalPlan = await plans.loadH3ReferencePlan(f.db, 2, source);
    assert.deepEqual(originalPlan?.slots.map(item => item.assetId), [2, 1]);
    const translated = await f.post("generateVideoPrompt", {
      ...budgetBody, trackId: 2, languages: ["en-US"],
      info: [{ id: 1, sources: "assets" }, { id: 2, sources: "assets" }],
    });
    assert.equal(translated.status, 200, JSON.stringify(translated.body));
    assert.equal(f.calls.length, 2, "existing base is translated without regeneration");
    assert.equal(f.calls[1].messages[0].content, source);
    const audit = f.audits[1];
    assert.deepEqual(audit.messages[0].content.filter((part: any) => part.type === "image").map((part: any) => Buffer.from(part.image).toString()), ["asset-2.png", "asset-1.png"]);
    const context = audit.messages[0].content[0].text;
    assert.match(context, /<reference slot="1" sources="assets" id="2"/);
    assert.match(context, /<reference slot="2" sources="assets" id="1"/);
    const groups = JSON.parse(/<referenceSubjects>\s*([\s\S]*?)\s*<\/referenceSubjects>/.exec(context)![1]);
    assert.deepEqual(groups.map((group: any) => [group.assetId, group.pictures[0].picture]), [[2, "<Picture 1>"], [1, "<Picture 2>"]]);
    assert.match(audit.messages[0].content[1].text, /<Picture 1>: asset2;/);
    assert.match(audit.messages[0].content[3].text, /<Picture 2>: asset1;/);
    const variant = await f.db("o_videoPromptVariant").where({ trackId: 2, language: "en-US" }).first();
    assert.equal(variant.state, "已完成", variant.reason);
    assert.deepEqual(await plans.loadH3ReferencePlan(f.db, 2, variant.prompt), originalPlan);
    assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).prompt, source);
  } finally { await f.close(); }
});

test("out-of-range H3 duration is reported instead of silently clamped before writing the prompt", async () => {
  const f = await makeBudgetFixture();
  try {
    await f.db("o_videoTrack").where({ id: 2 }).update({ duration: 18 });
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /18s.*4–15/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).prompt, "keep old prompt");
  } finally { await f.close(); }
});

test("semantic review sees actual images and rejects a structurally valid draft before persistence", async () => {
  const f = await makeBudgetFixture(undefined, call => call === 1
    ? JSON.stringify({ issues: [{ code: "EVENT_ORDER", evidence: "The warning follows the completed push.", reason: "The source requires the warning before the push." }] })
    : '{"issues":[]}');
  try {
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.calls.length, 2);
    assert.equal(f.audits.length, 2);
    assert.equal(f.audits[0].messages[0].content.filter((part: any) => part.type === "image").length, 7);
    assert.match(f.calls[1].messages.at(-1).content, /EVENT_ORDER/);
    assert.match(f.calls[1].messages.at(-1).content, /warning before the push/);
    assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).state, "已完成");
  } finally { await f.close(); }
});

test("persistent semantic contradictions remain failed and preserve the prior prompt", async () => {
  const f = await makeBudgetFixture(undefined, () => JSON.stringify({ issues: [{ code: "STATE_CONTINUITY", evidence: "closed bite then open jaws", reason: "The source contains no release event." }] }));
  try {
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(result.status, 400);
    assert.equal(f.calls.length, 3); assert.equal(f.audits.length, 3);
    assert.match(result.body.message, /STATE_CONTINUITY/);
    const saved = await f.db("o_videoTrack").where({ id: 2 }).first();
    assert.equal(saved.state, "生成失败"); assert.equal(saved.prompt, "keep old prompt");
  } finally { await f.close(); }
});

test("base and translation audits receive the selected visual manual without adding model calls", async () => {
  const manual = "Retain the current character images' degree of realism, facial proportions and visible skin, hair and fabric appearance; adapt only the scene lighting.";
  const f = await makeBudgetFixture(undefined, undefined, manual);
  try {
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2, languages: ["en-US"], regenerate: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.calls.length, 2, "one base writer and one translator");
    assert.equal(f.audits.length, 2, "reuse the existing base and translation reviews");
    assert.ok(f.calls[0].system.includes(manual));
    for (const audit of f.audits) {
      const parts = audit.messages[0].content;
      const requirements = parts.filter((part: any) => part.type === "text" && part.text.includes(manual));
      assert.equal(requirements.length, 1);
      assert.match(requirements[0].text, /selected video manual/);
      assert.equal(parts.filter((part: any) => part.type === "image").length, 7);
    }
    const saved = await f.db("o_videoPromptVariant").where({ trackId: 2, language: "en-US" }).first();
    assert.equal(saved.state, "已完成", saved.reason);
  } finally { await f.close(); }
});

test("a requested rendering-source omission follows the existing bounded repair path", async () => {
  const manual = "The final style opening must inherit the current character images' rendering appearance.";
  const f = await makeBudgetFixture(undefined, call => call === 1
    ? JSON.stringify({ issues: [{ code: "REFERENCE_RENDERING", evidence: "Detailed stylized 3D.", reason: "The supplied visual manual requires the reference-rendering relationship, which this generic description omits." }] })
    : '{"issues":[]}', manual);
  try {
    const result = await f.post("generateVideoPrompt", { ...budgetBody, trackId: 2 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.calls.length, 2);
    assert.equal(f.audits.length, 2);
    assert.match(f.calls[1].messages.at(-1).content, /REFERENCE_RENDERING/);
    assert.match(f.calls[1].messages.at(-1).content, /supplied visual manual/);
  } finally { await f.close(); }
});
