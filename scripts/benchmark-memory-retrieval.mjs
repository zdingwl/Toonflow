import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { pipeline, env } from "@huggingface/transformers";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const projectId = Number(process.argv[2]);
if (!Number.isSafeInteger(projectId)) throw new Error("用法: node scripts/benchmark-memory-retrieval.mjs <projectId>");
const db = new Database("data/db2.sqlite", { readonly: true });
const scripts = db.prepare("select id, name, content from o_script where projectId = ? order by id").all(projectId)
  .map((item) => ({ ...item, text: `${item.name}\n${item.content.slice(0, 900)}` }));
db.close();
if (scripts.length < 10) throw new Error("项目剧本不足 10 集，无法进行此基准测试");

const cases = [
  [1, "艾娃重生三天后疯狂囤货升级木筏，妹妹推她下海"],
  [2, "麦迪逊拔刀威胁，科尔失控，艾娃兑换疫苗删除记忆"],
  [3, "失忆的艾娃遇见假装救援队长的科尔"],
  [16, "海洋之主与女儿艾娃对决"],
  [20, "研究所发现母亲留下的遗产和秘密"],
  [30, "最终封印后两界之主宣告第二季天空之上"],
].filter(([id]) => scripts.some((item) => item.id === id));

function normalize(vector) {
  const norm = Math.hypot(...vector);
  if (!norm || !Number.isFinite(norm)) throw new Error("Embedding 返回无效向量");
  return Array.from(vector, (value) => value / norm);
}
function evaluate(documents, queries) {
  let hits = 0, reciprocalRank = 0;
  const ranks = [];
  for (let i = 0; i < cases.length; i++) {
    const scores = documents.map((doc, j) => ({ id: scripts[j].id, score: queries[i].reduce((sum, value, k) => sum + value * doc[k], 0) }));
    scores.sort((a, b) => b.score - a.score);
    const rank = scores.findIndex((item) => item.id === cases[i][0]) + 1;
    ranks.push(rank);
    if (rank <= 5) hits++;
    reciprocalRank += 1 / rank;
  }
  return { recallAt5: hits / cases.length, mrr: reciprocalRank / cases.length, ranks };
}

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "./data/models/";
const minilmStart = performance.now();
const minilm = await pipeline("feature-extraction", "all-MiniLM-L6-v2", { dtype: "fp16" });
const minilmDocs = [];
for (const item of scripts) minilmDocs.push(normalize((await minilm(item.text, { pooling: "mean", normalize: true })).data));
const minilmQueries = [];
for (const [, query] of cases) minilmQueries.push(normalize((await minilm(query, { pooling: "mean", normalize: true })).data));
const minilmMs = Math.round(performance.now() - minilmStart);
await minilm.dispose();

const qwenStart = performance.now();
const inputs = [
  ...scripts.map((item) => item.text),
  ...cases.map(([, query]) => `Instruct: Retrieve relevant memories that answer the user's question\nQuery:${query}`),
];
const response = await fetch("http://127.0.0.1:11434/api/embed", {
  method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(300000),
  body: JSON.stringify({ model: "qwen3-embedding:4b", input: inputs, truncate: false, keep_alive: "1m" }),
});
const body = await response.json();
if (!response.ok || body.embeddings?.length !== inputs.length) throw new Error(body.error || `Qwen3 Embedding HTTP ${response.status}`);
const qwenVectors = body.embeddings.map(normalize);
const qwenMs = Math.round(performance.now() - qwenStart);

console.log(JSON.stringify({ corpus: scripts.length, questions: cases.length,
  miniLM: { ...evaluate(minilmDocs, minilmQueries), elapsedMs: minilmMs },
  qwen3Embedding4b: { ...evaluate(qwenVectors.slice(0, scripts.length), qwenVectors.slice(scripts.length)), elapsedMs: qwenMs },
}, null, 2));
