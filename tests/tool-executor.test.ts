import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { wrapAgentTools } from "../src/utils/agent/runtime/toolExecutor";

async function makeDb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_agentToolCall", (t) => {
    t.text("id").primary(); t.text("runId"); t.text("stepKey"); t.text("toolName"); t.text("operationKey").unique();
    t.text("inputHash"); t.text("inputJson"); t.text("outputJson"); t.integer("sideEffect");
    t.text("status"); t.text("error"); t.integer("createTime"); t.integer("updateTime");
  });
  return db;
}

test("只读工具记录每次调用，写工具对同一输入复用已完成结果", async () => {
  const db = await makeDb();
  try {
    let reads = 0;
    let writes = 0;
    const tools = wrapAgentTools(
      {
        read: { execute: async ({ id }: any) => ({ id, n: ++reads }) },
        write: { execute: async ({ id }: any) => ({ id, n: ++writes }) },
      },
      { db, runId: "run-1", sideEffectTools: ["write"] },
    );
    assert.deepEqual(await tools.read.execute!({ id: 1 }), { id: 1, n: 1 });
    assert.deepEqual(await tools.read.execute!({ id: 1 }), { id: 1, n: 2 });
    assert.deepEqual(await tools.write.execute!({ id: 2 }), { id: 2, n: 1 });
    assert.deepEqual(await tools.write.execute!({ id: 2 }), { id: 2, n: 1 });
    assert.equal(writes, 1);
    const rows = await db("o_agentToolCall").orderBy("createTime");
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((row) => row.status === "completed").length, 3);
  } finally {
    await db.destroy();
  }
});

test("可能产生副作用的失败写操作进入待核对状态且禁止自动重试", async () => {
  const db = await makeDb();
  try {
    let attempts = 0;
    const tools = wrapAgentTools(
      {
        mutate: {
          execute: async () => {
            attempts++;
            throw new Error("连接在写入回执前断开");
          },
        },
      },
      { db, runId: "run-2", sideEffectTools: ["mutate"] },
    );
    await assert.rejects(() => tools.mutate.execute!({ id: 1 }), /回执前断开/);
    await assert.rejects(() => tools.mutate.execute!({ id: 1 }), /必须先核对结果/);
    assert.equal(attempts, 1);
    const row = await db("o_agentToolCall").first();
    assert.equal(row.status, "reconciling");
  } finally {
    await db.destroy();
  }
});


test("核对为 retryable 的写工具可以再次执行并复用同一操作记录", async () => {
  const db = await makeDb();
  try {
    let attempts = 0;
    const wrapped = wrapAgentTools(
      {
        mutate: {
          execute: async () => ({ attempt: ++attempts }),
        },
      },
      { db, runId: "run-3", stepKey: "step-1", sideEffectTools: ["mutate"] },
    );
    await db("o_agentToolCall").insert({
      id: "call-1", runId: "run-3", stepKey: "step-1", toolName: "mutate",
      operationKey: "placeholder", inputHash: "placeholder", inputJson: "{}", sideEffect: 1,
      status: "retryable", createTime: Date.now(), updateTime: Date.now(),
    });
    // 使用真实 operationKey 触发 retryable 路径。
    await db("o_agentToolCall").where({ id: "call-1" }).del();
    const first = wrapAgentTools(
      {
        mutate: {
          execute: async () => {
            attempts++;
            throw new Error("第一次失败");
          },
        },
      },
      { db, runId: "run-3", stepKey: "step-1", sideEffectTools: ["mutate"] },
    );
    await assert.rejects(() => first.mutate.execute!({ id: 9 }), /第一次失败/);
    const prior = await db("o_agentToolCall").first();
    await db("o_agentToolCall").where({ id: prior.id }).update({ status: "retryable", error: null });
    assert.deepEqual(await wrapped.mutate.execute!({ id: 9 }), { attempt: 2 });
    const rows = await db("o_agentToolCall");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "completed");
  } finally {
    await db.destroy();
  }
});


test("相同写入参数在不同步骤中不会被错误去重", async () => {
  const db = await makeDb();
  try {
    let writes = 0;
    const definition = { write: { execute: async () => ({ n: ++writes }) } };
    const first = wrapAgentTools(definition, { db, runId: "run-step", stepKey: "step-a", sideEffectTools: ["write"] });
    const second = wrapAgentTools(definition, { db, runId: "run-step", stepKey: "step-b", sideEffectTools: ["write"] });
    assert.deepEqual(await first.write.execute!({ id: 1 }), { n: 1 });
    assert.deepEqual(await second.write.execute!({ id: 1 }), { n: 2 });
    assert.equal((await db("o_agentToolCall")).length, 2);
  } finally {
    await db.destroy();
  }
});


test("需要业务回执的写工具会获得稳定 requestId 并写入追踪输入", async () => {
  const db = await makeDb();
  try {
    const tools = wrapAgentTools(
      {
        add_flowData_storyboard: {
          execute: async (input: any) => ({ requestId: input.requestId }),
        },
      },
      { db, runId: "run-request", stepKey: "step-request", sideEffectTools: ["add_flowData_storyboard"] },
    );
    const first = await tools.add_flowData_storyboard.execute!({ videoDesc: "镜头" });
    assert.match(first.requestId, /^agent_[a-f0-9]{32}$/);
    const row = await db("o_agentToolCall").first();
    const stored = JSON.parse(row.inputJson);
    assert.equal(stored.requestId, first.requestId);

    const second = await tools.add_flowData_storyboard.execute!({ videoDesc: "镜头" });
    assert.equal(second.requestId, first.requestId);
    assert.equal((await db("o_agentToolCall")).length, 1);
  } finally {
    await db.destroy();
  }
});


test("生成工具的 ID 顺序不影响幂等键和稳定 requestId", async () => {
  const db = await makeDb();
  try {
    let calls = 0;
    const definition = {
      generate_storyboard: {
        execute: async (input: any) => ({ requestId: input.requestId, ids: input.ids, call: ++calls }),
      },
    };
    const wrapped = wrapAgentTools(definition, {
      db,
      runId: "run-order",
      stepKey: "step-order",
      sideEffectTools: ["generate_storyboard"],
    });
    const first = await wrapped.generate_storyboard.execute!({ ids: [3, 1, 2, 2] });
    const second = await wrapped.generate_storyboard.execute!({ ids: [2, 3, 1] });
    assert.deepEqual(first.ids, [1, 2, 3]);
    assert.equal(second.requestId, first.requestId);
    assert.equal(second.call, 1);
    assert.equal(calls, 1);
  } finally {
    await db.destroy();
  }
});
