import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoryPrompt } from "../src/utils/agent/contextManager";

test("历史记忆受预算限制，近期消息优先保留", () => {
  const memory = {
    shortTerm: [{ role: "user", content: "最新约束" }, { role: "assistant", content: "最新答复" }],
    summaries: [{ content: "旧摘要".repeat(1000) }],
    rag: [{ content: "旧召回".repeat(1000) }],
  };
  const prompt = buildMemoryPrompt(memory, 500);
  assert.ok(prompt.includes("最新约束"));
  assert.ok(prompt.includes("最新答复"));
  assert.ok(prompt.length <= 500);
  assert.ok(!prompt.includes("旧摘要"));
});
