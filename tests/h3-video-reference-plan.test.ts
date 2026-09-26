import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import { z } from "zod";
import * as referencePlans from "../src/utils/h3ReferencePlan";
import * as referenceBindings from "../src/utils/h3ReferenceBindings";
import * as guards from "../src/utils/h3VisualStateGuard";
import { validateFields } from "../src/middleware/middleware";

const requireModule = createRequire(process.cwd() + "/package.json");
const settings = { projectId: 7, scriptId: 2, model: "test:MiniMax-H3-local", mode: '["imageReference:9"]', resolution: "768p", audio: true };
const picturePrompt = (count: number, assetGroups = Array.from({ length: count }, (_, index) => index + 1)) => {
  const groups = new Map<number, number[]>();
  assetGroups.forEach((assetId, index) => groups.set(assetId, [...(groups.get(assetId) || []), index + 1]));
  const definitions = [...groups].map(([assetId, pictures]) => "<Subject " + assetId + "> is the asset shown in " + pictures.map(picture => "<Picture " + picture + ">").join(" and ") + ".");
  return [
    "subject_definitions:", ...definitions,
    "summary:", "[reference generation] The referenced subjects move.",
    "retention_analysis:", ...[...groups.keys()].map(id => "<Subject " + id + "> (appears in [Shot 1]): fully_preserved - The identity is unchanged."),
    "detailed_description:", "Semi-realistic 3D with natural fabric and skin.",
    "[Shot 1] The camera follows the referenced subjects.",
    "overall_soundscape:", "Wind and footsteps.", "non_diegetic_music:", "N/A",
  ].join("\n");
};
const asset = (id: number, type = "role") => ({
  id, projectId: 7, assetsId: null, type, name: "asset-" + id, prompt: "四栏：脸部特写、正面全身、侧面全身、背面全身", imageId: id,
  faceReferencePath: type === "role" ? id + "-face.png" : null,
  fullBodyReferencePath: type === "role" ? id + "-front.png" : null,
  sideReferencePath: type === "role" ? id + "-side.png" : null,
  backReferencePath: type === "role" ? id + "-back.png" : null,
  referenceLayout: type === "role" ? "four_view" : null,
});
const planSlot = (id: number, assetType: string, kind?: referenceMedia.RoleReferenceKind) => ({
  assetId: id, assetType, ...(kind ? { kind } : {}),
  path: kind ? id + ({ FACE: "-face", FULL_BODY_FRONT: "-front", FULL_BODY_SIDE: "-side", FULL_BODY_BACK: "-back" }[kind]) + ".png" : id + "-sheet.png",
  label: "asset-" + id + (kind ? " " + kind : ""),
});

async function savePlan(db: any, trackId: number, prompt: string, plan: referencePlans.H3ReferencePlan) {
  const fields = { FACE: "faceReferencePath", FULL_BODY_FRONT: "fullBodyReferencePath", FULL_BODY_SIDE: "sideReferencePath", FULL_BODY_BACK: "backReferencePath" };
  return referencePlans.saveH3ReferencePlan(db, trackId, prompt, plan.slots.map(slot => ({
    ...slot, _referenceRole: slot.kind, filePath: slot.path,
    ...(slot.kind ? { [fields[slot.kind]]: slot.path } : {}),
  })));
}

async function fixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_project", t => { t.integer("id"); t.text("videoRatio"); });
  await db.schema.createTable("o_videoTrack", t => {
    t.integer("id"); t.integer("projectId"); t.integer("scriptId"); t.text("prompt"); t.text("state"); t.text("reason");
  });
  await db.schema.createTable("o_assets", t => {
    for (const name of ["id", "projectId", "assetsId", "imageId"]) t.integer(name);
    for (const name of ["type", "name", "prompt", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath", "referenceLayout"]) t.text(name);
  });
  await db.schema.createTable("o_image", t => { t.integer("id"); t.text("filePath"); t.text("type"); });
  await db.schema.createTable("o_storyboard", t => { t.integer("id"); t.integer("projectId"); t.text("filePath"); t.text("prompt"); });
  await db.schema.createTable("o_video", t => {
    t.increments("id");
    for (const name of ["projectId", "scriptId", "videoTrackId"]) t.integer(name);
    t.bigInteger("time");
    for (const name of ["filePath", "state", "errorReason"]) t.text(name);
  });
  await db("o_project").insert({ id: 7, videoRatio: "16:9" });
  await db("o_videoTrack").insert([1, 2].map(id => ({ id, projectId: 7, scriptId: 2, prompt: "old", state: "已完成" })));
  const submitted: any[] = [], loaded: string[] = [], legacyCalls: string[] = [];
  const unreadable = new Set<string>();
  let providerCreations = 0;
  const u = {
    db, error: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    oss: { getImageBase64: async (path: string) => {
      loaded.push(path);
      if (unreadable.has(path)) throw new Error("无法读取参考图：" + path);
      return "data:image/png;base64," + Buffer.from(path).toString("base64");
    } },
    Ai: { Video: () => { providerCreations++; return { run: async (request: any) => { submitted.push(request); }, save: async () => {} }; } },
  };
  const app = express(); app.use(express.json());
  for (const name of ["generateVideo", "batchGenerateVideo"]) {
    const imports: Record<string, unknown> = {
      "@/utils": u, "@/utils/db": { db },
      "@/utils/videoLanguages": { dialogueLanguageSchema: z.string(), resolveLanguagePrompt: async (_db: unknown, _id: number, _language: unknown, prompt: string) => prompt },
      "@/utils/h3ReferencePlan": referencePlans,
      "@/utils/h3ReferenceBindings": referenceBindings,
      "@/utils/assetReferenceMedia": { persistedRoleReferencesForVideo: (item: any, prompt: string) => { legacyCalls.push(prompt); throw new Error("Retired crop path invoked"); } },
      "@/utils/h3VisualStateGuard": guards,
      "@/utils/videoQuality": { inspectVideoQuality: async () => ({}) },
      "@/middleware/middleware": { validateFields },
      "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string, data: unknown = null) => ({ message, data }) },
    };
    const code = transform(readFileSync("src/routes/production/workbench/" + name + ".ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
    const mod = { exports: {} as any };
    new Function("require", "module", "exports", code)((id: string) => imports[id] || requireModule(id), mod, mod.exports);
    app.use("/" + name, mod.exports.default);
  }
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const baseUrl = "http://127.0.0.1:" + (server.address() as any).port;
  return {
    db, submitted, loaded, legacyCalls, unreadable, providerCreations: () => providerCreations,
    addAssets: async (assets: ReturnType<typeof asset>[]) => {
      await db("o_assets").insert(assets);
      await db("o_image").insert(assets.map(item => ({ id: item.id, filePath: item.id + "-sheet.png", type: item.type === "audio" || item.type === "video" ? item.type : "image" })));
    },
    post: async (route: string, tracks: { trackId: number; prompt: string; uploadData: any[]; language?: string }[], options: Record<string, unknown> = {}) => {
      const body = route === "generateVideo" ? { ...settings, ...tracks[0], duration: 5, ...options }
        : { ...settings, trackData: tracks.map(track => ({ ...track, duration: 5 })), ...options };
      const response = await fetch(baseUrl + "/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    },
    done: async () => {
      for (let attempt = 0; attempt < 100 && (await db("o_video").where({ state: "生成中" })).length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); },
  };
}

async function snapshotDatabase(db: any) {
  const schema = await db("sqlite_master").where({ type: "table" }).orderBy("name").select("name", "sql");
  const tables: Record<string, unknown> = {};
  for (const table of schema) tables[table.name] = await db(table.name).select("*").orderByRaw("rowid");
  return { schema, tables };
}

for (const route of ["generateVideo", "batchGenerateVideo"]) {
  test(route + " uploads saved whole-board order despite side/back prose and shuffled selected assets", async () => {
    const f = await fixture();
    try {
      await f.addAssets([asset(1), asset(2), asset(3), asset(4, "scene"), asset(5, "tool"), asset(6, "tool"), asset(7, "tool")]);
      const plan = { version: 1 as const, slots: [
        planSlot(1, "role"), planSlot(2, "role"), planSlot(3, "role"),
        planSlot(4, "scene"), planSlot(5, "tool"), planSlot(6, "tool"), planSlot(7, "tool"),
      ] };
      const prompt = picturePrompt(7) + " Camera sees a side view and back view of the shopping cart.";
      await savePlan(f.db, 1, prompt, plan);
      const response = await f.post(route, [{ trackId: 1, prompt, uploadData: [7, 3, 2, 6, 4, 1, 5].map(id => ({ id, sources: "assets" })) }]);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      await f.done();
      assert.equal(f.legacyCalls.length, 0);
      assert.deepEqual(f.loaded, plan.slots.map(slot => slot.path));
      assert.deepEqual(f.submitted[0].referenceList.map((item: any) => Buffer.from(item.base64.split(",")[1], "base64").toString()), plan.slots.map(slot => slot.path));
      assert.equal(f.submitted[0].referenceList.length, 7);
    } finally { await f.done(); await f.close(); }
  });

  test(route + " counts only picture slots and preserves separately selected audio and video", async () => {
    const f = await fixture();
    try {
      await f.addAssets([asset(1), asset(2, "scene"), asset(3, "audio"), asset(4, "video")]);
      await f.db("o_storyboard").insert({ id: 8, projectId: 7, filePath: "storyboard.png", prompt: "composition" });
      const plan = { version: 1 as const, slots: [planSlot(1, "role"), planSlot(2, "scene")] };
      const prompt = picturePrompt(2);
      await savePlan(f.db, 1, prompt, plan);
      const response = await f.post(route, [{ trackId: 1, prompt, uploadData: [
        { id: 3, sources: "assets", type: "audioReference" }, { id: 1, sources: "assets" },
        { id: 4, sources: "assets", fileType: "video" }, { id: 2, sources: "assets" }, { id: 8, sources: "storyboard" },
      ] }]);
      assert.equal(response.status, 200, JSON.stringify(response.body)); await f.done();
      assert.deepEqual(f.submitted[0].referenceList.map((item: any) => item.type), ["image", "image", "audio", "video"]);
      assert.deepEqual(f.loaded, ["1-sheet.png", "2-sheet.png", "3-sheet.png", "4-sheet.png"]);
    } finally { await f.done(); await f.close(); }
  });

  for (const failure of ["changed board", "changed selection", "unreadable image", "legacy missing plan"]) {
    test(route + " fails preflight for " + failure + " with a persisted reason and no video attempt", async () => {
      const f = await fixture();
      try {
        await f.addAssets([asset(1), asset(2, "scene")]);
        const prompt = failure === "legacy missing plan" ? picturePrompt(3) + " side view" : picturePrompt(1);
        const uploadData = [{ id: 1, sources: "assets" }];
        if (failure !== "legacy missing plan") {
          await savePlan(f.db, 1, prompt, { version: 1, slots: [planSlot(1, "role")] });
        }
        if (failure === "changed board") await f.db("o_image").where({ id: 1 }).update({ filePath: "replacement-sheet.png" });
        if (failure === "changed selection") uploadData.push({ id: 2, sources: "assets" });
        if (failure === "unreadable image") f.unreadable.add("1-sheet.png");
        if (failure === "legacy missing plan") await f.db("o_assets").where({ id: 1 }).update({ sideReferencePath: null });
        const response = await f.post(route, [{ trackId: 1, prompt, uploadData }]);
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.match(response.body.message, /参考|图片|资产|重新生成/);
        const track = await f.db("o_videoTrack").where({ id: 1 }).first();
        assert.equal(track.state, "生成失败"); assert.ok(track.reason);
        assert.equal((await f.db("o_video")).length, 0); assert.equal(f.submitted.length, 0);
      } finally { await f.close(); }
    });
  }

  test(route + " rejects unplanned historical prompts instead of scanning profile/from-behind prose", async () => {
    const f = await fixture();
    try {
      await f.addAssets([asset(1), asset(2, "scene")]);
      const prompt = picturePrompt(5) + " profile and from behind; side view and back view";
      const response = await f.post(route, [{ trackId: 1, prompt, uploadData: [{ id: 2, sources: "assets" }, { id: 1, sources: "assets" }] }]);
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.match(response.body.message, /该视频段使用旧版参考图规则，请重新生成视频提示词后再生成视频/);
      assert.deepEqual(f.legacyCalls, []); assert.deepEqual(f.loaded, []);
      assert.equal(f.providerCreations(), 0); assert.equal((await f.db("o_video")).length, 0);
    } finally { await f.done(); await f.close(); }
  });
}

test("batch preflights every image before creating any video record", async () => {
  const f = await fixture();
  try {
    await f.addAssets([asset(1), asset(2)]);
    const prompt = picturePrompt(1);
    await savePlan(f.db, 1, prompt, { version: 1, slots: [planSlot(1, "role")] });
    await savePlan(f.db, 2, prompt, { version: 1, slots: [planSlot(2, "role")] });
    f.unreadable.add("2-sheet.png");
    const response = await f.post("batchGenerateVideo", [1, 2].map(id => ({ trackId: id, prompt, uploadData: [{ id, sources: "assets" }] })));
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal((await f.db("o_video")).length, 0); assert.equal(f.submitted.length, 0);
    assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).state, "生成失败");
  } finally { await f.close(); }
});

for (const route of ["generateVideo", "batchGenerateVideo"]) {
  test(route + " validateOnly loads the same saved pictures without changing any table or creating a provider", async () => {
    const f = await fixture();
    try {
      await f.addAssets([asset(1), asset(2, "scene")]);
      const prompt = picturePrompt(2) + " profile and from behind";
      await savePlan(f.db, 1, prompt, { version: 1, slots: [planSlot(1, "role"), planSlot(2, "scene")] });
      const before = await snapshotDatabase(f.db);
      const response = await f.post(route, [{ trackId: 1, language: "en-US", prompt, uploadData: [{ id: 2, sources: "assets" }, { id: 1, sources: "assets" }] }], { validateOnly: true });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.data, { valid: true, tracks: [{ trackId: 1, language: "en-US", valid: true, pictureCount: 2, referenceCount: 2 }] });
      assert.deepEqual(f.loaded, ["1-sheet.png", "2-sheet.png"]);
      assert.deepEqual(await snapshotDatabase(f.db), before);
      assert.equal(f.providerCreations(), 0); assert.equal(f.submitted.length, 0);
    } finally { await f.close(); }
  });

  test(route + " validateOnly failure neither changes legacy state nor creates the plan table", async () => {
    const f = await fixture();
    try {
      await f.addAssets([asset(1)]);
      const before = await snapshotDatabase(f.db);
      const response = await f.post(route, [{ trackId: 1, prompt: picturePrompt(2) + " profile from behind", uploadData: [{ id: 1, sources: "assets" }] }], { validateOnly: true });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.data.valid, false); assert.equal(response.body.data.tracks.length, 1);
      assert.equal(response.body.data.tracks[0].trackId, 1); assert.equal(response.body.data.tracks[0].valid, false);
      assert.match(response.body.data.tracks[0].reason, /旧版参考图规则/);
      assert.deepEqual(await snapshotDatabase(f.db), before);
      assert.equal(await f.db.schema.hasTable("o_h3ReferencePlan"), false);
      assert.equal(f.providerCreations(), 0); assert.deepEqual(f.loaded, []);
    } finally { await f.close(); }
  });

  test(route + " still permits reference-free text generation and validates zero Picture tags", async () => {
    const f = await fixture();
    try {
      const success = await f.post(route, [{ trackId: 1, prompt: "A ship sails at sunset.", uploadData: [] }], { validateOnly: true, mode: "text" });
      assert.equal(success.status, 200, JSON.stringify(success.body)); assert.equal(success.body.data.tracks[0].pictureCount, 0);
      const invalid = await f.post(route, [{ trackId: 1, prompt: "A ship from <Picture 1> sails.", uploadData: [] }], { validateOnly: true, mode: "text" });
      assert.equal(invalid.status, 409, JSON.stringify(invalid.body)); assert.match(invalid.body.message, /没有上传/);
      assert.equal(await f.db.schema.hasTable("o_h3ReferencePlan"), false); assert.equal(f.providerCreations(), 0);
    } finally { await f.close(); }
  });
}

test("validateOnly reports all 23 tracks, including every failure, without modifying any table or invoking a provider", async () => {
  const f = await fixture();
  try {
    await f.db("o_videoTrack").insert(Array.from({ length: 21 }, (_, index) => ({ id: index + 3, projectId: 7, scriptId: 2, prompt: "keep persisted prompt", state: "已完成", reason: "keep reason" })));
    await f.addAssets(Array.from({ length: 23 }, (_, index) => asset(index + 1)));
    const prompt = picturePrompt(1);
    for (let id = 1; id <= 22; id++) await savePlan(f.db, id, id === 22 ? "<Picture 2>" : prompt, { version: 1, slots: [planSlot(id, "role")] });
    f.unreadable.add("20-sheet.png");
    await f.db("o_image").where({ id: 21 }).update({ filePath: "changed-sheet.png" });
    const before = await snapshotDatabase(f.db);
    const mutations: string[] = [];
    f.db.on("query", query => { if (/^\s*(?:insert|update|delete|create|alter|drop|replace)\b/i.test(query.sql)) mutations.push(query.sql); });
    const response = await f.post("batchGenerateVideo", Array.from({ length: 23 }, (_, index) => ({
      trackId: index + 1, prompt: index === 21 ? "<Picture 2>" : prompt, uploadData: [{ id: index + 1, sources: "assets" }],
    })), { validateOnly: true });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.data.valid, false); assert.equal(response.body.data.tracks.length, 23);
    assert.deepEqual(response.body.data.tracks.map((track: any) => track.trackId), Array.from({ length: 23 }, (_, index) => index + 1));
    assert.deepEqual(response.body.data.tracks.filter((track: any) => !track.valid).map((track: any) => track.trackId), [20, 21, 22, 23]);
    assert.match(response.body.data.tracks[19].reason, /无法读取参考图/);
    assert.match(response.body.data.tracks[20].reason, /参考图片已变化/);
    assert.match(response.body.data.tracks[21].reason, /槽位/);
    assert.match(response.body.data.tracks[22].reason, /旧版参考图规则/);
    assert.ok(response.body.data.tracks.slice(0, 19).every((track: any) => track.valid && track.pictureCount === 1));
    assert.deepEqual(mutations, []); assert.deepEqual(await snapshotDatabase(f.db), before);
    assert.equal(f.providerCreations(), 0); assert.equal(f.submitted.length, 0);
  } finally { await f.close(); }
});

for (const route of ["generateVideo", "batchGenerateVideo"]) {
  for (const validateOnly of [false,true]) {
    test(route+" rejects old crop plans without uploading or creating videos", async()=>{
      const f=await fixture();
      try {
        await f.addAssets([asset(1)]);
        const prompt=picturePrompt(2,[1,1]);
        const slots=[planSlot(1,'role','FACE'),planSlot(1,'role','FULL_BODY_FRONT')];
        await savePlan(f.db,1,prompt,{version:1,slots});
        const before=await snapshotDatabase(f.db);
        const response=await f.post(route,[{trackId:1,prompt,uploadData:[{id:1,sources:'assets'}]}],{validateOnly});
        assert.equal(response.status,409);
        assert.match(response.body.message,/人物独立视图.*重新生成视频提示词/);
        assert.deepEqual(f.loaded,[]); assert.equal(f.providerCreations(),0);
        assert.equal((await f.db('o_video')).length,0);
        if(validateOnly) assert.deepEqual(await snapshotDatabase(f.db),before);
      } finally {await f.close();}
    });
    test(route+" rejects mixing character boards into one Subject",async()=>{
      const f=await fixture();
      try {
        await f.addAssets([asset(1),asset(2)]);
        const prompt=picturePrompt(2,[1,1]);
        await savePlan(f.db,1,prompt,{version:1,slots:[planSlot(1,'role'),planSlot(2,'role')]});
        const response=await f.post(route,[{trackId:1,prompt,uploadData:[{id:1,sources:'assets'},{id:2,sources:'assets'}]}],{validateOnly});
        assert.equal(response.status,409); assert.match(response.body.message,/混用了不同资产/);
        assert.deepEqual(f.loaded,[]); assert.equal(f.providerCreations(),0);
      } finally {await f.close();}
    });
  }
}
