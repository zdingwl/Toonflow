import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import {
  getOperationReceipt,
  operationInputHash,
  operationReceiptId,
  withOperationReceipt,
} from "../src/utils/agent/runtime/operationReceipt";

test("操作回执使用稳定哈希和负数确定性 ID", () => {
  assert.equal(operationInputHash({ b: 2, a: 1 }), operationInputHash({ a: 1, b: 2 }));
  assert.equal(operationReceiptId("asset-generate", "request_1234"), operationReceiptId("asset-generate", "request_1234"));
  assert.ok(operationReceiptId("asset-generate", "request_1234") < 0);
});

test("相同 requestId 的操作只执行一次，不同输入会被拒绝", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_agentWorkData", (table) => {
      table.integer("id").primary();
      table.integer("projectId");
      table.integer("episodesId");
      table.string("key");
      table.text("data");
      table.integer("createTime");
      table.integer("updateTime");
    });
    let creates = 0;
    const scope = { projectId: 3, episodesId: 9 };
    const first = await withOperationReceipt(db, scope, "asset-generate", "request_1234", { ids: [1, 2] }, async () => {
      creates++;
      return { ids: [1, 2] };
    });
    const second = await withOperationReceipt(db, scope, "asset-generate", "request_1234", { ids: [1, 2] }, async () => {
      creates++;
      return { ids: [1, 2] };
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(creates, 1);
    assert.deepEqual((await getOperationReceipt(db, scope, "asset-generate", "request_1234"))?.data, { ids: [1, 2] });
    await assert.rejects(
      () => withOperationReceipt(db, scope, "asset-generate", "request_1234", { ids: [2, 3] }, async () => ({ ids: [2, 3] })),
      /不同操作内容/,
    );
  } finally {
    await db.destroy();
  }
});
