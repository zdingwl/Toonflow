import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import knex from "knex";
import { transform } from "sucrase";
import * as storyboardTable from "../src/agents/productionAgent/storyboardTable";
import * as storyboardProgress from "../src/agents/productionAgent/storyboardProgress";
import * as storyboardRunner from "../src/agents/productionAgent/storyboardTaskRunner";
import * as storyboardValidator from "../src/agents/productionAgent/storyboardValidator";
import * as storyboardContext from "../src/agents/productionAgent/storyboardContext";
import * as screenplay from "../src/agents/productionAgent/screenplay";
import * as directorContext from "../src/agents/productionAgent/directorPlanContext";
import * as deriveAssetContext from "../src/agents/productionAgent/deriveAssetContext";
import * as supervisionContext from "../src/agents/productionAgent/supervisionContext";
import { TaskStore } from "../src/utils/agent/runtime/taskStore";

const source = "场1：甲板（0-8秒）\n艾娃：『你好。』\n贝拉：『走吧。』";
const plan = "共规划1场\n| 场次 | 制作预算（秒） |\n| Sc1 | 8 |\n导演节拍：先观察再回应，二人走向舱门。";
const fullRevisionFeedback = '修订分镜，保留已确认拍时。' + '完整审核反馈。'.repeat(80) + '反馈末尾：重要界面不是普通手机内容，话后停留不能被对白占用。';
function candidate(input: any, seconds = 4, assetId = 61, speech = true) {
  const task = input.messages[1].content.match(/task=([a-zA-Z0-9_-]+)/)[1];
  return `<storyboardTable scene="1" total="1" task="${task}">## 场1：甲板
### 片段一（约${seconds * 2}s）
**引用资产ID**：[${assetId}]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 艾娃先观察贝拉 | ${seconds} | 近景 | 固定 | ${speech ? "艾娃：『你好。』" : "无台词"} | 环境音 |
| 2 | 贝拉回应，二人走向舱门 | ${seconds} | 中景 | 固定 | ${speech ? "贝拉：『走吧。』" : "无台词"} | 环境音 |
</storyboardTable>`;
}

type Options = { network?: boolean; checkpointError?: boolean; stopped?: boolean; conflict?: "plan" | "source"; postCommitError?: boolean; mode?: string; childTokens?: number; parentTokens?: number; noChildModel?: boolean };
async function fixture(responses: ((input: any) => string)[], options: Options = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_script", t => { t.integer("id"); t.integer("projectId"); t.text("content"); });
    await db.schema.createTable("o_project", t => { t.integer("id"); t.text("imageModel"); t.text("videoModel"); t.text("mode"); t.text("artStyle"); t.text("directorManual"); });
    await db.schema.createTable("o_agentWorkData", t => { t.increments("id"); t.integer("projectId"); t.integer("episodesId"); t.text("key"); t.text("data"); });
    await db.schema.createTable("o_agentDeploy", t => { t.text("key"); t.text("modelName"); t.float("temperature"); t.integer("maxOutputTokens"); });
    await db.schema.createTable("o_setting", t => { t.text("key"); t.text("value"); });
    await db.schema.createTable("o_assets", t => { t.integer("id"); t.integer("projectId"); t.integer("assetsId"); t.integer("imageId"); t.text("name"); t.text("type"); t.text("describe"); });
    await db.schema.createTable("o_scriptAssets", t => { t.integer("scriptId"); t.integer("assetId"); });
    await db.schema.createTable("o_image", t => { t.integer("id"); t.text("state"); t.text("filePath"); t.text("errorReason"); });
    await db.schema.createTable("o_agentRun", t => { t.text("id"); t.text("agentType"); t.integer("projectId"); t.integer("episodesId"); t.text("isolationKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db.schema.createTable("o_agentStep", t => { t.text("id"); t.text("runId"); t.text("stepKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("output"); t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime"); });
    await db.schema.createTable("o_agentToolCall", t => { t.text("id"); t.text("runId"); t.text("stepKey"); t.integer("sideEffect"); t.text("status"); t.text("error"); t.integer("updateTime"); });
    await db("o_script").insert({ id: 71, projectId: 1, content: source });
    await db("o_project").insert({ id: 1, imageModel: "mock:image", videoModel: "mock:video", mode: "[]", artStyle: "style", directorManual: "story" });
    await db("o_agentDeploy").insert([
      { key: "productionAgent:storyboardTableAgent", modelName: options.noChildModel ? null : "mock:storyboard", temperature: 1, maxOutputTokens: options.childTokens ?? 0 },
      { key: "productionAgent", modelName: "mock:parent", temperature: 0.1, maxOutputTokens: options.parentTokens ?? 5000 },
    ]);
    await db("o_setting").insert({ key: "agentUseMode", value: options.mode ?? "1" });
    await db("o_assets").insert([
      { id: 61, projectId: 1, name: "甲板二人", type: "角色", describe: "数据库真实形象", imageId: 3 },
      { id: 62, projectId: 1, name: "其他集角色", type: "角色" },
      { id: 63, projectId: 1, assetsId: 61, name: "角色湿身", type: "角色", describe: "当前角色的衍生状态" },
      { id: 64, projectId: 2, name: "其他项目", type: "角色" },
      { id: 65, projectId: 1, assetsId: 61, name: "其他集共享父资产衍生", type: "角色", describe: "禁止带入本集的状态" },
    ]);
    await db("o_scriptAssets").insert([{ scriptId: 71, assetId: 61 }, { scriptId: 71, assetId: 63 }]);
    await db("o_image").insert({ id: 3, state: "已完成", filePath: "image.png", errorReason: "" });
    const original = { scriptPlan: plan, storyboardTable: "", workbench: { videoList: [{ id: 8 }] } };
    await db("o_agentWorkData").insert({ projectId: 1, episodesId: 71, key: "productionAgent", data: JSON.stringify(original) });
    const store = new TaskStore(db);
    await store.begin({ requestId: "runtime_run_01", agentType: "productionAgent", projectId: 1, episodesId: 71, isolationKey: "1:productionAgent:71", content: "生成分镜" });
    const calls = { streams: [] as any[], outputs: [] as string[], commits: [] as any[], toolSelections: [] as any[], writes: 0, skillLoads: 0 };
    class RuntimeTaskStore extends TaskStore {
      async readSkill() { return "primary storyboard Skill"; }
      async saveStepOutput(runId: string, stepKey: string, output: string) {
        if (options.checkpointError) throw new Error("checkpoint write failed");
        await super.saveStepOutput(runId, stepKey, output);
        calls.outputs.push(output);
      }
    }
    const textStream = () => ({ append() { return this; }, complete() { return this; }, error() { return this; } });
    const message = () => ({ id: "message", datetime: new Date().toISOString(), text: textStream, complete() {}, error() {} });
    class MockMemory { async add() { if (options.postCommitError) throw new Error("memory temporarily unavailable"); } }
    const u = {
      db, error: (error: any) => error, getPath: (parts: string | string[]) => path.resolve("data", ...[parts].flat()),
      vendor: { getModelList: async () => [{ modelName: "video" }] },
      Ai: { Text: () => ({ stream: async (input: any) => {
        calls.streams.push({ ...input, messages: input.messages.map((value: any) => ({ ...value })) });
        if (options.network) throw new Error("provider unavailable");
        if (options.conflict === "plan") await db("o_agentWorkData").update({ data: JSON.stringify({ ...original, scriptPlan: plan + "\n人工新节拍" }) });
        if (options.conflict === "source") await db("o_script").update({ content: source + "\n人工新增动作" });
        await input.tools.activate_skill.execute({ name: "selected" });
        const render = responses[calls.streams.length - 1];
        if (!render) throw new Error("unexpected extra generation");
        return { fullStream: (async function* () { yield { type: "text-delta", text: render(input) }; yield { type: "finish" }; })() };
      } }) },
    };
    const mocks: Record<string, any> = {
      "@/utils": u, "@/utils/agent/memory": MockMemory, "@/socket/resTool": {},
      "@/utils/agent/skillsTools": { scanSkills: async () => [], buildSkillPrompt: () => "selected skill inventory", createSkillTools: () => {
        calls.skillLoads++; let active = false;
        return { activate_skill: { execute: async () => { if (active) return { alreadyActive: true }; active = true; return { content: "当前风格完整已激活Skill正文" }; } },
          read_skill_file: { execute: async () => ({ content: "resource" }) }, generate_storyboard: { execute: async () => { calls.writes++; } } };
      } },
      "@/agents/productionAgent/tools": ({ toolsNames }: any) => {
        calls.toolSelections.push(toolsNames);
        return Object.fromEntries(["get_flowData", "get_storyboard_progress", "add_deriveAsset"].filter(name => !toolsNames || toolsNames.includes(name)).map(name => [name, { execute: async () => { if (name === "add_deriveAsset") calls.writes++; return {}; } }]));
      },
      "@/utils/agent/runtime/taskStore": { TaskStore: RuntimeTaskStore },
      "./directorPlan": {}, "./directorPlanContext": directorContext, "./directorPlanQuality": {}, "./screenplay": screenplay,
      "./storyboardContext": storyboardContext, "./storyboardProgress": storyboardProgress, "./storyboardTaskRunner": storyboardRunner, "./storyboardValidator": storyboardValidator,
      "./deriveAssetContext": deriveAssetContext,
      "./supervisionContext": supervisionContext,
      "./storyboardTable": { ...storyboardTable, commitStoryboardTableOutput: async (...args: Parameters<typeof storyboardTable.commitStoryboardTableOutput>) => {
        if (options.stopped) await store.finish("runtime_run_01", "reconciling", "用户停止");
        return storyboardTable.commitStoryboardTableOutput(...args);
      } },
      "./storyboardRebuildDispatch": { storyboardPlanSceneCount: () => 1 }, "./storyboardRevisionTool": { createStoryboardRevisionTool: (opts: any) => ({ execute: opts.generate }) },
      "@/utils/agent/runtime/toolExecutor": { wrapAgentTools: (tools: any) => tools }, "@/utils/agent/contextManager": {},
    };
    const localRequire = createRequire(path.resolve("package.json")), module = { exports: {} as any };
    const code = transform(readFileSync("src/agents/productionAgent/index.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
    new Function("require", "module", "exports", code + "\nexports.createSubAgentForTest = createSubAgent;")((id: string) => mocks[id] ?? localRequire(id), module, module.exports);
    const resTool = { data: { projectId: 1, scriptId: 71 }, socket: { emit: (event: string, payload: any) => { if (event === "storyboardTable:committed") calls.commits.push(payload); } }, newMessage: message };
    const tools = await module.exports.createSubAgentForTest({ runId: "runtime_run_01", isolationKey: "1:productionAgent:71", text: fullRevisionFeedback, resTool, msg: message(), thinkConfig: { think: false, thinlLevel: 0 } });
    return { db, store, calls, original, execute: () => tools.run_sub_agent_storyboard_table.execute({ prompt: "落实已确认导演节拍", scope: "full" }),
      revise: () => tools.run_sub_agent_storyboard_revise.execute({ instruction: "明确支撑位置", scene: 1, total: 1, taskId: "storyboard_old_01", original: "已有完整稿", sourceScene: source }) };
  } catch (error) { await db.destroy(); throw error; }
}

test("分镜完整上下文、只读工具、输出预算生效，XML和预算失败带反馈重试后原子保存", async () => {
  const f = await fixture([() => "<storyboardTable>未闭合", input => candidate(input, 3), input => candidate(input)]);
  try {
    const result = await f.execute();
    assert.equal(result.complete, true);
    assert.equal(f.calls.streams.length, 3);
    assert.equal(f.calls.skillLoads, 1);
    assert.equal(f.calls.streams[0].temperature, 0.3);
    assert.equal(f.calls.streams[0].maxOutputTokens, 12000);
    assert.deepEqual(Object.keys(f.calls.streams[0].tools).sort(), ["activate_skill", "get_flowData", "get_storyboard_progress", "read_skill_file"]);
    assert.equal(f.calls.writes, 0);
    const first = f.calls.streams[0].messages[1].content;
    assert.ok(first.includes(source)); assert.ok(first.includes(plan));
    assert.match(first, /数据库真实形象/); assert.match(first, /当前角色的衍生状态/);
    assert.doesNotMatch(first, /其他集角色|其他项目|其他集共享父资产衍生|禁止带入本集的状态/);
    assert.match(f.calls.streams[1].messages.at(-1).content, /只能有一份 storyboardTable/);
    assert.match(f.calls.streams[2].messages.at(-1).content, /制作预算8秒/);
    assert.ok(f.calls.streams[2].messages.some((value: any) => value.content.includes("当前风格完整已激活Skill正文")));
    assert.equal(f.calls.outputs.length, 1); assert.equal(f.calls.commits.length, 1);
    const step = await f.db("o_agentStep").first();
    assert.equal(step.status, "completed"); assert.equal(step.output, f.calls.outputs[0]);
    assert.equal(await storyboardTable.reconcileStoryboardTableOutput(f.db, 1, 71, step.output), "storyboardTable:1:71:scene:1");
    const saved = JSON.parse((await f.db("o_agentWorkData").first()).data);
    assert.deepEqual(saved.workbench, f.original.workbench); assert.equal(saved.scriptPlan, plan);
  } finally { await f.db.destroy(); }
});

test("三次资产或原台词校验失败仅标failed，不保存候选、检查点或完成回执", async () => {
  for (const response of [(input: any) => candidate(input, 4, 62), (input: any) => candidate(input, 4, 61, false)]) {
    const f = await fixture([response, response, response]);
    try {
      await assert.rejects(f.execute, /连续3次未通过校验/);
      assert.equal(f.calls.streams.length, 3); assert.equal(f.calls.outputs.length, 0); assert.equal(f.calls.commits.length, 0);
      const step = await f.db("o_agentStep").first();
      assert.equal(step.status, "failed"); assert.equal(step.output, null);
      assert.deepEqual(JSON.parse((await f.db("o_agentWorkData").first()).data), f.original);
    } finally { await f.db.destroy(); }
  }
});

test("网络不内容重试，停止/检查点失败全部回滚，首次场次并发修改剧本或规划被拒绝", async () => {
  for (const options of [{ network: true }, { stopped: true }, { checkpointError: true }, { conflict: "plan" as const }, { conflict: "source" as const }]) {
    const f = await fixture([input => candidate(input)], options);
    try {
      await assert.rejects(f.execute, /provider unavailable|输出状态未能保存|checkpoint write failed|生成期间已修改/);
      assert.equal(f.calls.streams.length, 1); assert.equal(f.calls.outputs.length, 0); assert.equal(f.calls.commits.length, 0);
      const step = await f.db("o_agentStep").first(); assert.equal(step.output, null);
      const saved = JSON.parse((await f.db("o_agentWorkData").first()).data);
      assert.equal(saved.storyboardTable, ""); assert.deepEqual(saved.workbench, f.original.workbench);
      assert.equal(saved.scriptPlan, options.conflict === "plan" ? plan + "\n人工新节拍" : plan);
    } finally { await f.db.destroy(); }
  }
});

test("提交后内存失败保留原response可恢复，简易和fallback使用有效父配置额度", async () => {
  const interrupted = await fixture([input => candidate(input)], { postCommitError: true });
  try {
    const result = await interrupted.execute();
    assert.equal(result.complete, true); // Runner confirms committed DB even when subsequent memory update fails.
    const step = await interrupted.db("o_agentStep").first();
    assert.equal(step.status, "reconciling"); assert.ok(step.output);
    assert.equal(await storyboardTable.reconcileStoryboardTableOutput(interrupted.db, 1, 71, step.output), "storyboardTable:1:71:scene:1");
  } finally { await interrupted.db.destroy(); }
  for (const options of [{ mode: "0", childTokens: 12000 }, { mode: "unset", noChildModel: true }]) {
    const f = await fixture([input => candidate(input)], options);
    try {
      await f.execute(); assert.equal(f.calls.streams[0].maxOutputTokens, 5000); assert.equal(f.calls.streams[0].temperature, 0.1);
    } finally { await f.db.destroy(); }
  }
});

test("已有场次修订同样注入完整当前规划、真实资产和只读Skill工具", async () => {
  const f = await fixture([input => candidate(input)]);
  try {
    assert.match(await f.revise(), /^<storyboardTable/);
    const input = f.calls.streams[0];
    assert.ok(input.messages[1].content.includes(plan)); assert.ok(input.messages[1].content.includes(source));
    assert.ok(input.messages[1].content.includes(fullRevisionFeedback));
    assert.match(input.messages[1].content, /数据库真实形象/);
    assert.equal(input.maxOutputTokens, 12000); assert.equal(input.temperature, 0.3);
    assert.deepEqual(Object.keys(input.tools).sort(), ["activate_skill", "get_flowData", "get_storyboard_progress", "read_skill_file"]);
    assert.equal(f.calls.commits.length, 0);
  } finally { await f.db.destroy(); }
});

test("修订错误候选不得提前保存输出或完成持久检查点", async () => {
  for (const render of [
    (input: any) => candidate(input, 4, 65),
    (input: any) => candidate(input).replace("[61]", "[61,63]"),
  ]) {
    const f = await fixture([render]);
    try {
      await assert.rejects(() => f.revise(), /修订候选未通过校验/);
      assert.equal(f.calls.outputs.length, 0);
      assert.equal(f.calls.commits.length, 0);
      const step = await f.db("o_agentStep").first();
      assert.equal(step.status, "failed");
      assert.equal(step.output, null);
      assert.equal(step.resultRef, null);
    } finally { await f.db.destroy(); }
  }
});

test("新failed无输出和旧reconciling拒绝输出可安全恢复，已提交原响应完成，其余稿件和副作用保留待核对", async () => {
  const f = await fixture([]);
  try {
    const expectedScene = { scene: 1, total: 1, taskId: "storyboard_recovery_01" };
    for (const [index, output] of [undefined, "<storyboardTable>被拒绝的未闭合候选"].entries()) {
      const input = JSON.stringify({ expectedScene, index });
      const stepKey = TaskStore.makeStepKey("productionAgent:storyboardTableAgent", input);
      await f.store.beginStep("runtime_run_01", stepKey, input);
      if (output) {
        await f.store.saveStepOutput("runtime_run_01", stepKey, output);
        await f.store.markStepReconciling("runtime_run_01", stepKey, "旧校验失败");
      } else await f.store.failStep("runtime_run_01", stepKey, "三次候选被拒绝");
      const recovered = await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, output, { hasSideEffects: false, expectedScene });
      assert.equal(recovered.status, "retryable");
      if (recovered.status === "retryable") await f.store.resolveStep("runtime_run_01", stepKey, "retryable", undefined, recovered.error);
      assert.equal((await f.db("o_agentStep").where({ stepKey }).first()).status, "retryable");
      const unsafe = await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, output, { hasSideEffects: true, expectedScene });
      assert.equal(unsafe.status, "blocked");
    }
    const response = candidate({ messages: [{}, { content: `只处理第1场，共1场，task=${expectedScene.taskId}` }] });
    const committed = await storyboardTable.commitStoryboardTableOutput(f.db, 1, 71, storyboardTable.extractStoryboardTable(response));
    assert.equal((await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, response, { hasSideEffects: false, expectedScene })).status, "completed");
    const differing = response.replace("艾娃先观察贝拉", "艾娃看向另一侧");
    assert.equal((await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, differing, { hasSideEffects: false, expectedScene })).status, "blocked");
    assert.equal((await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, undefined, { hasSideEffects: false,
      expectedScene: { ...expectedScene, taskId: "storyboard_replaced_01" } })).status, "blocked");
    const after = JSON.parse((await f.db("o_agentWorkData").first()).data);
    assert.equal(after.storyboardTable, committed.storyboardTable); assert.deepEqual(after.workbench, f.original.workbench);
    const socket = readFileSync("src/socket/routes/productionAgent.ts", "utf8");
    assert.match(socket, /item\.status === "failed" && item\.stepKey\.startsWith\("productionAgent:storyboardTableAgent:"\)/);
    assert.match(socket, /inspectStoryboardTableRecovery/);
    assert.match(socket, /hasSideEffects: state\.toolCalls\.some/);
  } finally { await f.db.destroy(); }
});

test("应生成第2场的旧步骤不能因raw重复已保存第1场而误判completed或复用旧缓存", async () => {
  const f = await fixture([]);
  try {
    const taskId = "storyboard_two_scenes_01";
    await f.db("o_script").update({ content: source + "\n场2：舱门（8-16秒）\n艾娃：『准备好了。』" });
    const twoScenePlan = plan.replace("共规划1场", "共规划2场") + "\n| Sc2 | 8 |";
    await f.db("o_agentWorkData").update({ data: JSON.stringify({ ...f.original, scriptPlan: twoScenePlan }) });
    const rawScene1 = candidate({ messages: [{}, { content: `只处理第1场，共2场，task=${taskId}` }] }).replace('total="1"', 'total="2"');
    await storyboardTable.commitStoryboardTableOutput(f.db, 1, 71, storyboardTable.extractStoryboardTable(rawScene1));
    const expectedScene = { scene: 2, total: 2, taskId };
    const input = JSON.stringify({ expectedScene });
    const stepKey = TaskStore.makeStepKey("productionAgent:storyboardTableAgent", input);
    await f.store.beginStep("runtime_run_01", stepKey, input);
    await f.store.saveStepOutput("runtime_run_01", stepKey, rawScene1);
    await f.store.markStepReconciling("runtime_run_01", stepKey, "旧模型错场，被协议校验拒绝");
    const before = (await f.db("o_agentWorkData").first()).data;
    const recovery = await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, rawScene1, { hasSideEffects: false, expectedScene });
    assert.equal(recovery.status, "retryable");
    if (recovery.status === "retryable") {
      assert.match(recovery.error, /固定第2场/);
      await f.store.resolveStep("runtime_run_01", stepKey, "retryable", undefined, recovery.error);
    }
    assert.deepEqual(await f.store.beginStep("runtime_run_01", stepKey, input), { cached: false });
    const step = await f.db("o_agentStep").where({ stepKey }).first();
    assert.equal(step.status, "running"); assert.equal(step.output, null); assert.equal(step.resultRef, null);
    assert.equal((await f.db("o_agentWorkData").first()).data, before);
    const progress = await storyboardProgress.readStoryboardProgress(f.db, 1, 71);
    assert.deepEqual(progress.savedScenes, [1]); assert.deepEqual(progress.missingScenes, [2]);
    const unsafe = await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, rawScene1, { hasSideEffects: true, expectedScene });
    assert.equal(unsafe.status, "blocked");
    const actualScene1 = await storyboardTable.inspectStoryboardTableRecovery(f.db, 1, 71, rawScene1, {
      hasSideEffects: false, expectedScene: { scene: 1, total: 2, taskId },
    });
    assert.deepEqual(actualScene1, { status: "completed", resultRef: "storyboardTable:1:71:scene:1" });
  } finally { await f.db.destroy(); }
});
