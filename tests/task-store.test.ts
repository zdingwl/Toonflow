import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore } from "../src/utils/agent/runtime/taskStore";

test("任务状态、步骤缓存与恢复持久化，重复请求不能重复执行或更换内容", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_agentRun", (t) => {
      t.text("id").primary(); t.text("agentType"); t.integer("projectId"); t.integer("episodesId");
      t.text("isolationKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("error");
      t.integer("createTime"); t.integer("updateTime");
    });
    await db.schema.createTable("o_agentStep", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("inputHash"); t.text("inputContent"); t.text("output"); t.text("status");
      t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
      t.unique(["runId", "stepKey"]);
    });
    await db.schema.createTable("o_agentSkillSnapshot", (t) => {
      t.text("runId"); t.text("filePath"); t.text("contentHash"); t.text("content"); t.integer("createTime");
      t.primary(["runId", "filePath"]);
    });
    await db.schema.createTable("o_agentToolCall", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("toolName"); t.text("operationKey");
      t.text("inputHash"); t.text("inputJson"); t.text("outputJson"); t.integer("sideEffect");
      t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
    });
    const store = new TaskStore(db);
    const input = { requestId: "request-001", agentType: "productionAgent" as const, projectId: 3, episodesId: 5, isolationKey: "3:productionAgent:5", content: "生成导演计划" };
    assert.deepEqual(await store.begin(input), { id: "request-001", status: "running", duplicate: false });
    assert.deepEqual(await store.begin(input), { id: "request-001", status: "running", duplicate: true });
    await assert.rejects(() => store.begin({ ...input, content: "另一个任务" }), /不同任务内容/);

    const stepInput = JSON.stringify({ prompt: "生成导演计划" });
    const stepKey = TaskStore.makeStepKey("productionAgent:directorPlanAgent", stepInput);
    assert.deepEqual(await store.beginStep("request-001", stepKey, stepInput), { cached: false });
    await store.saveStepOutput("request-001", stepKey, "<scriptPlan>计划A</scriptPlan>");
    await store.finishStep("request-001", stepKey, "directorPlan:3:5");
    assert.deepEqual(await store.beginStep("request-001", stepKey, stepInput), {
      cached: true,
      output: "<scriptPlan>计划A</scriptPlan>",
      resultRef: "directorPlan:3:5",
    });

    await store.finish("request-001", "reconciling", "模拟连接中断");
    const resumed = await store.resume("request-001", {
      agentType: "productionAgent", projectId: 3, episodesId: 5, isolationKey: "3:productionAgent:5",
    });
    assert.deepEqual(resumed, { id: "request-001", content: "生成导演计划" });
    await store.finish("request-001", "completed");
    assert.deepEqual(await store.reconcile("request-001"), {
      status: "completed",
      steps: [{
        stepKey,
        status: "completed",
        resultRef: "directorPlan:3:5",
        output: "<scriptPlan>计划A</scriptPlan>",
        error: undefined,
      }],
      toolCalls: [],
    });
    assert.equal((await store.begin(input)).status, "completed");

    const skillFile = path.join(os.tmpdir(), `toonflow-skill-${randomUUID()}.md`);
    try {
      await writeFile(skillFile, "旧版规则");
      assert.equal(await store.readSkill("request-001", skillFile), "旧版规则");
      await writeFile(skillFile, "新版规则");
      assert.equal(await store.readSkill("request-001", skillFile), "旧版规则");
    } finally {
      await unlink(skillFile);
    }
  } finally {
    await db.destroy();
  }
});

test("存在待核对步骤时拒绝自动恢复", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_agentRun", (t) => {
      t.text("id").primary(); t.text("agentType"); t.integer("projectId"); t.integer("episodesId");
      t.text("isolationKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("error");
      t.integer("createTime"); t.integer("updateTime");
    });
    await db.schema.createTable("o_agentStep", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("inputHash"); t.text("inputContent"); t.text("output"); t.text("status");
      t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
      t.unique(["runId", "stepKey"]);
    });
    await db.schema.createTable("o_agentSkillSnapshot", (t) => {
      t.text("runId"); t.text("filePath"); t.text("contentHash"); t.text("content"); t.integer("createTime");
      t.primary(["runId", "filePath"]);
    });
    await db.schema.createTable("o_agentToolCall", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("toolName"); t.text("operationKey");
      t.text("inputHash"); t.text("inputJson"); t.text("outputJson"); t.integer("sideEffect");
      t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
    });
    const store = new TaskStore(db);
    const input = { requestId: "request-002", agentType: "scriptAgent" as const, projectId: 8, isolationKey: "8:scriptAgent", content: "生成剧本" };
    await store.begin(input);
    const stepKey = TaskStore.makeStepKey("scriptAgent:scriptAgent", "episode-1");
    await store.beginStep("request-002", stepKey, "episode-1");
    await store.markStepReconciling("request-002", stepKey, "连接中断");
    await store.finish("request-002", "reconciling", "连接中断");
    await assert.rejects(
      () => store.resume("request-002", { agentType: "scriptAgent", projectId: 8, isolationKey: "8:scriptAgent" }),
      /需要核对/,
    );
    await store.resolveStep("request-002", stepKey, "retryable");
    assert.deepEqual(
      await store.resume("request-002", { agentType: "scriptAgent", projectId: 8, isolationKey: "8:scriptAgent" }),
      { id: "request-002", content: "生成剧本" },
    );
    assert.deepEqual(await store.beginStep("request-002", stepKey, "episode-1"), { cached: false });
  } finally {
    await db.destroy();
  }
});


test("存在 retryable 步骤时不能把任务误标为 completed", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_agentRun", (t) => {
      t.text("id").primary(); t.text("agentType"); t.integer("projectId"); t.integer("episodesId");
      t.text("isolationKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("error");
      t.integer("createTime"); t.integer("updateTime");
    });
    await db.schema.createTable("o_agentStep", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("inputHash"); t.text("inputContent"); t.text("output"); t.text("status");
      t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
      t.unique(["runId", "stepKey"]);
    });
    await db.schema.createTable("o_agentSkillSnapshot", (t) => {
      t.text("runId"); t.text("filePath"); t.text("contentHash"); t.text("content"); t.integer("createTime");
      t.primary(["runId", "filePath"]);
    });
    await db.schema.createTable("o_agentToolCall", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("toolName"); t.text("operationKey");
      t.text("inputHash"); t.text("inputJson"); t.text("outputJson"); t.integer("sideEffect");
      t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
    });
    const store = new TaskStore(db);
    await store.begin({ requestId: "request-003", agentType: "scriptAgent", projectId: 9, isolationKey: "9:scriptAgent", content: "继续剧本" });
    const stepKey = TaskStore.makeStepKey("scriptAgent:scriptAgent", "episode-2");
    await store.beginStep("request-003", stepKey, "episode-2");
    await store.markStepReconciling("request-003", stepKey, "中断");
    await store.resolveStep("request-003", stepKey, "retryable");
    await assert.rejects(() => store.finish("request-003", "completed"), /不能标记完成/);
  } finally {
    await db.destroy();
  }
});


test("步骤存在未核对写工具时不能标记完成", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_agentRun", (t) => {
      t.text("id").primary(); t.text("agentType"); t.integer("projectId"); t.integer("episodesId");
      t.text("isolationKey"); t.text("inputHash"); t.text("inputContent"); t.text("status"); t.text("error");
      t.integer("createTime"); t.integer("updateTime");
    });
    await db.schema.createTable("o_agentStep", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("inputHash"); t.text("inputContent"); t.text("output"); t.text("status");
      t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
      t.unique(["runId", "stepKey"]);
    });
    await db.schema.createTable("o_agentSkillSnapshot", (t) => {
      t.text("runId"); t.text("filePath"); t.text("contentHash"); t.text("content"); t.integer("createTime");
      t.primary(["runId", "filePath"]);
    });
    await db.schema.createTable("o_agentToolCall", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("toolName"); t.text("operationKey");
      t.text("inputHash"); t.text("inputJson"); t.text("outputJson"); t.integer("sideEffect");
      t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
    });
    const store = new TaskStore(db);
    await store.begin({
      requestId: "request-004",
      agentType: "productionAgent",
      projectId: 1,
      episodesId: 2,
      isolationKey: "1:productionAgent:2",
      content: "生成分镜",
    });
    const stepKey = TaskStore.makeStepKey("productionAgent:storyboardPanelAgent", "x");
    await store.beginStep("request-004", stepKey, "x");
    await db("o_agentToolCall").insert({
      id: "call-1",
      runId: "request-004",
      stepKey,
      toolName: "add_flowData_storyboard",
      operationKey: "op",
      inputHash: "hash",
      inputJson: "{}",
      sideEffect: 1,
      status: "reconciling",
      createTime: Date.now(),
      updateTime: Date.now(),
    });
    await assert.rejects(() => store.finishStep("request-004", stepKey, "message:x"), /写工具调用未核对/);
  } finally {
    await db.destroy();
  }
});
