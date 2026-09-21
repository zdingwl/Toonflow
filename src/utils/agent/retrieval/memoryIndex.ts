import db from "@/utils/db";
import { getEmbedding, getEmbeddingModelId } from "@/utils/agent/embedding";
import { searchTerms } from "./terms";

let worker: Promise<void> | null = null;

export async function indexMemoryTerms(memoryId: string, isolationKey: string, content: string): Promise<void> {
  const terms = searchTerms(content);
  if (!terms.length) return;
  await db("o_memoryTerm").insert(terms.map((term) => ({ memoryId, isolationKey, term }))).onConflict().ignore();
}

export async function queueMemoryVector(memoryId: string, modelId: string): Promise<void> {
  await db("o_memoryJob").insert({
    id: `${modelId}:${memoryId}`, memoryId, modelId, status: "pending", retryAt: 0, updateTime: Date.now(),
  }).onConflict().ignore();
  // 已完成的任务若缺失向量，重新入队；用于恢复不完整的旧索引。
  const vector = await db("o_memoryVector").where({ memoryId, modelId }).first();
  if (!vector) await db("o_memoryJob").where({ id: `${modelId}:${memoryId}`, status: "completed" })
    .update({ status: "pending", retryAt: 0, updateTime: Date.now() });
}

export async function queueMissingVectors(isolationKey: string, modelId: string, limit = 30): Promise<void> {
  const rows = await db("memories")
    .leftJoin("o_memoryVector", function () {
      this.on("memories.id", "=", "o_memoryVector.memoryId").andOnVal("o_memoryVector.modelId", "=", modelId);
    })
    .where("memories.isolationKey", isolationKey)
    .whereNull("o_memoryVector.memoryId")
    .select("memories.id")
    .limit(limit);
  for (const row of rows) if (row.id) await queueMemoryVector(row.id, modelId);
}

export function startMemoryIndex(): void {
  if (worker) return;
  worker = (async () => {
    const modelId = await getEmbeddingModelId();
    for (;;) {
      const jobs = await db("o_memoryJob").where({ status: "pending", modelId }).where("retryAt", "<=", Date.now()).orderBy("updateTime", "asc").limit(10);
      if (!jobs.length) break;
      for (const job of jobs) {
      const claimed = await db("o_memoryJob").where({ id: job.id, status: "pending" }).update({ status: "running", updateTime: Date.now() });
      if (claimed !== 1) continue;
      try {
        const memory = await db("memories").where({ id: job.memoryId }).first();
        if (!memory?.id || !memory.isolationKey || memory.content == null) throw new Error("原始记忆不存在或字段不完整");
        await indexMemoryTerms(memory.id, memory.isolationKey, memory.content);
        const embedding = await getEmbedding(memory.content);
        if (!embedding.length || !embedding.every(Number.isFinite)) throw new Error("Embedding 返回无效向量");
        await db("o_memoryVector").insert({
          memoryId: memory.id, modelId, embedding: JSON.stringify(embedding), dimension: embedding.length, createTime: Date.now(),
        }).onConflict().ignore();
        await db("o_memoryJob").where({ id: job.id }).update({ status: "completed", error: null, updateTime: Date.now() });
      } catch (error) {
        const attempts = Number(job.attempts ?? 0) + 1;
        await db("o_memoryJob").where({ id: job.id }).update({
          status: "pending", attempts, retryAt: Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)),
          error: error instanceof Error ? error.message : String(error), updateTime: Date.now(),
        });
      }
      }
    }
  })().catch((error) => {
    console.error("[memoryIndex]", error instanceof Error ? error.message : error);
  }).finally(() => {
    worker = null;
  });
}

export async function lexicalCandidates(isolationKey: string, query: string, limit = 100): Promise<string[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const rows = await db("o_memoryTerm").where({ isolationKey }).whereIn("term", terms)
    .select("memoryId").count({ matches: "*" }).groupBy("memoryId").orderBy("matches", "desc").limit(limit);
  return rows.map((row) => row.memoryId).filter((id): id is string => typeof id === "string");
}
