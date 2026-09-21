import { cosineSimilarity } from "@/utils/agent/embedding";

export type VectorCandidate = {
  id?: string | null;
  embedding?: string | null;
  [key: string]: any;
};

export class VectorTopK<T extends VectorCandidate> {
  private readonly entries = new Map<string, T & { similarity: number }>();

  constructor(
    private readonly queryEmbedding: number[],
    private readonly limit: number,
    private readonly lexicalIds = new Set<string>(),
  ) {}

  add(rows: T[]): void {
    if (this.limit <= 0) return;
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      let embedding: number[] = [];
      try {
        embedding = JSON.parse(row.embedding ?? "[]");
      } catch {}
      const valid = embedding.length === this.queryEmbedding.length && embedding.every(Number.isFinite);
      const lexical = this.lexicalIds.has(id);
      const similarity = valid
        ? cosineSimilarity(this.queryEmbedding, embedding) + (lexical ? 0.08 : 0)
        : lexical
          ? 0.08
          : Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(similarity)) continue;
      const prior = this.entries.get(id);
      if (!prior || similarity > prior.similarity) this.entries.set(id, { ...row, similarity });
    }
    if (this.entries.size > this.limit * 3) this.trim();
  }

  private trim(): void {
    const keep = [...this.entries.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.limit);
    this.entries.clear();
    for (const item of keep) this.entries.set(String(item.id), item);
  }

  values(): Array<T & { similarity: number }> {
    this.trim();
    return [...this.entries.values()].sort((a, b) => b.similarity - a.similarity).slice(0, this.limit);
  }
}
