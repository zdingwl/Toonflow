type ImageModel = {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
};

type VideoModel = {
  name: string;
  modelName: string;
  type: "video";
  mode: (
    | "text"
    | "singleImage"
    | "startFrameOptional"
    | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]
  )[];
  audio: "optional" | boolean;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
};

type VendorConfig = {
  id: string;
  version: string;
  author: string;
  name: string;
  description: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (ImageModel | VideoModel)[];
};

type ImageConfig = {
  prompt: string;
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
};

type VideoConfig = {
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  mode: string | string[];
  audio?: boolean;
  referenceList?: { type: "image" | "video" | "audio"; base64: string }[];
};

type PollResult = { completed: boolean; data?: string; error?: string };

declare const exports: Record<string, any>;
declare const fetch: typeof globalThis.fetch;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;

const vendor: VendorConfig = {
  id: "comfyui_local",
  version: "1.0",
  author: "Local ComfyUI",
  name: "本机 ComfyUI（FLUX + MiniMax H3）",
  description: "调用本机 ComfyUI 生成图片，并通过本机 DramaClaw 网关运行 MiniMax H3 视频工作流，支持最多 9 张参考图。",
  inputs: [
    { key: "baseUrl", label: "ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "checkpoint", label: "Checkpoint", type: "text", required: true, placeholder: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors" },
    { key: "gatewayUrl", label: "DramaClaw 网关地址", type: "url", required: true, placeholder: "http://127.0.0.1:3000/v1" },
    { key: "gatewayApiKey", label: "DramaClaw API Key", type: "password", required: true },
  ],
  inputValues: {
    baseUrl: "http://127.0.0.1:8188",
    checkpoint: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors",
    gatewayUrl: "http://127.0.0.1:3000/v1",
    gatewayApiKey: "",
  },
  models: [
    { name: "FLUX Schnell 本机", modelName: "flux-schnell-local", type: "image", mode: ["text"] },
    {
      name: "MiniMax H3 本机（多图参考）",
      modelName: "MiniMax-H3-local",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: true,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
  ],
};

const normalizedBaseUrl = () => vendor.inputValues.baseUrl.replace(/\/+$/, "");
const normalizedGatewayUrl = () => vendor.inputValues.gatewayUrl.replace(/\/+$/, "");

function dimensions(aspectRatio: string): { width: number; height: number } {
  const [rawWidth, rawHeight] = aspectRatio.split(":").map(Number);
  if (!rawWidth || !rawHeight) return { width: 1024, height: 1024 };
  const landscape = rawWidth >= rawHeight;
  const longSide = 1024;
  const shortSide = Math.max(512, Math.round((longSide * Math.min(rawWidth, rawHeight)) / Math.max(rawWidth, rawHeight) / 8) * 8);
  return landscape ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
}

const textRequest = () => {
  throw new Error("本机 ComfyUI 供应商只提供图像模型");
};

const imageRequest = async (config: ImageConfig, _model: ImageModel): Promise<string> => {
  const baseUrl = normalizedBaseUrl();
  const { width, height } = dimensions(config.aspectRatio);
  const prompt = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: vendor.inputValues.checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: config.prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, text, watermark", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], seed: Math.floor(Math.random() * 2147483647), steps: 4, cfg: 1,
        sampler_name: "euler", scheduler: "simple", positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], denoise: 1,
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "Toonflow" } },
  };
  const createResponse = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: "toonflow" }),
  });
  if (!createResponse.ok) throw new Error(`ComfyUI 提交失败: ${await createResponse.text()}`);
  const created = await createResponse.json();
  if (!created.prompt_id) throw new Error("ComfyUI 未返回任务 ID");

  const result = await pollTask(async () => {
    const historyResponse = await fetch(`${baseUrl}/history/${created.prompt_id}`);
    if (!historyResponse.ok) return { completed: true, error: `ComfyUI 查询失败: ${await historyResponse.text()}` };
    const history = await historyResponse.json();
    const task = history[created.prompt_id];
    if (!task) return { completed: false };
    if (task.status?.status_str !== "success") return { completed: true, error: `ComfyUI 执行失败: ${task.status?.status_str || "unknown"}` };
    const image = task.outputs?.["7"]?.images?.[0];
    if (!image?.filename) return { completed: true, error: "ComfyUI 执行完成但未找到图片输出" };
    return { completed: true, data: image.filename + "|" + (image.subfolder || "") + "|" + (image.type || "output") };
  }, 1500, 600000);
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI 生成超时");
  const [filename, subfolder, type] = result.data.split("|");
  return `${baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
};

const videoRequest = async (config: VideoConfig, _model: VideoModel): Promise<string> => {
  const gatewayUrl = normalizedGatewayUrl();
  const apiKey = vendor.inputValues.gatewayApiKey.replace(/^Bearer\s+/i, "").trim();
  if (!gatewayUrl) throw new Error("缺少 DramaClaw 网关地址");
  if (!apiKey) throw new Error("缺少 DramaClaw API Key");

  const references = config.referenceList ?? [];
  const imageRefs = references.filter((item) => item.type === "image").map((item) => item.base64).filter(Boolean);
  const videoRefs = references.filter((item) => item.type === "video").map((item) => item.base64).filter(Boolean);
  const audioRefs = references.filter((item) => item.type === "audio").map((item) => item.base64).filter(Boolean);
  if (imageRefs.length > 9) throw new Error("MiniMax H3 最多支持 9 张参考图");
  if (videoRefs.length > 3) throw new Error("MiniMax H3 最多支持 3 个参考视频");
  if (audioRefs.length > 3) throw new Error("MiniMax H3 最多支持 3 个参考音频");

  const isMultiReference = Array.isArray(config.mode);
  const metadata: Record<string, any> = {
    ratio: config.aspectRatio,
    resolution: config.resolution || "480p",
    generate_audio: config.audio ?? true,
  };
  const body: Record<string, any> = {
    model: "MiniMax-H3-local",
    prompt: config.prompt,
    duration: Math.max(5, Math.min(15, Math.round(config.duration || 5))),
    metadata,
  };

  if (isMultiReference) {
    if (!imageRefs.length && !videoRefs.length && !audioRefs.length) throw new Error("多参考模式至少需要一个参考素材");
    if (imageRefs.length) metadata.reference_images = imageRefs;
    if (videoRefs.length) metadata.reference_videos = videoRefs;
    if (audioRefs.length) metadata.reference_audios = audioRefs;
  } else if (config.mode === "startFrameOptional" || config.mode === "singleImage") {
    if (imageRefs[0]) body.image = imageRefs[0];
  }

  const createResponse = await fetch(gatewayUrl + "/video/generations", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!createResponse.ok) throw new Error("DramaClaw 提交 H3 任务失败: " + await createResponse.text());
  const created = await createResponse.json();
  const taskId = created.task_id || created.id;
  if (!taskId) throw new Error("DramaClaw 未返回 H3 任务 ID");
  const result = await pollTask(async () => {
    const response = await fetch(gatewayUrl + "/video/generations/" + encodeURIComponent(taskId), {
      headers: { Authorization: "Bearer " + apiKey },
    });
    if (!response.ok) return { completed: true, error: "DramaClaw 查询 H3 任务失败: " + await response.text() };
    const task = await response.json();
    if (task.status === "succeeded") {
      const url = task.result_url || task.results?.find((item: any) => item.type === "video")?.url || task.url;
      return url ? { completed: true, data: url } : { completed: true, error: "H3 已完成但没有返回视频地址" };
    }
    if (task.status === "failed" || task.status === "cancelled") {
      return { completed: true, error: task.error?.message || "MiniMax H3 任务失败" };
    }
    return { completed: false };
  }, 3000, 1800000);
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI H3 生成超时");
  return result.data;
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;

export {};
