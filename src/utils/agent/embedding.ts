import { pipeline, env as transformersEnv, FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import fs from "fs";
import getPath from "@/utils/getPath";
import db from "@/utils/db";
import { parseEmbeddingBackend, parseEmbeddingConfig } from "./embeddingConfig";
import { embedWithOllama, getOllamaModelDigest } from "./retrieval/ollamaEmbedding";

let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<void> | null = null;
let loadedModelId: string | null = null;
let activeBackend: "onnx" | "ollama" | null = null;
let ollamaModel: string | null = null;

export async function initEmbedding(): Promise<void> {
  if (loadedModelId) return;
  if (!loading) {
    loading = (async () => {
      const rows = await db("o_setting").whereIn("key", ["modelOnnxFile", "modelDtype", "embeddingBackend", "ollamaEmbeddingModel"]).select("key", "value");
      const selected = parseEmbeddingBackend(rows);
      if (selected.backend === "ollama") {
        const digest = await getOllamaModelDigest(selected.model);
        activeBackend = "ollama";
        ollamaModel = selected.model;
        loadedModelId = `ollama:${selected.model}:${digest}`;
        return;
      }
      const { modelOnnxFile, modelDtype } = parseEmbeddingConfig(rows);
      const onnxPath = path.join(getPath("models"), ...modelOnnxFile);
      if (!fs.existsSync(onnxPath)) throw new Error(`Embedding 模型文件不存在: ${onnxPath}`);
      transformersEnv.allowRemoteModels = false;
      transformersEnv.allowLocalModels = true;
      transformersEnv.localModelPath = getPath("models").replace(/\\/g, "/") + "/";
      // @ts-ignore - pipeline 重载联合类型过于复杂
      extractor = await pipeline("feature-extraction", modelOnnxFile[0], { dtype: modelDtype });
      loadedModelId = `${modelOnnxFile.join("/")}:${modelDtype}`;
      activeBackend = "onnx";
    })().finally(() => {
      loading = null;
    });
  }
  await loading;
}

export async function getEmbedding(text: string, purpose: "document" | "query" = "document"): Promise<number[]> {
  if (!loadedModelId) await initEmbedding();
  if (activeBackend === "ollama") {
    return embedWithOllama(ollamaModel!, text, purpose);
  }
  const output = await extractor!(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function getEmbeddingModelId(): Promise<string> {
  if (!loadedModelId) await initEmbedding();
  if (!loadedModelId) throw new Error("Embedding 模型尚未加载");
  return loadedModelId;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((dot, v, i) => dot + v * b[i], 0);
}

export async function disposeEmbedding(): Promise<void> {
  if (loading) await loading;
  await extractor?.dispose?.();
  extractor = null;
  loadedModelId = null;
  activeBackend = null;
  ollamaModel = null;
}
