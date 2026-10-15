import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import knex from "knex";
import { transform } from "sucrase";
import * as context from "../src/agents/productionAgent/deriveAssetContext";
import * as supervisionContext from "../src/agents/productionAgent/supervisionContext";
import { TaskStore } from "../src/utils/agent/runtime/taskStore";
import { wrapAgentTools } from "../src/utils/agent/runtime/toolExecutor";

const source = "场1：雨夜甲板\n艾娃一条腿受伤。\n场2：公寓\n艾娃摸腿，双腿完整。\n末尾完整来源事实。";
const plan = "导演已确认的完整节拍与外观依据：湿衣仍沿用默认裙装；最后一场正常城市。";
const feedback = "请按原有 ID 修订。" + "完整用户审核证据，不能只传100字。".repeat(30) + "保留结尾具体反馈，禁止生成图片。";

function load(file: string, mocks: Record<string, any>, append = "") {
  const localRequire = createRequire(path.resolve("package.json")), module = { exports: {} as any };
  const code = transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code + append)((id: string) => mocks[id] ?? localRequire(id), module, module.exports);
  return module.exports;
}

type Options = { mode?: string; noChildModel?: boolean; childTokens?: number; parentTokens?: number };
async function fixture(options: Options = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_script", t => { t.integer("id"); t.integer("projectId"); t.text("content"); });
    await db.schema.createTable("o_project", t => { t.integer("id"); t.text("imageModel"); t.text("videoModel"); t.text("mode"); t.text("artStyle"); t.text("directorManual"); });
    await db.schema.createTable("o_agentWorkData", t => { t.increments("id"); t.integer("projectId"); t.integer("episodesId"); t.text("key"); t.text("data"); t.unique(["projectId", "episodesId", "key"]); });
    await db.schema.createTable("o_agentDeploy", t => { t.text("key"); t.text("modelName"); t.float("temperature"); t.integer("maxOutputTokens"); });
    await db.schema.createTable("o_setting", t => { t.text("key"); t.text("value"); });
    await db.schema.createTable("o_assets", t => { t.increments("id"); t.integer("projectId"); t.integer("assetsId"); t.integer("imageId"); t.text("name"); t.text("type"); t.text("describe"); t.text("prompt"); t.text("promptState"); t.integer("startTime"); });
    await db.schema.createTable("o_scriptAssets", t => { t.integer("scriptId"); t.integer("assetId"); });
    await db.schema.createTable("o_image", t => { t.integer("id"); t.text("state"); t.text("filePath"); t.text("errorReason"); });
    await db.schema.createTable("o_agentRun", t => { t.text("id"); t.text("agentType"); t.integer("projectId"); t.integer("episodesId"); t.text("isolationKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db.schema.createTable("o_agentStep", t => { t.text("id"); t.text("runId"); t.text("stepKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("output"); t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db.schema.createTable("o_agentToolCall", t => { t.text("id"); t.text("runId"); t.text("stepKey"); t.text("toolName"); t.text("operationKey"); t.text("inputHash"); t.text("inputJson"); t.text("outputJson"); t.integer("sideEffect"); t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db("o_script").insert({ id: 71, projectId: 1, content: source });
    await db("o_project").insert({ id: 1, imageModel: "mock:image", videoModel: "mock:video", mode: "[]", artStyle: "style", directorManual: "story" });
    await db("o_agentDeploy").insert([
      { key: "productionAgent:deriveAssetsAgent", modelName: options.noChildModel ? null : "mock:derive", temperature: 1, maxOutputTokens: options.childTokens ?? 0 },
      { key: "productionAgent", modelName: "mock:parent", temperature: 0.1, maxOutputTokens: options.parentTokens ?? 5000 },
    ]);
    await db("o_setting").insert({ key: "agentUseMode", value: options.mode ?? "1" });
    await db("o_assets").insert([
      { id: 61, projectId: 1, name: "艾娃", type: "role", describe: "默认黑裙长靴完整面容", imageId: 3, prompt: "已生成父提示词" },
      { id: 62, projectId: 1, name: "另一个本集场景", type: "scene", describe: "固定空间" },
      { id: 63, projectId: 1, assetsId: 61, name: "湿衣旧稿", type: "role", describe: "错误旧描述", imageId: 4, prompt: "已有衍生提示词", promptState: "已完成" },
      { id: 64, projectId: 1, assetsId: 61, name: "其他集状态", type: "role", describe: "其他集秘密" },
      { id: 65, projectId: 2, name: "其他项目角色", type: "role", describe: "跨项目内容" },
    ]);
    await db("o_scriptAssets").insert([{ scriptId: 71, assetId: 61 }, { scriptId: 71, assetId: 62 }, { scriptId: 71, assetId: 63 }, { scriptId: 72, assetId: 64 }, { scriptId: 71, assetId: 65 }]);
    await db("o_image").insert([{ id: 3, state: "已完成", filePath: "parent.png", errorReason: "" }, { id: 4, state: "已完成", filePath: "derived.png", errorReason: "" }]);
    await db("o_agentWorkData").insert({ projectId: 1, episodesId: 71, key: "productionAgent", data: JSON.stringify({ scriptPlan: plan, assets: [{ id: 999, desc: "workspace stale" }] }) });
    const calls = { streams: [] as any[], modelKeys: [] as string[], socket: [] as string[], skillPaths: [] as string[] };
    const textStream = () => ({ append() { return this; }, appendText() { return this; }, updateTitle() { return this; }, complete() { return this; }, error() { return this; } });
    const message = () => ({ id: "message", datetime: new Date().toISOString(), text: textStream, thinking: textStream, complete() {}, error() {} });
    const resTool = { data: { projectId: 1, scriptId: 71 }, socket: { emit: (name: string, _payload: any, ack: any) => {
      calls.socket.push(name);
      if (name === "getFlowData") ack({ assets: [{ id: 999, desc: "浏览器陈旧缓存" }], storyboard: [{ id: 9 }] });
      else ack?.({ success: true });
    } }, newMessage: message };
    const u = { db, error: (error: any) => error, getPath: (parts: string | string[]) => path.resolve("data", ...[parts].flat()), vendor: { getModelList: async () => [{ modelName: "video" }] },
      Ai: { Text: (key: string) => { calls.modelKeys.push(key); return { stream: async (input: any) => {
        calls.streams.push(input);
        return { fullStream: (async function* () { yield { type: "text-delta", text: "仅分析，现有图保留。" }; yield { type: "finish" }; })() };
      } }; } } };
    const useTools = load("src/agents/productionAgent/tools.ts", { "@/utils": u, "@/socket/resTool": {}, "./deriveAssetContext": context, "./storyboardProgress": {} }).default;
    class Memory { async add() {} }
    class RuntimeTaskStore extends TaskStore {
      async readSkill(_run: string, skillPath: string) { calls.skillPaths.push(skillPath); return skillPath.endsWith("asset_visual_design.md") ? "完整共同视觉设计Skill" : "衍生执行Skill"; }
    }
    const api = load("src/agents/productionAgent/index.ts", {
      "@/utils": u, "@/utils/agent/memory": Memory, "@/socket/resTool": {},
      "@/utils/agent/skillsTools": { scanSkills: async () => [], buildSkillPrompt: () => "艺术资料目录", createSkillTools: () => ({ activate_skill: { execute: async () => ({ content: "skill" }) }, read_skill_file: { execute: async () => ({ content: "skill" }) }, generate_storyboard: { execute: async () => { throw new Error("must not expose media tool"); } } }) },
      "@/agents/productionAgent/tools": useTools, "@/utils/agent/runtime/taskStore": { TaskStore: RuntimeTaskStore }, "@/utils/agent/runtime/toolExecutor": { wrapAgentTools },
      "./deriveAssetContext": context, "./directorPlan": {}, "./directorPlanContext": {}, "./directorPlanQuality": {}, "./screenplay": {},
      "./supervisionContext": supervisionContext,
      "./storyboardContext": {}, "./storyboardProgress": {}, "./storyboardTaskRunner": {}, "./storyboardValidator": {}, "./storyboardTable": {},
      "./storyboardRebuildDispatch": {}, "./storyboardRevisionTool": { createStoryboardRevisionTool: () => ({}) }, "@/utils/agent/contextManager": {},
    }, "\nexports.createSubAgentForTest = createSubAgent;");
    const store = new TaskStore(db);
    await store.begin({ requestId: "derive_runtime_01", agentType: "productionAgent", projectId: 1, episodesId: 71, isolationKey: "1:productionAgent:71", content: feedback });
    const agents = await api.createSubAgentForTest({ runId: "derive_runtime_01", text: feedback, isolationKey: "1:productionAgent:71", resTool, msg: message(), thinkConfig: { think: false, thinlLevel: 0 } });
    return { db, calls, tools: useTools({ resTool, msg: message() }), execute: () => agents.run_sub_agent_derive_assets.execute({ prompt: "精简父任务" }) };
  } catch (error) { await db.destroy(); throw error; }
}

test("衍生执行完整注入来源、当前导演规划、真实父子资产及未压缩用户反馈，严格限制工具和有效模型参数", async () => {
  const f = await fixture();
  try {
    await f.execute();
    const input = f.calls.streams[0], evidence = input.messages[1].content;
    assert.ok(evidence.includes(source)); assert.ok(evidence.includes(plan)); assert.ok(evidence.includes(feedback));
    assert.match(evidence, /默认黑裙长靴完整面容|错误旧描述/); assert.match(evidence, /"id": 63/); assert.match(evidence, /"imageId": 4/);
    assert.match(evidence, /完整共同视觉设计Skill/); assert.doesNotMatch(evidence, /其他集秘密|跨项目内容|workspace stale|浏览器陈旧缓存/);
    assert.deepEqual(Object.keys(input.tools).sort(), ["activate_skill", "add_deriveAsset", "get_flowData", "read_skill_file"]);
    assert.equal(input.temperature, 0.3); assert.equal(input.maxOutputTokens, 12000);
    assert.deepEqual(f.calls.modelKeys, ["productionAgent:deriveAssetsAgent"]);
    const step = await f.db("o_agentStep").first();
    assert.equal(step.status, "completed"); assert.ok(JSON.parse(step.inputContent).messages[1].content.includes(feedback));
    assert.equal((await f.db("o_assets").where({ id: 63 }).first()).imageId, 4);
  } finally { await f.db.destroy(); }
});

test("资产读取绕过浏览器并保持分页/图片状态；写后立即读到新描述，同请求回执与已有图及提示词保留", async () => {
  const f = await fixture();
  try {
    const first = await f.tools.get_flowData.execute({ key: "assets" });
    assert.equal(first[0].derive[0].desc, "错误旧描述"); assert.equal(first[0].derive[0].state, "已完成"); assert.equal(first[0].derive[0].imageAvailable, true);
    assert.equal(first[0].derive.length, 1); assert.equal(first.length, 2);
    const payload = { assetsId: 61, id: 63, name: "雨夜湿衣", desc: "继承黑裙长靴，衣发湿透；本场启用。", requestId: "derive-revision-001" };
    const written = await f.tools.add_deriveAsset.execute(payload); assert.equal(written.id, 63); assert.equal(written.reused, false);
    const next = await f.tools.get_flowData.execute({ key: "assets" }); assert.equal(next[0].derive[0].desc, payload.desc); assert.equal(next[0].derive[0].name, payload.name);
    const page = await f.tools.get_flowData.execute({ key: "assets", offset: 0, limit: 1 });
    assert.deepEqual(page.data, [next[0]]); assert.equal(page.total, 2); assert.equal(page.nextOffset, 1);
    const reused = await f.tools.add_deriveAsset.execute(payload); assert.equal(reused.reused, true);
    await assert.rejects(() => f.tools.add_deriveAsset.execute({ ...payload, desc: "新的不同内容" }), (error: any) => {
      assert.match(error.message, /相同 requestId 对应不同/); assert.match(error.message, /先读取 assets 核对当前值/); assert.match(error.message, /省略旧 requestId/);
      assert.doesNotMatch(error.message, /请复用 requestId=/); return true;
    });
    const saved = await f.db("o_assets").where({ id: 63 }).first(); assert.equal(saved.describe, payload.desc); assert.equal(saved.imageId, 4); assert.equal(saved.prompt, "已有衍生提示词"); assert.equal(saved.promptState, "已完成");
    assert.equal(await f.db("o_agentWorkData").where({ key: "deriveAssetWrite:derive-revision-001" }).count("id as total").first().then(v => v?.total), 1);
    assert.ok(!f.calls.socket.includes("getFlowData")); assert.deepEqual(f.calls.socket, ["addDeriveAsset", "addDeriveAsset"]);
    assert.deepEqual(await f.tools.get_flowData.execute({ key: "storyboard" }), [{ id: 9 }]); // Existing Socket fallback remains compatible.
    const media = await f.tools.generate_deriveAsset.execute({ ids: [63], requestId: "media-request-001" });
    assert.equal(media.success, true); assert.ok(f.calls.socket.includes("generateDeriveAsset"));
  } finally { await f.db.destroy(); }
});

test("简易与fallback额度来自有效父配置；合法专用额度保留，不更改模型路由", async () => {
  for (const options of [{ mode: "0" }, { mode: "unset", noChildModel: true }, { childTokens: 6000 }]) {
    const f = await fixture(options);
    try {
      await f.execute(); const input = f.calls.streams[0];
      assert.equal(input.maxOutputTokens, options.childTokens ? 6000 : 5000); assert.equal(input.temperature, options.childTokens ? 0.3 : 0.1);
      assert.deepEqual(f.calls.modelKeys, ["productionAgent:deriveAssetsAgent"]);
    } finally { await f.db.destroy(); }
  }
});

test("只关联衍生时补读真实父资产、错误项目拒绝、无图表安全只读，并生成版本证据", async () => {
  const f = await fixture();
  try {
    await f.db("o_scriptAssets").where({ scriptId: 71, assetId: 61 }).del();
    const assets = await context.readCurrentEpisodeAssets(f.db, 1, 71);
    assert.equal(assets[0].id, 61); assert.equal(assets[0].derive[0].id, 63);
    await assert.rejects(() => context.readCurrentEpisodeAssets(f.db, 2, 71), /不存在该集剧本/);
    await f.db.schema.dropTable("o_image");
    assert.equal((await context.readCurrentEpisodeAssets(f.db, 1, 71))[0].imageAvailable, false);
    const before = context.buildDeriveAssetContext(source, plan, assets, feedback);
    const after = context.buildDeriveAssetContext(source + "新事实", plan, assets, feedback);
    assert.match(before, /sourceVersion.*[a-f0-9]{64}/); assert.notEqual(before, after);
    assert.equal(context.deriveAssetTemperature(NaN), 0.3); assert.equal(context.deriveAssetOutputTokenLimit(0), 12000);
  } finally { await f.db.destroy(); }
});
