const OLLAMA_URL = "http://127.0.0.1:11434";

export async function getOllamaModelDigest(model: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Ollama 模型查询失败: HTTP ${response.status}`);
  const tags = await response.json() as { models?: Array<{ name?: string; digest?: string }> };
  const installed = tags.models?.find((item) => item.name === model);
  if (!installed?.digest) throw new Error(`本地 Ollama 模型未安装: ${model}`);
  return installed.digest;
}

export async function embedWithOllama(model: string, text: string, purpose: "document" | "query", fetcher: typeof fetch = fetch): Promise<number[]> {
  const input = purpose === "query" ? `Instruct: Retrieve relevant memories that answer the user's question\nQuery:${text}` : text;
  const response = await fetcher(`${OLLAMA_URL}/api/embed`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, input, truncate: false, keep_alive: "1m" }),
  });
  const body = await response.json() as { embeddings?: number[][]; error?: string };
  if (!response.ok || !Array.isArray(body.embeddings?.[0])) throw new Error(body.error || `Ollama Embedding 失败: HTTP ${response.status}`);
  const vector = body.embeddings[0];
  if (!vector.length || !vector.every(Number.isFinite)) throw new Error("Ollama 返回无效向量");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Ollama 返回零向量");
  return vector.map((value) => value / norm);
}
