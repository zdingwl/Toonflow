import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRerankerConfig, rerankRows } from "../src/utils/agent/retrieval/reranker";

test("Reranker 配置默认关闭且只允许本机 HTTP 地址", () => {
  assert.deepEqual(parseRerankerConfig([]), {
    enabled: false,
    url: "http://127.0.0.1:11435/rerank",
    model: "Qwen3-Reranker-4B",
    candidateLimit: 24,
  });
  assert.equal(parseRerankerConfig([{ key: "memoryRerankerEnabled", value: "1" }]).enabled, true);
  assert.throws(() => parseRerankerConfig([{ key: "memoryRerankerUrl", value: "https://example.com/rerank" }]), /本机/);
  assert.throws(() => parseRerankerConfig([{ key: "memoryRerankerUrl", value: "http://192.168.1.2:11435/rerank" }]), /本机/);
});

test("本地 Reranker 返回的索引顺序决定最终候选顺序", async () => {
  const rows = [{ content: "A" }, { content: "B" }, { content: "C" }];
  const config = {
    enabled: true,
    url: "http://127.0.0.1:11435/rerank",
    model: "Qwen3-Reranker-4B",
    candidateLimit: 24,
  };
  const fetcher = (async () => new Response(JSON.stringify({
    results: [{ index: 2, score: 9 }, { index: 0, score: 2 }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  assert.deepEqual(await rerankRows("query", rows, 2, fetcher, config), [rows[2], rows[0]]);
});

test("Reranker 返回无效索引时不会把候选清空", async () => {
  const rows = [{ content: "A" }, { content: "B" }];
  const config = {
    enabled: true,
    url: "http://127.0.0.1:11435/rerank",
    model: "Qwen3-Reranker-4B",
    candidateLimit: 24,
  };
  const fetcher = (async () => new Response(JSON.stringify({
    results: [{ index: 99, score: 1 }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  assert.deepEqual(await rerankRows("query", rows, 1, fetcher, config), [rows[0]]);
});
