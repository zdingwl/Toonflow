import db from "@/utils/db";

const DEFAULT_URL = "http://127.0.0.1:11435/rerank";

export type RerankerConfig = {
  enabled: boolean;
  url: string;
  model: string;
  candidateLimit: number;
};

export function parseRerankerConfig(rows: Array<{ key?: string | null; value?: string | null }>): RerankerConfig {
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const enabled = settings.get("memoryRerankerEnabled") === "1";
  const rawUrl = settings.get("memoryRerankerUrl") || DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Reranker 地址无效");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Reranker 只允许访问本机 HTTP 服务");
  }
  const model = settings.get("memoryRerankerModel") || "Qwen3-Reranker-4B";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error("Reranker 模型名无效");
  const configured = Number(settings.get("memoryRerankerCandidates") || "24");
  const candidateLimit = Number.isSafeInteger(configured) ? Math.min(100, Math.max(8, configured)) : 24;
  return { enabled, url: url.toString(), model, candidateLimit };
}

async function getConfig(): Promise<RerankerConfig> {
  const rows = await db("o_setting")
    .whereIn("key", ["memoryRerankerEnabled", "memoryRerankerUrl", "memoryRerankerModel", "memoryRerankerCandidates"])
    .select("key", "value");
  return parseRerankerConfig(rows);
}

export async function rerankRows<T extends { content: string }>(
  query: string,
  rows: T[],
  limit: number,
  fetcher: typeof fetch = fetch,
  configOverride?: RerankerConfig,
): Promise<T[]> {
  if (limit <= 0 || !rows.length) return [];
  const config = configOverride ?? await getConfig();
  if (!config.enabled || rows.length <= 1) return rows.slice(0, limit);

  const response = await fetcher(config.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: config.model,
      query,
      documents: rows.map((row) => row.content),
      top_n: Math.min(limit, rows.length),
      instruction: "Retrieve the memories that are most relevant to the user's current request.",
    }),
  });
  const body = await response.json() as {
    results?: Array<{ index?: number; score?: number }>;
    error?: string;
  };
  if (!response.ok || !Array.isArray(body.results)) {
    throw new Error(body.error || `Reranker HTTP ${response.status}`);
  }

  const selected: T[] = [];
  const seen = new Set<number>();
  for (const item of body.results) {
    const index = Number(item.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length || seen.has(index)) continue;
    seen.add(index);
    selected.push(rows[index]);
    if (selected.length >= limit) break;
  }
  return selected.length ? selected : rows.slice(0, limit);
}

export async function getRerankerCandidateLimit(requestedLimit: number): Promise<number> {
  const config = await getConfig();
  return config.enabled ? Math.max(requestedLimit, config.candidateLimit) : requestedLimit;
}
