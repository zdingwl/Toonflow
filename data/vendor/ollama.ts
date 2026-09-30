/** 本机 Ollama 文本模型，使用兼容接口保留流式输出和工具调用。 */
interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

declare const createOpenAICompatible: any;
declare const exports: Record<string, any>;

const vendor = {
  id: "ollama",
  version: "2.0",
  author: "Toonflow",
  name: "Ollama 本地模型",
  description: "通过本机 Ollama 运行 Qwen3.8-27B，无需 API 密钥。请先启动 Ollama；模型名称须与 ollama list 一致。可在智能体配置中选择此模型。",
  icon: "",
  inputs: [
    { key: "baseUrl", label: "Ollama 地址", type: "url", required: true, placeholder: "http://127.0.0.1:11434/v1" },
    { key: "apiKey", label: "API 密钥（可选）", type: "password", required: false },
  ],
  inputValues: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "" },
  models: [
    { name: "Qwen3.8-27B 本机", modelName: "QWEN3.8:27b", type: "text", think: true },
  ],
};

const textRequest = (model: TextModel, think = model.think, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
  const address = vendor.inputValues.baseUrl.trim().replace(/\/+$/, "");
  if (!address) throw new Error("请填写 Ollama 地址");
  const baseURL = address.endsWith("/v1") ? address : `${address}/v1`;
  const apiKey = vendor.inputValues.apiKey.trim().replace(/^Bearer\s+/i, "");
  // Ollama 的兼容接口使用 reasoning_effort；原生接口的 think 字段在这里不生效。
  const reasoningEffort = think ? (["medium", "low", "medium", "high"][thinkLevel] ?? "medium") : "none";
  return createOpenAICompatible({
    name: "ollama",
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    includeUsage: true,
    fetch: (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return fetch(url, {
        ...init,
        body: JSON.stringify({ ...body, reasoning_effort: reasoningEffort }),
      });
    },
  }).chatModel(model.modelName);
};

const unsupported = async (): Promise<string> => {
  throw new Error("此供应商用于文本生成，请选择对应的图片、视频或配音供应商");
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = unsupported;
exports.videoRequest = unsupported;
exports.ttsRequest = unsupported;
export {};
