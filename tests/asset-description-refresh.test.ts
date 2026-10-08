import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions, promptIsStale, imageIsStale, requireCurrentAssetPrompt, saveGeneratedAssetPrompt, saveDescription } from "../src/utils/assetDescriptionVersion";
import { loadAssetPromptContext, generateAssetPrompt } from "../src/utils/assetPromptGeneration";

async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_assets", t => { t.increments("id"); t.integer("projectId"); t.integer("assetsId"); t.integer("imageId"); t.bigInteger("startTime");
    for (const k of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) t.text(k); });
  await db.schema.createTable("o_script", t => { t.integer("id"); t.integer("projectId"); t.text("name"); t.text("content"); t.integer("extractState"); t.text("errorReason"); });
  await db.schema.createTable("o_scriptAssets", t => { t.integer("scriptId"); t.integer("assetId"); });
  await db.schema.createTable("o_image", t => { t.increments("id"); t.integer("assetsId"); t.text("filePath"); });
  await migrateAssetDescriptions(db);
  await db("o_assets").insert([
    { id: 10, projectId: 1, name: "艾娃", type: "role", describe: "旧脸型与旧发型", prompt: "旧提示词", imageId: 4 },
    { id: 11, projectId: 1, assetsId: 10, name: "艾娃觉醒", type: "role", describe: "觉醒红眼", imageId: 5 },
    { id: 12, projectId: 2, name: "艾娃", type: "role", describe: "其他项目" },
  ]);
  await db("o_script").insert([
    { id: 1, projectId: 1, name: "第一集", content: "艾娃黑发黑眼。", extractState: 1 },
    { id: 2, projectId: 1, name: "第二集", content: "艾娃性格坚毅。", extractState: 1 },
    { id: 3, projectId: 1, name: "第三集", content: "艾娃眼角有泪痣。", extractState: 1 },
    { id: 4, projectId: 2, name: "其他项目", content: "外部资料", extractState: 1 },
  ]);
  await db("o_scriptAssets").insert([{ scriptId: 1, assetId: 10 }, { scriptId: 3, assetId: 10 }]);
  await db("o_image").insert({ id: 4, assetsId: 10, filePath: "old.png" });
  return db;
}
const design = (overrides: any = {}) => ({ describe: "黑发黑眼，眼角泪痣，清晰下颌，层次长发，修长体型，收腰上衣。",
  visualDesign: { face: "清晰下颌", body: "修长体型", hair: "层次长发", clothing: "收腰上衣", environment: "", shape: "" },
  scriptFacts: [{ sourceRef: "3:1", fact: "眼角有泪痣" }], conflicts: [], ...overrides });
const ref = (id: number, scriptIds: number[]) => ({ newAssets: [], existingAssetRefs: [{ assetId: id, scriptIds }] });
function model(results: any[]) {
  const calls: any[] = [];
  return { calls, invoke: async (request: any) => {
    calls.push(request);
    assert.ok(results.length, "unexpected AI invocation");
    const value = results.shift();
    if (value instanceof Error) throw value;
    const result = typeof value === "function" ? await value(request) : value;
    if (result !== null) {
      try { await request.tools.resultTool.execute(result, {}); }
      catch (error) { return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] }; }
    }
    return {};
  } };
}
const options = { projectId: 1, scriptIds: [1, 2], groupSize: 1, updateExistingDescriptions: true };

test("ordinary extraction reuses descriptions, images and IDs without invoking redesign", async t => {
  const db = await fixture(t), ai = model([ref(10, [1]), ref(10, [2])]);
  const before = await db("o_assets").where({ id: 10 }).first();
  const result = await extractScriptAssets({ db, ...ai, system: "rules" }, { ...options, updateExistingDescriptions: false });
  assert.deepEqual(await db("o_assets").where({ id: 10 }).first(), before);
  assert.equal(result.reused, 1); assert.equal(ai.calls.length, 2);
  assert.deepEqual((await db("o_scriptAssets").where({ assetId: 10 }).orderBy("scriptId")).map(r => r.scriptId), [1, 2, 3]);
});

test("refresh designs once across episodes, includes unselected linked episodes, keeps IDs/images/derivatives and versions history", async t => {
  const db = await fixture(t), ai = model([ref(10, [1]), ref(10, [2]), design()]);
  const result = await extractScriptAssets({ db, ...ai, system: "rules" }, options);
  assert.equal(result.updated, 1); assert.equal(ai.calls.length, 3);
  const evidence = JSON.parse(ai.calls[2].messages[0].content);
  assert.deepEqual(evidence.scripts.map((s: any) => s.id).sort(), [1, 2, 3]);
  const current = await db("o_assets").where({ id: 10 }).first();
  assert.equal(current.imageId, 4); assert.equal(current.prompt, "旧提示词");
  assert.equal(current.descriptionVersion, 1); assert.equal(current.promptState, "待更新");
  assert.ok(promptIsStale(current)); assert.ok(imageIsStale(current));
  assert.throws(() => requireCurrentAssetPrompt(current), /先重新生成提示词/);
  assert.equal((await db("o_assets").where({ id: 11 }).first()).describe, "觉醒红眼");
  assert.equal((await db("o_assets").where({ id: 12 }).first()).describe, "其他项目");
  assert.equal((await db("o_assetDescriptionHistory").first()).describe, "旧脸型与旧发型");
  await saveGeneratedAssetPrompt(db, current, "新提示词");
  assert.equal(promptIsStale(await db("o_assets").where({ id: 10 }).first()), false);
  assert.ok(imageIsStale(await db("o_assets").where({ id: 10 }).first()));
  const repeat = model([ref(10, [1]), ref(10, [2]), design()]);
  await extractScriptAssets({ db, ...repeat, system: "rules" }, options);
  assert.equal((await db("o_assets").where({ id: 10 }).first()).descriptionVersion, 1);
});

test("failed design or forged evidence leaves all descriptions and associations intact", async t => {
  for (const output of [new Error("provider failed"), design({ scriptFacts: [{ sourceRef: "4:1", fact: "其他项目证据" }] }), design({ conflicts: ["用户衣装与剧本冲突"] })]) {
    const db = await fixture(t), before = await db("o_assets"), links = await db("o_scriptAssets");
    const ai = model([ref(10, [1]), ref(10, [2]), output, output]);
    await assert.rejects(extractScriptAssets({ db, ...ai, system: "rules" }, options));
    assert.deepEqual(await db("o_assets"), before); assert.deepEqual(await db("o_scriptAssets"), links);
    assert.equal((await db("o_assetDescriptionHistory")).length, 0);
  }
});

test("apartment evidence is copied from numbered source spans, preserving punctuation and whitespace", async t => {
  const db = await fixture(t);
  const content = '场景二\r\n画面：末世前三天，小公寓。 窗外城市正常，新闻播报“海平面异常上升”。\r\n艾娃  坐在床上，看手机日期。';
  await db("o_script").where({ id: 1 }).update({ content });
  const ai = model([ref(10, [1]), (request: any) => {
    const scripts = JSON.parse(request.messages[0].content).scripts;
    const source = scripts.find((s: any) => s.id === 1);
    assert.equal(source.content, undefined, "send one numbered copy, not duplicated raw text");
    assert.ok(source.excerpts.every((e: any) => content.includes(e.quote)));
    const excerpt = source.excerpts.find((e: any) => e.quote.includes("海平面异常"));
    return design({ scriptFacts: [{ sourceRef: excerpt.sourceRef, fact: "公寓窗外是正常城市", quote: "模型改写的假引文", scriptId: 4 }] });
  }]);
  await extractScriptAssets({ db, ...ai, system: "rules" }, { ...options, scriptIds: [1] });
  const facts = JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts;
  assert.deepEqual(facts, [{ scriptId: 1, sourceRef: "1:3", quote: ' 窗外城市正常，新闻播报“海平面异常上升”。', fact: "公寓窗外是正常城市" }]);
});

test("invalid source reference receives bounded correction without relaxing grounding", async t => {
  const db = await fixture(t);
  const ai = model([ref(10, [1]), design({ scriptFacts: [{ sourceRef: "999:1", fact: "不存在" }] }), (request: any) => {
    assert.match(request.system, /上次结果未能保存[\s\S]*sourceRef/);
    return design();
  }]);
  await extractScriptAssets({ db, ...ai, system: "rules" }, { ...options, scriptIds: [1] });
  assert.equal(ai.calls.length, 3);
  const facts = JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts;
  assert.deepEqual(facts, [{ scriptId: 3, sourceRef: "3:1", quote: "艾娃眼角有泪痣。", fact: "眼角有泪痣" }]);
});

test("new same-name different-type asset is created once and an existing name returned as new still respects reuse mode", async t => {
  const db = await fixture(t);
  const fresh = (sid: number) => ({ newAssets: [{ name: "艾娃", type: "role", desc: "不应覆盖", scriptIds: [sid] }, { name: "艾娃", type: "scene", desc: "场景", scriptIds: [sid] }], existingAssetRefs: [] });
  const ai = model([fresh(1), fresh(2), design({ describe: "纯环境", scriptFacts: [] })]);
  const result = await extractScriptAssets({ db, ...ai, system: "rules" }, { ...options, updateExistingDescriptions: false });
  assert.equal(result.created, 1); assert.equal(result.reused, 1);
  assert.equal((await db("o_assets").where({ id: 10 }).first()).describe, "旧脸型与旧发型");
  assert.equal((await db("o_assets").where({ projectId: 1, name: "艾娃", type: "scene" })).length, 1);
});

test("out-of-scope IDs and concurrent edits cannot overwrite data", async t => {
  const db = await fixture(t);
  await assert.rejects(extractScriptAssets({ db, ...model([ref(12, [1])]), system: "rules" }, { ...options, scriptIds: [1] }), /不属于当前项目/);
  await assert.rejects(extractScriptAssets({ db, ...model([]), system: "rules" }, { ...options, scriptIds: [4] }), /不属于当前项目/);
  await assert.rejects(extractScriptAssets({ db, ...model([ref(10, [999]), ref(10, [999])]), system: "rules" }, { ...options, scriptIds: [1] }), /scriptIds/);
  const ai = model([ref(10, [1]), ref(10, [2]), async () => { await db("o_assets").where({ id: 10 }).update({ describe: "用户正在编辑" }); return design(); }]);
  await assert.rejects(extractScriptAssets({ db, ...ai, system: "rules" }, options), /提取期间资产已被修改/);
  assert.equal((await db("o_assets").where({ id: 10 }).first()).describe, "用户正在编辑");
});

test("scene numbers mistaken for script IDs retry before any design or persistence", async t => {
  const db = await fixture(t), before = await db("o_assets");
  const ai = model([ref(10, [1, 2, 3]), ref(10, [1])]);
  await extractScriptAssets({ db, ...ai, system: "rules" }, { projectId: 1, scriptIds: [1] });
  assert.equal(ai.calls.length, 2);
  assert.match(ai.calls[1].system, /scriptIds/);
  assert.deepEqual(await db("o_assets"), before);
  assert.deepEqual(await db("o_scriptAssets").where({ scriptId: 1 }), [{ scriptId: 1, assetId: 10 }]);
});

test("re-extraction drops background-role links without deleting saved assets or images", async t => {
  const db = await fixture(t);
  await db("o_assets").insert({ id: 20, projectId: 1, name: "主角的两个朋友", type: "role", describe: "错误合并的背景人物" });
  await db("o_scriptAssets").insert({ scriptId: 1, assetId: 20 });
  const before = await db("o_assets"), images = await db("o_image");
  await extractScriptAssets({ db, ...model([ref(10, [1])]), system: "rules" }, { projectId: 1, scriptIds: [1] });
  assert.deepEqual(await db("o_scriptAssets").where({ scriptId: 1 }), [{ scriptId: 1, assetId: 10 }]);
  assert.deepEqual(await db("o_assets"), before);
  assert.deepEqual(await db("o_image"), images);
  assert.deepEqual(await db("o_scriptAssets").where({ scriptId: 3 }), [{ scriptId: 3, assetId: 10 }]);
});

test("prompt writer and auditor use current database facts and explicit redesign fields, stale completion cannot overwrite a newer description", async t => {
  const db = await fixture(t), old = await db("o_assets").where({ id: 10 }).first();
  await db.transaction(trx => saveDescription(trx, old, design().describe, { visualDesign: design().visualDesign, changedFields: ["face", "hair", "clothing"] }));
  const context = await loadAssetPromptContext(db, { projectId: 1, assetsId: 10, name: "旧名称", type: "role", describe: "客户端旧描述" });
  assert.equal(context.input.describe, design().describe);
  const calls: any[] = [];
  await generateAssetPrompt({ loadImage: async () => "data:image/png;base64,aW1hZ2U=", invoke: async request => {
    calls.push(request); return { text: calls.length === 1 ? "完整四视图，新脸型、层次长发和收腰衣装。" : '{"passed":true,"issues":[]}' };
  } }, context, "3D国漫");
  for (const call of calls) assert.match(call.messages[0].content[0].text, /本次已更新资产描述[\s\S]*face[\s\S]*优先于旧图/);
  await db.transaction(trx => saveDescription(trx, context.asset, "第二版描述", {}));
  await assert.rejects(saveGeneratedAssetPrompt(db, context.asset, "第一版的迟到结果"), /资产描述已变化/);
  assert.equal((await db("o_assets").where({ id: 10 }).first()).prompt, "旧提示词");
});

test("user constraints are carried forward; historical descriptions remain unknown-source", async t => {
  const db = await fixture(t), old = await db("o_assets").where({ id: 10 }).first();
  await db.transaction(trx => saveDescription(trx, old, "用户指定蓝色上衣", { source: "user", userConstraints: "蓝色上衣" }));
  const ai = model([ref(10, [1]), ref(10, [2]), design({ describe: "黑发，蓝色上衣" })]);
  await extractScriptAssets({ db, ...ai, system: "rules" }, options);
  assert.equal(JSON.parse(ai.calls[2].messages[0].content).userConstraints, "蓝色上衣");
  assert.equal(JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).userConstraints, "蓝色上衣");
});

test("valid empty discovery completes once without forcing an asset, migrations are idempotent", async t => {
  const db = await fixture(t); await migrateAssetDescriptions(db);
  const before = await db("o_assets").select("*");
  const ai = model([{ newAssets: [], existingAssetRefs: [] }]);
  const result = await extractScriptAssets({ db, ...ai, system: "rules" }, { projectId: 1, scriptIds: [1] });
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(result, { created: 0, updated: 0, reused: 0 });
  assert.deepEqual(await db("o_assets").select("*"), before);
});

test("reported shark blood-water adaptation conflict is corrected from source before saving", async t => {
  const db = await fixture(t);
  await db("o_assets").where({ id: 10 }).update({ name: "巨鲨", type: "tool", describe: "旧巨鲨描述" });
  await db("o_script").where({ id: 1 }).update({ content: "巨鲨攻击，血染红海水。红色警示灯亮起。" });
  const fields = { face: "", hair: "", body: "", clothing: "", environment: "", shape: "灰蓝色流线型躯干，高背鳍，锯齿状利齿。" };
  const falseConflict = design({ describe: "巨鲨", visualDesign: fields, scriptFacts: [{ sourceRef: "1:1", fact: "攻击事件" }],
    conflicts: ["剧本原文写有血染红海水，但视觉资产与后续画面不得呈现红色血水；该攻击事件保留。"] });
  const corrected = { ...falseConflict, describe: "巨鲨，灰蓝色流线型躯干，高背鳍，锯齿状利齿。", conflicts: [] };
  const ai = model([ref(10, [1]), falseConflict, corrected]);
  await extractScriptAssets({ db, ...ai, system: "shared rules" }, { ...options, scriptIds: [1] });
  assert.equal(ai.calls.length, 3);
  assert.match(ai.calls[1].system, /全局内容表现约束 > 用户明确要求/);
  assert.match(ai.calls[2].system, /真实事实冲突必须保留/);
  assert.equal(ai.calls[2].messages[0].role, "user");
  const asset = await db("o_assets").where({ id: 10 }).first();
  assert.equal(asset.describe, corrected.describe);
  assert.equal(JSON.parse(asset.descriptionMeta).scriptFacts[0].quote, "巨鲨攻击，血染红海水。");
  assert.equal(asset.imageId, 4);
  assert.equal((await db("o_script").where({ id: 1 }).first()).extractState, 1);
});

test("real identity conflicts survive the single recheck and preserve the previous data", async t => {
  const db = await fixture(t), before = await db("o_assets"), links = await db("o_scriptAssets");
  const conflict = design({ conflicts: ["同一默认衣装既要求长袖蓝衬衣又要求无袖红裙，无法确定生效状态"] });
  const ai = model([ref(10, [1]), conflict, conflict]);
  await assert.rejects(extractScriptAssets({ db, ...ai, system: "rules" }, { ...options, scriptIds: [1] }), /无法确定生效状态/);
  assert.equal(ai.calls.length, 3);
  assert.deepEqual(await db("o_assets"), before);
  assert.deepEqual(await db("o_scriptAssets"), links);
});

test("malformed model results provide schema feedback on retry and name the failing asset", async t => {
  const db = await fixture(t);
  let calls = 0;
  const invoke = async (request: any) => {
    calls++;
    if (calls === 1) { await request.tools.resultTool.execute(ref(10, [1]), {}); return {}; }
    if (calls === 3) assert.match(request.system, /缺少 visualDesign\.shape/);
    return { finishReason: "tool-calls", content: [{ type: "tool-error", error: new Error("缺少 visualDesign.shape") }] };
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" }, { ...options, scriptIds: [1] }), /艾娃：AI 未返回有效的资产结果：缺少 visualDesign.shape/);
  assert.equal(calls, 3);
  assert.equal((await db("o_assets").where({ id: 10 }).first()).descriptionVersion, 0);
});

test("batch size five sends five then two scripts, not twenty-five; a derivative reference is never redesigned", async t => {
  const db = await fixture(t);
  await db("o_script").insert([5, 6, 7, 8].map(id => ({ id, projectId: 1, content: "艾娃出现。" })));
  const selected = [1, 2, 3, 5, 6, 7, 8];
  const ai = model([
    (request: any) => { const batch = JSON.parse(request.messages[0].content).scripts; assert.equal(batch.length, 5); return ref(11, batch.map((s: any) => s.id)); },
    (request: any) => { const batch = JSON.parse(request.messages[0].content).scripts; assert.equal(batch.length, 2); return ref(11, batch.map((s: any) => s.id)); },
  ]);
  await extractScriptAssets({ db, ...ai, system: "rules" }, { ...options, scriptIds: selected, groupSize: 5 });
  assert.equal(ai.calls.length, 2);
  assert.equal((await db("o_assets").where({ id: 11 }).first()).describe, "觉醒红眼");
});
