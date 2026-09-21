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
  mode: ("text" | "singleImage" | "startFrameOptional")[];
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
  mode: string;
  audio?: boolean;
};

type PollResult = { completed: boolean; data?: string; error?: string };

declare const exports: Record<string, any>;
declare const fetch: typeof globalThis.fetch;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;

const vendor: VendorConfig = {
  id: "comfyui_local",
  version: "1.0",
  author: "Local ComfyUI",
  name: "本机 ComfyUI（FLUX Schnell）",
  description: "调用本机 ComfyUI API 生成图像。默认使用已验证可用的 FLUX Schnell 工作流。",
  inputs: [
    { key: "baseUrl", label: "ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "checkpoint", label: "Checkpoint", type: "text", required: true, placeholder: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors" },
  ],
  inputValues: {
    baseUrl: "http://127.0.0.1:8188",
    checkpoint: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors",
  },
  models: [
    { name: "FLUX Schnell 本机", modelName: "flux-schnell-local", type: "image", mode: ["text"] },
    {
      name: "MiniMax H3（Comfy Cloud）",
      modelName: "MiniMax-H3-local",
      type: "video",
      mode: ["text", "startFrameOptional"],
      audio: true,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
  ],
};

const normalizedBaseUrl = () => vendor.inputValues.baseUrl.replace(/\/+$/, "");

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
  const baseUrl = normalizedBaseUrl();
  const prompt = {
    "1": { class_type: "ComfyCloudMiniMaxH3TextToVideoNode", inputs: {
      prompt: config.prompt, seed: Math.floor(Math.random() * 2147483647), aspect_ratio: config.aspectRatio,
      resolution: config.resolution || "480p", duration_seconds: Math.max(5, Math.min(15, Math.round(config.duration || 5))),
    } },
    "2": { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: "Toonflow/MiniMax-H3", format: "mp4", codec: "h264" } },
  };
  const createResponse = await fetch(baseUrl + "/prompt", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: "toonflow" }),
  });
  if (!createResponse.ok) throw new Error("ComfyUI 提交 H3 任务失败: " + await createResponse.text());
  const created = await createResponse.json();
  if (!created.prompt_id) throw new Error("ComfyUI 未返回 H3 任务 ID");
  const result = await pollTask(async () => {
    const response = await fetch(baseUrl + "/history/" + created.prompt_id);
    if (!response.ok) return { completed: true, error: "ComfyUI 查询 H3 任务失败: " + await response.text() };
    const history = await response.json();
    const task = history[created.prompt_id];
    if (!task) return { completed: false };
    if (task.status?.status_str !== "success") {
      const message = task.status?.messages?.find((item: any[]) => item[0] === "execution_error")?.[1]?.exception_message;
      return { completed: true, error: message || "ComfyUI H3 执行失败: " + (task.status?.status_str || "unknown") };
    }
    const output = task.outputs?.["2"];
    const file = output?.videos?.[0] || output?.gifs?.[0] || output?.images?.[0];
    if (!file?.filename) return { completed: true, error: "ComfyUI H3 完成但未找到视频输出" };
    return { completed: true, data: file.filename + "|" + (file.subfolder || "") + "|" + (file.type || "output") };
  }, 3000, 1800000);
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI H3 生成超时");
  const [filename, subfolder, type] = result.data.split("|");
  return baseUrl + "/view?filename=" + encodeURIComponent(filename) + "&subfolder=" + encodeURIComponent(subfolder) + "&type=" + encodeURIComponent(type);
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;

export {};
