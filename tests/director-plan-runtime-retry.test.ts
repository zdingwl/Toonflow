import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import knex from "knex";
import { transform } from "sucrase";
import * as directorPlan from "../src/agents/productionAgent/directorPlan";
import * as directorContext from "../src/agents/productionAgent/directorPlanContext";
import * as storyboardContext from "../src/agents/productionAgent/storyboardContext";
import * as deriveAssetContext from "../src/agents/productionAgent/deriveAssetContext";
import * as supervisionContext from "../src/agents/productionAgent/supervisionContext";
import { TaskStore } from "../src/utils/agent/runtime/taskStore";

async function fixture(responses: string[], options: { conflict?: boolean; streamError?: boolean; mode?: string; childTokens?: number; parentTokens?: number; stopped?: boolean; checkpointError?: boolean } = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_script", t => { t.integer("id"); t.integer("projectId"); t.text("content"); });
  await db.schema.createTable("o_project", t => { t.integer("id"); t.text("imageModel"); t.text("videoModel"); t.text("mode"); t.text("artStyle"); t.text("directorManual"); });
  await db.schema.createTable("o_agentWorkData", t => {
    t.increments("id"); t.integer("projectId"); t.integer("episodesId"); t.text("key"); t.text("data"); t.integer("createTime"); t.integer("updateTime");
  });
  await db.schema.createTable("o_agentDeploy", t => { t.text("key"); t.text("modelName"); t.float("temperature"); t.integer("maxOutputTokens"); });
  await db.schema.createTable("o_setting", t => { t.text("key"); t.text("value"); });
  await db.schema.createTable("o_agentStep", t => { t.text("runId"); t.text("stepKey"); t.text("status"); t.text("output"); t.integer("updateTime"); });
  await db("o_script").insert({ id: 71, projectId: 1, content: "完整来源事实" });
  await db("o_project").insert({ id: 1, imageModel: "mock:image", videoModel: "mock:video", mode: "[]", artStyle: "mock_art", directorManual: "mock_story" });
  await db("o_agentDeploy").insert([
    { key: "productionAgent:directorPlanAgent", modelName: "mock:director", temperature: 1, maxOutputTokens: options.childTokens ?? 0 },
    { key: "productionAgent", modelName: "mock:parent", temperature: 1, maxOutputTokens: options.parentTokens ?? 5000 },
  ]);
  await db("o_setting").insert({ key: "agentUseMode", value: options.mode ?? "1" });
  const original = { scriptPlan: "原合格规划", storyboardTable: "已有分镜", workbench: { videoList: [{ id: 8 }] } };
  await db("o_agentWorkData").insert({ projectId: 1, episodesId: 71, key: "productionAgent", data: JSON.stringify(original) });
  const calls = { streams: [] as any[], outputs: [] as string[], commits: [] as any[], failures: [] as string[], reconciliations: [] as string[], finished: 0, stepInputs: [] as string[], errors: [] as string[] };
  const textStream = () => ({ append() { return this; }, complete() { return this; }, error() { return this; } });
  const message = () => ({ id: "message", datetime: new Date().toISOString(), text: textStream, complete() {}, error(error: string) { calls.errors.push(error); } });
  class MockMemory { async add() {} }
  class MockTaskStore {
    constructor(private database: typeof db) {}
    static makeStepKey(key: string) { return key; }
    async beginStep(runId: string, stepKey: string, input: string) {
      calls.stepInputs.push(input);
      await this.database("o_agentStep").insert({ runId, stepKey, status: "running", output: null });
      return { cached: false };
    }
    async readSkill() { return "director skill"; }
    async saveStepOutput(runId: string, stepKey: string, output: string) {
      if (options.checkpointError) throw new Error("checkpoint write failed");
      await new TaskStore(this.database).saveStepOutput(runId, stepKey, output);
      calls.outputs.push(output);
    }
    async finishStep() { calls.finished++; }
    async failStep(_run: string, _key: string, error: string) { calls.failures.push(error); }
    async markStepReconciling(_run: string, _key: string, error: string) { calls.reconciliations.push(error); }
  }
  const u = {
    db, error: (error: any) => error, getPath: (part: string | string[]) => path.resolve("data", ...[part].flat()),
    vendor: { getModelList: async () => [{ modelName: "video" }] },
    Ai: { Text: () => ({ stream: async (input: any) => {
      calls.streams.push({ ...input, messages: input.messages.map((value: any) => ({ ...value })) });
      if (options.streamError) throw new Error("provider unavailable");
      if (options.conflict) await db("o_agentWorkData").update({ data: JSON.stringify({ ...original, scriptPlan: "人工新版本" }) });
      const response = responses[calls.streams.length - 1];
      if (response === undefined) throw new Error("unexpected extra generation");
      return { fullStream: (async function* () { yield { type: "text-delta", text: response }; yield { type: "finish" }; })() };
    } }) },
  };
  const mocks: Record<string, any> = {
    "@/utils": u,
    "@/utils/agent/memory": MockMemory,
    "@/utils/agent/skillsTools": { scanSkills: async () => [], buildSkillPrompt: () => "selected skill inventory", createSkillTools: () => ({}) }, "@/agents/productionAgent/tools": () => ({}),
    "@/socket/resTool": {}, "./directorPlan": {
      ...directorPlan,
      saveDirectorPlan: async (...args: Parameters<typeof directorPlan.saveDirectorPlan>) => {
        // Simulate a stop after output validation but before the business transaction.
        if (options.stopped) await db("o_agentStep").where({ runId: "run", stepKey: "productionAgent:directorPlanAgent" }).update({ status: "reconciling" });
        return directorPlan.saveDirectorPlan(...args);
      },
    },
    "./storyboardTable": {}, "@/utils/agent/runtime/taskStore": { TaskStore: MockTaskStore },
    "./storyboardProgress": {}, "./storyboardTaskRunner": {}, "./storyboardValidator": {},
    "./screenplay": { screenplayFacts: () => "facts", validateDirectorFacts: (_script: string, plan: string) => plan === "bad-fact" ? ["场次预算不连续"] : [] },
    "./directorPlanQuality": { validateDirectorExecution: (_script: string, plan: string) => plan === "bad-quality" ? ["双人握持缺少物理调度"] : [] },
    "./directorPlanContext": directorContext,
    "./storyboardContext": storyboardContext,
    "./deriveAssetContext": deriveAssetContext,
    "./supervisionContext": supervisionContext,
    "./storyboardRebuildDispatch": {}, "./storyboardRevisionTool": { createStoryboardRevisionTool: () => ({}) },
    "@/utils/agent/runtime/toolExecutor": { wrapAgentTools: (tools: any) => tools },
    "@/utils/agent/contextManager": {},
  };
  const localRequire = createRequire(path.resolve("package.json")), module = { exports: {} as any };
  const code = transform(readFileSync("src/agents/productionAgent/index.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code + "\nexports.createSubAgentForTest = createSubAgent;")(
    (id: string) => mocks[id] ?? localRequire(id), module, module.exports,
  );
  const resTool = { data: { projectId: 1, scriptId: 71 }, socket: { emit: (event: string, payload: any) => { if (event === "scriptPlan:committed") calls.commits.push(payload); } }, newMessage: message };
  const tools = await module.exports.createSubAgentForTest({ runId: "run", isolationKey: "1:productionAgent:71", resTool, msg: message(), thinkConfig: { think: false, thinlLevel: 0 } });
  return { db, calls, original, execute: () => tools.run_sub_agent_director_plan.execute({ prompt: "生成完整导演规划" }),
    executeOther: () => tools.run_sub_agent_storyboard_gen.execute({ prompt: "执行单次分镜图任务" }) };
}

test("导演候选XML/事实/执行校验失败后带具体反馈重试，只提交最终合格规划", async () => {
  const f = await fixture(["<scriptPlan>未闭合", "<scriptPlan>bad-quality</scriptPlan>", "<scriptPlan>合格新版</scriptPlan>"]);
  try {
    const result = await f.execute();
    assert.equal(result, "<scriptPlan>合格新版</scriptPlan>");
    assert.equal(f.calls.streams.length, 3);
    assert.equal(f.calls.streams[0].maxOutputTokens, 12000);
    assert.equal(JSON.parse(f.calls.stepInputs[0]).maxOutputTokens, 12000);
    assert.deepEqual(f.calls.outputs, [result]);
    assert.equal(f.calls.commits.length, 1);
    assert.equal(f.calls.finished, 1);
    assert.equal(f.calls.failures.length, 0);
    assert.ok(f.calls.streams[1].messages.some((value: any) => value.role === "assistant" && value.content === "<scriptPlan>未闭合"));
    assert.match(f.calls.streams[2].messages.at(-1).content, /双人握持缺少物理调度/);
    assert.match(f.calls.streams[2].messages[0].content, /完整来源事实/);
    const saved = JSON.parse((await f.db("o_agentWorkData").first()).data);
    assert.deepEqual(saved, { ...f.original, scriptPlan: "合格新版" });
    const checkpoint = await f.db("o_agentStep").where({ runId: "run", stepKey: "productionAgent:directorPlanAgent" }).first();
    assert.equal(checkpoint.output, result);
    assert.equal(await directorPlan.reconcileDirectorPlanOutput(f.db, 1, 71, checkpoint.output), "directorPlan:1:71");
  } finally { await f.db.destroy(); }
});

test("三次事实失败标记failed，不保存候选/完成回执，不覆盖已有分镜和视频", async () => {
  const f = await fixture(Array(3).fill("<scriptPlan>bad-fact</scriptPlan>"));
  try {
    await assert.rejects(f.execute, /连续3次未通过校验[\s\S]*场次预算不连续/);
    assert.equal(f.calls.streams.length, 3);
    assert.equal(f.calls.outputs.length, 0);
    assert.equal(f.calls.commits.length, 0);
    assert.equal(f.calls.finished, 0);
    assert.equal(f.calls.failures.length, 1);
    assert.equal(f.calls.reconciliations.length, 0);
    assert.deepEqual(JSON.parse((await f.db("o_agentWorkData").first()).data), f.original);
  } finally { await f.db.destroy(); }
});

test("网络失败不进入内容重试，人工规划并发修改保留新版本", async () => {
  const failed = await fixture([], { streamError: true });
  try {
    await assert.rejects(failed.execute, /provider unavailable/);
    assert.equal(failed.calls.streams.length, 1);
    assert.equal(failed.calls.failures.length, 0);
    assert.equal(failed.calls.reconciliations.length, 1);
  } finally { await failed.db.destroy(); }
  const conflict = await fixture(["<scriptPlan>合格新版</scriptPlan>"], { conflict: true, mode: "0", childTokens: 12000, parentTokens: 5000 });
  try {
    await assert.rejects(conflict.execute, /生成期间已被修改/);
    assert.equal(conflict.calls.streams.length, 1);
    assert.equal(conflict.calls.streams[0].maxOutputTokens, 5000);
    assert.equal(conflict.calls.outputs.length, 0);
    assert.equal(conflict.calls.commits.length, 0);
    assert.equal(JSON.parse((await conflict.db("o_agentWorkData").first()).data).scriptPlan, "人工新版本");
  } finally { await conflict.db.destroy(); }
});

test("分镜图子Agent保持单次执行，不套用导演XML校验和默认输出预算", async () => {
  const f = await fixture(["普通分镜图任务结果"]);
  try {
    assert.equal(await f.executeOther(), "普通分镜图任务结果");
    assert.equal(f.calls.streams.length, 1);
    assert.equal(f.calls.streams[0].maxOutputTokens, undefined);
    assert.equal(f.calls.commits.length, 0);
    assert.equal(f.calls.finished, 1);
    assert.deepEqual(JSON.parse((await f.db("o_agentWorkData").first()).data), f.original);
  } finally { await f.db.destroy(); }
});

test("停止或检查点写入失败时，合格候选与步骤产出在同一事务回滚", async () => {
  for (const options of [{ stopped: true }, { checkpointError: true }]) {
    const f = await fixture(["<scriptPlan>合格新版</scriptPlan>"], options);
    try {
      await assert.rejects(f.execute, /输出状态未能保存|checkpoint write failed/);
      assert.deepEqual(JSON.parse((await f.db("o_agentWorkData").first()).data), f.original);
      const checkpoint = await f.db("o_agentStep").where({ runId: "run", stepKey: "productionAgent:directorPlanAgent" }).first();
      assert.equal(checkpoint.output, null);
      assert.equal(f.calls.outputs.length, 0);
      assert.equal(f.calls.commits.length, 0);
      assert.equal(f.calls.finished, 0);
      assert.equal(f.calls.streams.length, 1);
    } finally { await f.db.destroy(); }
  }
});
