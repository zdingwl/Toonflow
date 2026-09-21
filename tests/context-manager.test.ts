import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoryPrompt, estimateTokens } from "../src/utils/agent/contextManager";

test("历史记忆受 Token 预算限制，近期消息优先保留", () => {
  const memory = {
    shortTerm: [{ role: "user", content: "最新约束" }, { role: "assistant", content: "最新答复" }],
    summaries: [{ content: "旧摘要".repeat(1000) }],
    rag: [{ content: "旧召回".repeat(1000) }],
  };
  const prompt = buildMemoryPrompt(memory, 120);
  assert.ok(prompt.includes("最新约束"));
  assert.ok(prompt.includes("最新答复"));
  assert.ok(estimateTokens(prompt) <= 120);
  assert.ok(!prompt.includes("旧摘要".repeat(20)));
});

test("超长近期消息会在预算内裁剪而不是导致整个近期窗口为空", () => {
  const prompt = buildMemoryPrompt({
    shortTerm: [{ role: "user", content: "这是很重要的近期约束。".repeat(1000) }],
    summaries: [],
    rag: [],
  }, 160);
  assert.ok(prompt.includes("这是很重要的近期约束"));
  assert.ok(prompt.includes("…"));
  assert.ok(estimateTokens(prompt) <= 160);
});

test("中英文 Token 估算用于预算保护且不会返回零", () => {
  assert.ok(estimateTokens("中文上下文") >= 4);
  assert.ok(estimateTokens("hello world") >= 1);
  assert.equal(estimateTokens(""), 0);
});
