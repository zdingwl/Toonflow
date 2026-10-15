import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import knex from "knex";
import { transform } from "sucrase";
import * as supervision from "../src/agents/productionAgent/supervisionContext";
import { TaskStore as PersistentTaskStore } from "../src/utils/agent/runtime/taskStore";

const source = "场1：房间（0–8秒）\n甲：『你好。』";
const plan = "已确认导演完整原文\n| 场次 | 制作预算（秒） |\n| Sc1 | 8 |\n#### Sc1：房间\n| B1 | 0–8 | 你好 | 选择 | 原始承载 | 保持状态 |";
const table = `## 场1：房间 ｜ 参演角色：甲
### 片段一（约8s）
**引用资产ID**：[2, 3]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 甲在房间里看向门口，保持当前湿衣状态 | 8 | 近景 | 固定 | 甲：『你好。』 | 门外脚步 |`;
const human = "完整人类反馈：先核实原文、每行首次出现窗口和已确认节拍，勿凭派发摘要继续生成。";

async function fixture(options: { mode?: string; badTable?: boolean; mutation?: boolean; report?: string; persistedRun?: boolean; cacheMutation?: boolean; invalidationRace?: boolean } = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_script", t => { t.integer("id"); t.integer("projectId"); t.text("content"); });
    await db.schema.createTable("o_agentWorkData", t => { t.integer("projectId"); t.integer("episodesId"); t.text("key"); t.text("data"); });
    await db.schema.createTable("o_assets", t => { t.integer("id"); t.integer("projectId"); t.integer("assetsId"); t.integer("imageId"); for (const field of ["name", "type", "describe"]) t.text(field); });
    await db.schema.createTable("o_scriptAssets", t => { t.integer("scriptId"); t.integer("assetId"); });
    await db.schema.createTable("o_image", t => { t.integer("id"); for (const field of ["state", "filePath", "errorReason"]) t.text(field); });
    await db.schema.createTable("o_project", t => { t.integer("id"); for (const field of ["imageModel", "videoModel", "mode", "artStyle", "directorManual"]) t.text(field); });
    await db.schema.createTable("o_agentDeploy", t => { t.text("key"); t.text("modelName"); t.float("temperature"); t.integer("maxOutputTokens"); });
    await db.schema.createTable("o_setting", t => { t.text("key"); t.text("value"); });
    await db.schema.createTable("o_agentRun", t => { t.text("id"); t.text("agentType"); t.integer("projectId"); t.integer("episodesId"); t.text("isolationKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db.schema.createTable("o_agentStep", t => { t.text("id"); t.text("runId"); t.text("stepKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("output"); t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db.schema.createTable("o_agentToolCall", t => { t.text("id"); t.text("runId"); t.text("stepKey"); t.text("toolName"); t.text("inputJson"); t.text("outputJson"); t.integer("sideEffect"); t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db("o_script").insert({ id: 7, projectId: 1, content: source });
    const original = { scriptPlan: plan, storyboardTable: options.badTable ? table.replace("| 8 |", "| 4 |") : table,
      storyboardTableProgress: { taskId: "task_review_123", revision: 4, total: 1 }, assets: [{ desc: "错误浏览器缓存不得读入" }], workbench: { videoList: [{ id: 99 }] } };
    await db("o_agentWorkData").insert({ projectId: 1, episodesId: 7, key: "productionAgent", data: JSON.stringify(original) });
    await db("o_assets").insert([
      { id: 1, projectId: 1, name: "甲", type: "role", describe: "父资产完整真实描述", imageId: 10 },
      { id: 2, projectId: 1, assetsId: 1, name: "甲湿衣", type: "role", describe: "真实湿衣状态，仍继承原衣装" },
      { id: 3, projectId: 1, name: "房间", type: "scene", describe: "真实空间结构" },
      { id: 4, projectId: 1, assetsId: 1, name: "其他集状态", type: "role", describe: "不属于本集" },
    ]);
    await db("o_scriptAssets").insert([1, 2, 3].map(assetId => ({ scriptId: 7, assetId })));
    await db("o_image").insert({ id: 10, state: "已完成", filePath: "paid.png", errorReason: "" });
    await db("o_project").insert({ id: 1, imageModel: "mock:image", videoModel: "mock:video", mode: "[]", artStyle: "selected_art", directorManual: "selected_story" });
    await db("o_agentDeploy").insert([
      { key: "productionAgent:supervisionAgent", modelName: "mock:child", temperature: 1, maxOutputTokens: 0 },
      { key: "productionAgent", modelName: "mock:parent", temperature: 0.1, maxOutputTokens: 7000 },
    ]);
    await db("o_setting").insert({ key: "agentUseMode", value: options.mode ?? "1" });
    const store = new PersistentTaskStore(db);
    const scope = { agentType: "productionAgent" as const, projectId: 1, episodesId: 7, isolationKey: "1:productionAgent:7" };
    const runId = options.persistedRun ? (await store.begin({ requestId: "supervision_run_01", ...scope, content: human })).id : undefined;
    const calls: { inputs: any[]; selections: any[]; writes: number; memory: { key: string; content: string }[]; messages: { name: string; completed: boolean; errors: string[] }[] } = {
      inputs: [], selections: [], writes: 0, memory: [], messages: [],
    };
    const stream = () => ({ append() { return this; }, complete() { return this; }, error() { return this; } });
    const message = (name = "视频策划") => {
      const state = { name, completed: false, errors: [] as string[] }; calls.messages.push(state);
      return { id: `message_${calls.messages.length}`, datetime: new Date().toISOString(), text: stream,
        complete() { state.completed = true; }, error(reason: string) { state.errors.push(reason); } };
    };
    class Memory { async add(key: string, content: string) { calls.memory.push({ key, content }); } }
    class RuntimeTaskStore extends PersistentTaskStore {
      async readSkill(_runId: string, filePath: string) { return readFileSync(filePath, "utf8"); }
      async beginStep(runId: string, stepKey: string, inputContent: string) {
        const prior = await super.beginStep(runId, stepKey, inputContent);
        if (prior.cached && options.cacheMutation) {
          await db("o_agentWorkData").where({ projectId: 1, episodesId: 7, key: "productionAgent" })
            .update({ data: JSON.stringify({ ...original, storyboardTable: original.storyboardTable + "\n人工新稿" }) });
        }
        return prior;
      }
      async invalidateCompletedStep(runId: string, stepKey: string, expectedOutput: string | undefined, error: string) {
        if (options.invalidationRace) {
          await db("o_agentStep").where({ runId, stepKey, status: "completed" }).update({ output: "并发替换的新缓存" });
        }
        return super.invalidateCompletedStep(runId, stepKey, expectedOutput, error);
      }
    }
    const u = {
      db, error: (error: unknown) => error, getPath: (parts: string | string[]) => path.resolve("data", ...[parts].flat()),
      vendor: { getModelList: async () => [{ modelName: "mock:video" }] },
      Ai: { Text: () => ({ stream: async (input: any) => {
        calls.inputs.push(input);
        if (options.mutation) await db("o_agentWorkData").update({ data: JSON.stringify({ ...original, storyboardTable: original.storyboardTable + "\n人工新稿" }) });
        return { fullStream: (async function* () {
          yield { type: "text-delta", text: options.report ?? "评分：A\n文本结论：合格\n视觉核验：尚未查看图片。" };
          yield { type: "finish" };
        })() };
      } }) },
    };
    const mocks: Record<string, any> = {
      "@/utils": u, "@/utils/agent/memory": Memory, "@/socket/resTool": {},
      "@/utils/agent/runtime/taskStore": { TaskStore: RuntimeTaskStore }, "@/utils/agent/runtime/toolExecutor": { wrapAgentTools: (tools: any) => tools },
      "@/utils/agent/skillsTools": {}, "@/utils/agent/contextManager": {},
      "@/agents/productionAgent/tools": ({ toolsNames }: any) => {
        calls.selections.push(toolsNames);
        return Object.fromEntries(["get_flowData", "get_storyboard_progress", "add_deriveAsset", "generate_storyboard"].filter(name => !toolsNames || toolsNames.includes(name))
          .map(name => [name, { execute: async () => { if (name.startsWith("add_") || name.startsWith("generate_")) calls.writes++; return {}; } }]));
      },
      "./supervisionContext": supervision, "./deriveAssetContext": {}, "./directorPlan": {}, "./directorPlanQuality": {}, "./directorPlanContext": {},
      "./screenplay": {}, "./storyboardContext": {}, "./storyboardValidator": {}, "./storyboardTable": {}, "./storyboardProgress": {}, "./storyboardTaskRunner": {},
      "./storyboardRebuildDispatch": {}, "./storyboardRevisionTool": { createStoryboardRevisionTool: () => ({}) },
    };
    const localRequire = createRequire(path.resolve("package.json"));
    const module = { exports: {} as any };
    const code = transform(readFileSync("src/agents/productionAgent/index.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
    new Function("require", "module", "exports", code + "\nexports.createSubAgentForTest = createSubAgent;")((id: string) => mocks[id] ?? localRequire(id), module, module.exports);
    const resTool = { data: { projectId: 1, scriptId: 7 }, newMessage: (_role: string, name: string) => message(name) };
    const agents = await module.exports.createSubAgentForTest({ runId, text: human, isolationKey: scope.isolationKey, resTool, msg: message(), thinkConfig: { think: false, thinlLevel: 0 } });
    return { db, original, calls, store, scope, runId, execute: () => agents.run_sub_agent_supervision.execute({ prompt: "分镜表审核" }) };
  } catch (error) { await db.destroy(); throw error; }
}

test("监督快照完整、不可变，程序诊断保留局部警告而不冒充内容验收", async () => {
  const f = await fixture();
  try {
    const before = await f.db("o_agentWorkData").first();
    const snapshot = await supervision.readSupervisionSnapshot(f.db, 1, 7);
    assert.equal(snapshot.script, source); assert.equal(snapshot.scriptPlan, plan); assert.equal(snapshot.storyboardTable, table);
    assert.equal(snapshot.assets[0].derive[0].desc, "真实湿衣状态，仍继承原衣装");
    assert.equal(snapshot.assets[0].imageAvailable, true); assert.equal(snapshot.assets[0].derive[0].imageAvailable, false);
    assert.throws(() => { snapshot.assets[0].derive[0].desc = "不能改快照"; }, TypeError);
    const prompt = supervision.buildSupervisionContext(snapshot, human, "简约派发", { artStyle: "selected_art" });
    for (const full of [source, plan, table, human, "| B1 | 0–8 |", "真实空间结构"]) assert.ok(prompt.includes(full));
    assert.doesNotMatch(prompt, /错误浏览器缓存|其他集状态/);
    for (const value of Object.values(supervision.supervisionVersions(snapshot))) assert.ok(prompt.includes(value));
    const timeline = JSON.parse(prompt.split("【程序权威逐镜时间账本：from/to/duration为本场秒数；各场从0重置，片段之间不重置】")[1]
      .split("【当前数据库本集真实父子资产")[0].trim());
    assert.deepEqual(timeline.shots.map((shot: any) => [shot.scene, shot.segment, shot.shot, shot.from, shot.to, shot.duration]), [[1, 1, 1, 0, 8, 8]]);
    assert.match(prompt, /不自行重算另报数字/); assert.match(prompt, /未明确的逐行文字首次出现时刻仍是未知/);
    const diagnostics = supervision.supervisionDiagnostics(snapshot);
    assert.deepEqual(diagnostics.errors, []); assert.deepEqual(diagnostics.scenes[0].errors, []);
    assert.equal(diagnostics.scenes[0].coverageVerified, true); assert.ok(diagnostics.scenes[0].warnings.length);
    assert.deepEqual(supervision.validateSupervisionReport(snapshot, "评分：A\n文本结论：合格\n视觉尚未验证"), []);
    assert.deepEqual(await f.db("o_agentWorkData").first(), before);
  } finally { await f.db.destroy(); }
});

test("真实监督wrapper注入原始用户和全来源，仅提供只读工具，遵循有效模型配置", async () => {
  for (const mode of ["1", "0"]) {
    const f = await fixture({ mode });
    try {
      const before = await f.db("o_agentWorkData").first();
      assert.equal(await f.execute(), "评分：A\n文本结论：合格\n视觉核验：尚未查看图片。");
      const input = f.calls.inputs[0];
      assert.equal(f.calls.inputs.length, 1); assert.equal(f.calls.writes, 0);
      assert.deepEqual(Object.keys(input.tools).sort(), ["get_flowData", "get_storyboard_progress"]);
      assert.deepEqual(f.calls.selections, [["get_flowData", "get_storyboard_progress"]]);
      assert.equal(input.temperature, mode === "1" ? 0.2 : 0.1);
      assert.equal(input.maxOutputTokens, mode === "1" ? 12000 : 7000);
      for (const full of [source, plan, table, human]) assert.ok(input.messages[0].content.includes(full));
      assert.match(input.messages[0].content, /"revision": 4/); assert.match(input.messages[0].content, /coverageVerified/);
      assert.match(input.system, /单行镜头连续性/);
      assert.deepEqual(await f.db("o_agentWorkData").first(), before);
    } finally { await f.db.destroy(); }
  }
});

test("审核中版本改变与程序硬错误被乐观A/B结论掩盖时拒绝结果", async () => {
  const changed = await fixture({ mutation: true });
  try { await assert.rejects(changed.execute, /审核期间.*已变化/); }
  finally { await changed.db.destroy(); }
  for (const report of ["评分：B\n文本结论：合格", "评分：A\n概要：可使用"]) {
    const f = await fixture({ badTable: true, report });
    try {
      await assert.rejects(f.execute, /监督报告与程序明确错误矛盾[\s\S]*制作预算8秒/);
      assert.equal(f.calls.writes, 0);
      assert.deepEqual(JSON.parse((await f.db("o_agentWorkData").first()).data), f.original);
    } finally { await f.db.destroy(); }
  }
  const failed = await fixture({ badTable: true, report: "评分：C\n文本结论：不合格\n问题：制作预算不符" });
  try { assert.match(await failed.execute(), /文本结论：不合格/); }
  finally { await failed.db.destroy(); }
});

test("持久监督检查点仅在版本与结论核对成功后保存，失败不能进入记忆或恢复为completed", async () => {
  for (const scenario of [
    { mutation: true, expected: /审核期间.*已变化/ },
    { badTable: true, report: "评分：B\n文本结论：合格", expected: /监督报告与程序明确错误矛盾/ },
    { badTable: true, report: "评分：A\n概要：可使用", expected: /监督报告与程序明确错误矛盾/ },
  ]) {
    const f = await fixture({ ...scenario, persistedRun: true });
    try {
      const paidAssets = await f.db("o_assets").orderBy("id");
      const paidImages = await f.db("o_image").orderBy("id");
      await assert.rejects(f.execute, scenario.expected);
      const step = await f.db("o_agentStep").where({ runId: f.runId }).first();
      assert.equal(step.status, "failed"); assert.equal(step.output, null); assert.equal(step.resultRef, null);
      assert.match(step.error, scenario.expected);
      assert.deepEqual(f.calls.memory, []);
      const monitor = f.calls.messages.find(message => message.name === "监制")!;
      assert.equal(monitor.completed, false); assert.match(monitor.errors[0], scenario.expected);
      const checkpoint = await f.store.buildResumePrompt(f.runId!);
      assert.match(checkpoint, /\[failed\] productionAgent:supervisionAgent/);
      assert.doesNotMatch(checkpoint, /\[completed\] productionAgent:supervisionAgent/);
      await f.store.finish(f.runId!, "failed", step.error);
      await assert.rejects(() => f.store.resume(f.runId!, f.scope), /步骤需要核对，不能自动恢复/);
      const workspace = JSON.parse((await f.db("o_agentWorkData").first()).data);
      assert.deepEqual(workspace.workbench, f.original.workbench);
      assert.equal(workspace.scriptPlan, f.original.scriptPlan);
      assert.equal(workspace.storyboardTableProgress.taskId, f.original.storyboardTableProgress.taskId);
      assert.equal(workspace.storyboardTableProgress.revision, f.original.storyboardTableProgress.revision);
      assert.deepEqual(await f.db("o_assets").orderBy("id"), paidAssets);
      assert.deepEqual(await f.db("o_image").orderBy("id"), paidImages);
      assert.equal(f.calls.writes, 0);
    } finally { await f.db.destroy(); }
  }
});

test("有runId的有效正面或不合格审核均完成检查点，缓存复用不重复生成或写记忆", async () => {
  for (const scenario of [
    { report: "评分：A\n文本结论：合格\n视觉尚未验证" },
    { badTable: true, report: "评分：C\n文本结论：不合格\n问题：制作预算不符" },
  ]) {
    const f = await fixture({ ...scenario, persistedRun: true });
    try {
      const workspace = await f.db("o_agentWorkData").first();
      assert.equal(await f.execute(), scenario.report);
      const step = await f.db("o_agentStep").where({ runId: f.runId }).first();
      assert.equal(step.status, "completed"); assert.equal(step.output, scenario.report); assert.match(step.resultRef, /^message:/);
      assert.deepEqual(f.calls.memory, [{ key: "assistant:supervision", content: scenario.report }]);
      assert.equal(f.calls.messages.find(message => message.name === "监制")!.completed, true);
      assert.equal(await f.execute(), scenario.report);
      assert.equal(f.calls.inputs.length, 1); assert.equal(f.calls.memory.length, 1);
      assert.equal((await f.db("o_agentStep")).length, 1);
      assert.deepEqual(await f.db("o_agentWorkData").first(), workspace);
      assert.equal(f.calls.writes, 0);
    } finally { await f.db.destroy(); }
  }
});

test("同一输入命中监督缓存后版本竞态或结论guard拒绝会失效旧completed，不调用新模型", async () => {
  for (const scenario of [
    { cacheMutation: true, report: "评分：A\n文本结论：合格", expected: /审核期间.*已变化/ },
    { badTable: true, report: "评分：C\n文本结论：不合格", rejectedCache: "评分：B\n文本结论：合格", expected: /监督报告与程序明确错误矛盾/ },
  ]) {
    const f = await fixture({ ...scenario, persistedRun: true });
    try {
      assert.equal(await f.execute(), scenario.report);
      const originalStep = await f.db("o_agentStep").where({ runId: f.runId }).first();
      const rejectedCache = scenario.rejectedCache ?? scenario.report;
      if (scenario.rejectedCache) await f.db("o_agentStep").where({ runId: f.runId, stepKey: originalStep.stepKey }).update({ output: rejectedCache });
      const mediaStep = { id: "paid_media_step", runId: f.runId, stepKey: "completed:paid-media", status: "completed", output: "已有付费视频", resultRef: "video:99" };
      await f.db("o_agentStep").insert(mediaStep);
      const mediaBefore = await f.db("o_agentStep").where({ id: mediaStep.id }).first();
      await assert.rejects(f.execute, scenario.expected);
      const rejected = await f.db("o_agentStep").where({ runId: f.runId, stepKey: originalStep.stepKey }).first();
      assert.equal(rejected.status, "failed"); assert.equal(rejected.resultRef, null);
      assert.equal(rejected.output, rejectedCache); assert.match(rejected.error, scenario.expected);
      assert.equal(f.calls.inputs.length, 1); assert.deepEqual(f.calls.memory, [{ key: "assistant:supervision", content: scenario.report }]);
      assert.deepEqual(await f.db("o_agentStep").where({ id: mediaStep.id }).first(), mediaBefore);
      const checkpoint = await f.store.buildResumePrompt(f.runId!);
      assert.match(checkpoint, /\[failed\] productionAgent:supervisionAgent/);
      assert.doesNotMatch(checkpoint, /\[completed\] productionAgent:supervisionAgent/);
      assert.match(checkpoint, /\[completed\] completed:paid-media/);
      await f.store.finish(f.runId!, "failed", rejected.error);
      await assert.rejects(() => f.store.resume(f.runId!, f.scope), /步骤需要核对，不能自动恢复/);
      assert.equal(f.calls.writes, 0);
    } finally { await f.db.destroy(); }
  }
});

test("缓存失效CAS保护并发新输出；0行更新仍拒绝返回旧报告，nullable输出也按原值匹配", async () => {
  const f = await fixture({ persistedRun: true, cacheMutation: true, invalidationRace: true });
  try {
    await f.execute();
    const originalStep = await f.db("o_agentStep").where({ runId: f.runId }).first();
    await assert.rejects(f.execute, /审核期间.*已变化/);
    const concurrent = await f.db("o_agentStep").where({ runId: f.runId, stepKey: originalStep.stepKey }).first();
    assert.equal(concurrent.status, "completed"); assert.equal(concurrent.output, "并发替换的新缓存");
    assert.equal(concurrent.resultRef, originalStep.resultRef); assert.equal(concurrent.error, null);
    assert.equal(f.calls.inputs.length, 1); assert.equal(f.calls.memory.length, 1);
    await f.store.beginStep(f.runId!, "nullable-cache", "无输出的历史只读缓存");
    await f.store.finishStep(f.runId!, "nullable-cache", "message:old");
    assert.equal(await f.store.invalidateCompletedStep(f.runId!, "nullable-cache", "错误的期望输出", "不应覆盖"), false);
    assert.equal((await f.db("o_agentStep").where({ runId: f.runId, stepKey: "nullable-cache" }).first()).status, "completed");
    assert.equal(await f.store.invalidateCompletedStep(f.runId!, "nullable-cache", undefined, "空缓存不可作为审核依据"), true);
    const invalidated = await f.db("o_agentStep").where({ runId: f.runId, stepKey: "nullable-cache" }).first();
    assert.equal(invalidated.status, "failed"); assert.equal(invalidated.output, null); assert.equal(invalidated.resultRef, null);
    await f.store.beginStep(f.runId!, "running-media", "正在执行的媒体步骤");
    assert.equal(await f.store.invalidateCompletedStep(f.runId!, "running-media", undefined, "不得改写运行中的步骤"), false);
    assert.equal((await f.db("o_agentStep").where({ runId: f.runId, stepKey: "running-media" }).first()).status, "running");
  } finally { await f.db.destroy(); }
});
