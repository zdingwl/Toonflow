import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore } from "../src/utils/agent/runtime/taskStore";

test("任务状态与步骤持久化，重复请求不能重复执行或更换内容", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_agentRun", (t) => {
      t.text("id").primary(); t.text("agentType"); t.integer("projectId"); t.integer("episodesId");
      t.text("isolationKey"); t.text("inputHash"); t.text("status"); t.text("error");
      t.integer("createTime"); t.integer("updateTime");
    });
    await db.schema.createTable("o_agentStep", (t) => {
      t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("status");
      t.text("resultRef"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
      t.unique(["runId", "stepKey"]);
    });
    await db.schema.createTable("o_agentSkillSnapshot", (t) => {
      t.text("runId"); t.text("filePath"); t.text("contentHash"); t.text("content"); t.integer("createTime");
      t.primary(["runId", "filePath"]);
    });
    const store = new TaskStore(db);
    const input = { requestId: "request-001", agentType: "productionAgent" as const, projectId: 3, episodesId: 5, isolationKey: "3:productionAgent:5", content: "生成导演计划" };
    assert.deepEqual(await store.begin(input), { id: "request-001", status: "running", duplicate: false });
    assert.deepEqual(await store.begin(input), { id: "request-001", status: "running", duplicate: true });
    await assert.rejects(() => store.begin({ ...input, content: "另一个任务" }), /不同任务内容/);
    await store.startStep("request-001", "directorPlan:1");
    await assert.rejects(() => store.startStep("request-001", "directorPlan:1"), /不能重复调用/);
    await store.finishStep("request-001", "directorPlan:1", "project=3,episode=5");
    await store.finish("request-001", "completed");
    assert.deepEqual(await store.reconcile("request-001"), {
      status: "completed", steps: [{ stepKey: "directorPlan:1", status: "completed", resultRef: "project=3,episode=5" }],
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
