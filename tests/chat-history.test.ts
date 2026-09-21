import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { AgentChatHistoryStore } from "../src/utils/agent/chatHistory";

async function makeDb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_agentChatMessage", (table) => {
    table.text("id").primary();
    table.text("isolationKey").notNullable();
    table.text("role").notNullable();
    table.text("name");
    table.text("status").notNullable();
    table.text("datetime").notNullable();
    table.text("contentJson").notNullable();
    table.text("extJson");
    table.integer("createTime").notNullable();
    table.integer("updateTime").notNullable();
  });
  return db;
}

test("结构化聊天历史保留思考卡片、文本与消息完成状态", async () => {
  const db = await makeDb();
  try {
    const store = new AgentChatHistoryStore(db, "1:productionAgent:2");
    store.recordMessage({
      id: "assistant-1",
      role: "assistant",
      name: "执行导演",
      status: "pending",
      datetime: "2026-09-21T19:45:00.000Z",
      content: [],
    });
    store.recordContentAdd("assistant-1", {
      id: "thinking-1",
      type: "thinking",
      data: { title: "正在获取剧本内容...", text: "" },
      status: "pending",
    });
    store.recordContentUpdate({
      messageId: "assistant-1",
      contentId: "thinking-1",
      type: "thinking",
      data: { title: "获取剧本内容完成", text: "读取成功" },
      strategy: "merge",
      status: "complete",
    });
    store.recordContentAdd("assistant-1", {
      id: "xml-1",
      type: "text",
      data: "",
      status: "pending",
    });
    store.recordContentUpdate({
      messageId: "assistant-1",
      contentId: "xml-1",
      type: "text",
      data: "<scriptPlan>导演计划正文</scriptPlan>",
      strategy: "append",
      status: "streaming",
    });
    store.recordContentUpdate({
      messageId: "assistant-1",
      contentId: "xml-1",
      type: "text",
      status: "complete",
    });
    store.recordContentAdd("assistant-1", {
      id: "commit-1",
      type: "text",
      data: "",
      status: "pending",
    });
    store.recordContentUpdate({
      messageId: "assistant-1",
      contentId: "commit-1",
      type: "text",
      data: "导演计划已保存到工作区。",
      strategy: "append",
      status: "complete",
    });
    store.recordMessageUpdate("assistant-1", { status: "complete" });

    await store.flush();
    const rows = await store.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "complete");
    assert.equal(rows[0].name, "执行导演");
    assert.equal(rows[0].content.length, 3);
    assert.deepEqual((rows[0].content[0] as any).data, { title: "获取剧本内容完成", text: "读取成功" });
    assert.equal((rows[0].content[1] as any).data, "<scriptPlan>导演计划正文</scriptPlan>");
    assert.equal((rows[0].content[2] as any).data, "导演计划已保存到工作区。");
  } finally {
    await db.destroy();
  }
});

test("结构化聊天历史按 isolationKey 隔离", async () => {
  const db = await makeDb();
  try {
    const first = new AgentChatHistoryStore(db, "1:productionAgent:2");
    const second = new AgentChatHistoryStore(db, "1:productionAgent:3");
    first.recordMessage({
      id: "m1",
      role: "user",
      status: "complete",
      datetime: "2026-09-21T19:45:00.000Z",
      content: [{ id: "t1", type: "text", data: "第一集", status: "complete" }],
    });
    second.recordMessage({
      id: "m2",
      role: "user",
      status: "complete",
      datetime: "2026-09-21T19:45:01.000Z",
      content: [{ id: "t2", type: "text", data: "第二集", status: "complete" }],
    });
    await Promise.all([first.flush(), second.flush()]);
    assert.deepEqual((await first.list()).map((item) => item.id), ["m1"]);
    assert.deepEqual((await second.list()).map((item) => item.id), ["m2"]);
  } finally {
    await db.destroy();
  }
});
