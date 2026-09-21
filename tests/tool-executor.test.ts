import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { wrapAgentTools } from "../src/utils/agent/runtime/toolExecutor";

async function makeDb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_agentToolCall", (t) => {
    t.text("id").primary(); t.text("runId"); t.text("toolName"); t.text("operationKey").unique();
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
