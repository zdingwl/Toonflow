import { performance } from "node:perf_hooks";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key?.startsWith("--") || value === undefined) throw new Error("参数格式应为 --key value");
  args.set(key.slice(2), value);
}

const model = args.get("model") || "qwen3-embedding:4b";
const ollamaUrl = args.get("ollama") || "http://127.0.0.1:11434";
const rerankerUrl = args.get("reranker") || "http://127.0.0.1:11435/rerank";
const rounds = Math.max(3, Math.min(100, Number(args.get("rounds") || 12)));
const candidateCount = Math.max(8, Math.min(100, Number(args.get("candidates") || 24)));

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

async function embed(input) {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, input, truncate: false, keep_alive: "10m" }),
  });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body.embeddings) || !body.embeddings.length) {
    throw new Error(body.error || `Embedding HTTP ${response.status}`);
  }
  return body.embeddings;
}

const queries = [
  "查找当前项目角色设定与导演约束",
  "继续上一次未完成的分镜任务",
  "找出与场景连续性有关的历史决定",
  "检索角色名称、资产ID和对应描述",
  "回忆之前确认过的镜头时长规则",
  "查询项目文档中与视觉风格相关的要求",
];

const docs = Array.from({ length: candidateCount }, (_, index) => {
  const topic = queries[index % queries.length];
  return `候选文档 ${index + 1}。主题：${topic}。这是用于 Toonflow 本地检索性能测试的中文文本，包含项目规则、角色、分镜和工具调用信息。`;
});

await embed("Toonflow 本地 Embedding 预热");

const embeddingLatencies = [];
let dimension = 0;
for (let i = 0; i < rounds; i++) {
  const query = queries[i % queries.length];
  const { value, ms } = await timed(() => embed(`Instruct: Retrieve relevant memories that answer the user\'s question\nQuery:${query}`));
  dimension = value[0]?.length || dimension;
  embeddingLatencies.push(ms);
}

const batch = await timed(() => embed(docs));

let reranker = { enabled: false, latenciesMs: [], p50Ms: null, p95Ms: null, resultCount: 0 };
try {
  const health = await fetch(rerankerUrl.replace(/\/rerank\/?$/, "/health"), { signal: AbortSignal.timeout(10000) });
  if (health.ok) {
    const rerankLatencies = [];
    let resultCount = 0;
    for (let i = 0; i < Math.min(rounds, 12); i++) {
      const query = queries[i % queries.length];
      const { value, ms } = await timed(async () => {
        const response = await fetch(rerankerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(120000),
          body: JSON.stringify({
            model: "Qwen3-Reranker-4B",
            query,
            documents: docs,
            top_n: Math.min(5, docs.length),
            instruction: "Retrieve the memories that are most relevant to the user\'s current request.",
          }),
        });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.results)) throw new Error(body.error || `Reranker HTTP ${response.status}`);
        return body.results;
      });
      resultCount = value.length;
      rerankLatencies.push(ms);
    }
    reranker = {
      enabled: true,
      latenciesMs: rerankLatencies.map((value) => Math.round(value * 100) / 100),
      p50Ms: percentile(rerankLatencies, 50),
      p95Ms: percentile(rerankLatencies, 95),
      resultCount,
    };
  }
} catch (error) {
  reranker = {
    enabled: false,
    latenciesMs: [],
    p50Ms: null,
    p95Ms: null,
    resultCount: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}

console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  embedding: {
    backend: "ollama",
    model,
    dimension,
    rounds,
    singleQuery: {
      p50Ms: percentile(embeddingLatencies, 50),
      p95Ms: percentile(embeddingLatencies, 95),
      latenciesMs: embeddingLatencies.map((value) => Math.round(value * 100) / 100),
    },
    batch: {
      documents: docs.length,
      elapsedMs: Math.round(batch.ms * 100) / 100,
      docsPerSecond: Math.round((docs.length / (batch.ms / 1000)) * 100) / 100,
    },
  },
  reranker,
}, null, 2));