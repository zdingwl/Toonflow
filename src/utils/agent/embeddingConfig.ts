export function parseEmbeddingConfig(rows: Array<{ key?: string | null; value?: string | null }>) {
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const rawPath = settings.get("modelOnnxFile");
  const modelOnnxFile: unknown = rawPath ? JSON.parse(rawPath) : ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"];
  if (
    !Array.isArray(modelOnnxFile) ||
    modelOnnxFile.length !== 3 ||
    !modelOnnxFile.every((part) => typeof part === "string" && part.length > 0 && part !== "." && part !== ".." && !/[\\/]/.test(part)) ||
    modelOnnxFile[1] !== "onnx" ||
    !modelOnnxFile[2].endsWith(".onnx")
  ) {
    throw new Error("Embedding 模型路径配置无效");
  }
  const modelDtype = settings.get("modelDtype") || "fp16";
  if (!["fp32", "fp16", "q8", "q4"].includes(modelDtype)) throw new Error(`Embedding 量化类型无效: ${modelDtype}`);
  return { modelOnnxFile: modelOnnxFile as [string, "onnx", string], modelDtype };
}

export function parseEmbeddingBackend(rows: Array<{ key?: string | null; value?: string | null }>) {
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const backend = settings.get("embeddingBackend") || "onnx";
  if (backend !== "onnx" && backend !== "ollama") throw new Error("Embedding 后端配置无效");
  const model = settings.get("ollamaEmbeddingModel") || "qwen3-embedding:4b";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error("Ollama Embedding 模型名无效");
  return { backend, model };
}
