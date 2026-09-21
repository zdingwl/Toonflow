import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEmbeddingBackend, parseEmbeddingConfig } from "../src/utils/agent/embeddingConfig";

test("Embedding 配置按数据库 key/value 行读取并拒绝无效路径", () => {
  const settings = parseEmbeddingConfig([
    { key: "modelOnnxFile", value: JSON.stringify(["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"]) },
    { key: "modelDtype", value: "fp16" },
  ]);
  assert.deepEqual(settings, { modelOnnxFile: ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"], modelDtype: "fp16" });
  assert.throws(() => parseEmbeddingConfig([{ key: "modelOnnxFile", value: JSON.stringify(["..", "onnx", "model_fp16.onnx"]) }]));
  assert.equal(parseEmbeddingConfig([{ key: "modelDtype", value: "q4f16" }]).modelDtype, "q4f16");
  assert.equal(parseEmbeddingConfig([{ key: "modelDtype", value: "auto" }]).modelDtype, "auto");
  assert.throws(() => parseEmbeddingConfig([{ key: "modelDtype", value: "invalid" }]));
});

test("Ollama Embedding 仅接受本地后端与有效模型名", () => {
  assert.deepEqual(parseEmbeddingBackend([]), { backend: "onnx", model: "qwen3-embedding:4b" });
  assert.deepEqual(parseEmbeddingBackend([{ key: "embeddingBackend", value: "ollama" }]), { backend: "ollama", model: "qwen3-embedding:4b" });
  assert.throws(() => parseEmbeddingBackend([{ key: "embeddingBackend", value: "remote" }]));
  assert.throws(() => parseEmbeddingBackend([{ key: "ollamaEmbeddingModel", value: "../../../bad" }]));
});
