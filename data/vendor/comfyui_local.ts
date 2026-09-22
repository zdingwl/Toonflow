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
  mode: ("text" | "singleImage" | "startFrameOptional" | (`imageReference:${number}`)[])[];
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

type ImageConfig = { prompt: string; size: "1K" | "2K" | "4K"; aspectRatio: `${number}:${number}` };
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
type InputTarget = { node: string; input: string };
type WorkflowMapping = {
  prompt: InputTarget;
  images?: InputTarget[];
  frames?: InputTarget & { fps: number };
  duration?: InputTarget;
  width?: InputTarget;
  height?: InputTarget;
  outputNode?: string;
};

declare const exports: Record<string, any>;
declare const fetch: typeof globalThis.fetch;
declare const axios: any;
declare const FormData: any;
declare const Buffer: any;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;

const vendor: VendorConfig = {
  id: "comfyui_local",
  version: "1.1",
  author: "Local ComfyUI",
  name: "本机 ComfyUI（FLUX + MiniMax H3）",
  description: "图片走 ComfyUI；视频默认使用已导出的 ComfyUI API 工作流。旧 DramaClaw 网关仍可选择使用。视频工作流及节点映射需按实际节点配置。",
  inputs: [
    { key: "baseUrl", label: "ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "checkpoint", label: "Checkpoint", type: "text", required: true, placeholder: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors" },
    { key: "videoBackend", label: "视频后端（comfyui 或 gateway）", type: "text", required: true, placeholder: "comfyui" },
    { key: "workflowApi", label: "视频工作流 API JSON（压缩为单行粘贴）", type: "text", required: false, placeholder: "ComfyUI 导出的 API 格式 JSON" },
    { key: "workflowMapping", label: "视频节点映射 JSON", type: "text", required: false, placeholder: "按实际工作流填写 prompt/images/frames/outputNode" },
    { key: "gatewayUrl", label: "DramaClaw 网关地址（仅 gateway 模式）", type: "url", required: false, placeholder: "http://127.0.0.1:3000/v1" },
    { key: "gatewayApiKey", label: "DramaClaw API Key（仅 gateway 模式）", type: "password", required: false },
  ],
  inputValues: {
    baseUrl: "http://127.0.0.1:8188",
    checkpoint: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors",
    videoBackend: "comfyui",
    workflowApi: "",
    workflowMapping: "",
    gatewayUrl: "http://127.0.0.1:3000/v1",
    gatewayApiKey: "",
  },
  models: [
    { name: "FLUX Schnell 本机", modelName: "flux-schnell-local", type: "image", mode: ["text"] },
    {
      name: "MiniMax H3 本机（多图参考）",
      modelName: "MiniMax-H3-local",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9"]],
      audio: false,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
  ],
};

const normalizedBaseUrl = () => vendor.inputValues.baseUrl.replace(/\/+$/, "");
const normalizedGatewayUrl = () => (vendor.inputValues.gatewayUrl || "").replace(/\/+$/, "");

function dimensions(aspectRatio: string): { width: number; height: number } {
  const [rawWidth, rawHeight] = aspectRatio.split(":").map(Number);
  if (!rawWidth || !rawHeight) return { width: 1024, height: 1024 };
  const landscape = rawWidth >= rawHeight;
  const longSide = 1024;
  const shortSide = Math.max(512, Math.round((longSide * Math.min(rawWidth, rawHeight)) / Math.max(rawWidth, rawHeight) / 8) * 8);
  return landscape ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
}

const textRequest = () => {
  throw new Error("本机 ComfyUI 供应商不提供文本模型");
};

// 保留原有 FLUX 图片生成逻辑，不让视频后端设置影响图片工作流。
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
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI 图片生成超时");
  const [filename, subfolder, type] = result.data.split("|");
  return `${baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
};

function configuredWorkflow(): { prompt: Record<string, any>; mapping: WorkflowMapping } {
  const workflowText = vendor.inputValues.workflowApi?.trim();
  const mappingText = vendor.inputValues.workflowMapping?.trim();
  if (!workflowText || !mappingText) {
    throw new Error("ComfyUI 视频未配置：请在供应商设置中填写实际视频工作流的 API JSON 和节点映射 JSON；不需要启动 DramaClaw。");
  }
  let parsed: any;
  let mapping: WorkflowMapping;
  try {
    parsed = JSON.parse(workflowText);
    mapping = JSON.parse(mappingText);
  } catch {
    throw new Error("ComfyUI 视频配置不是有效 JSON：请使用 API 格式工作流和正确的节点映射。");
  }
  const prompt = parsed?.prompt ?? parsed;
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt) ||
      !Object.values(prompt).some((node: any) => node && typeof node.class_type === "string" && node.inputs)) {
    throw new Error("ComfyUI 视频工作流必须是 API 格式（包含节点 class_type 和 inputs），不能直接粘贴普通画布 JSON。");
  }
  if (!mapping || !mapping.prompt || !Array.isArray(mapping.images ?? []) ||
      (mapping.images ?? []).length > 9) {
    throw new Error("ComfyUI 节点映射格式错误：必须提供 prompt:{node,input}，images 为最多 9 个 {node,input} 的数组。");
  }
  return { prompt, mapping };
}

function setNodeInput(workflow: Record<string, any>, target: InputTarget, value: unknown, label: string) {
  const nodeId = String(target?.node ?? "");
  const inputName = target?.input;
  const node = workflow[nodeId];
  if (!node || !node.inputs || !inputName || !Object.prototype.hasOwnProperty.call(node.inputs, inputName)) {
    throw new Error(`ComfyUI 视频节点映射错误：${label} 对应的节点 ${nodeId} 或输入 ${String(inputName)} 不存在`);
  }
  node.inputs[inputName] = value;
}

function videoDimensions(resolution: string, ratio: string) {
  const shortSide = Number.parseInt(resolution, 10);
  if (!Number.isFinite(shortSide) || shortSide <= 0) throw new Error(`不支持的视频分辨率 ${resolution}`);
  const [a, b] = ratio.split(":").map(Number);
  if (!a || !b) throw new Error(`无效视频比例 ${ratio}`);
  const even = (value: number) => Math.max(8, Math.round(value / 8) * 8);
  return a >= b ? { width: even(shortSide * a / b), height: even(shortSide) }
                : { width: even(shortSide), height: even(shortSide * b / a) };
}

function requestError(action: string, error: any): Error {
  const reason = error?.cause?.code || error?.code || error?.message || String(error);
  const status = error?.response?.status ? ` (HTTP ${error.response.status})` : "";
  return new Error(`ComfyUI ${action}失败：${reason}${status}；地址 ${normalizedBaseUrl()}。请检查 8188 端口及 ComfyUI 控制台日志。`);
}

async function uploadReferenceImage(base64: string, index: number): Promise<string> {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(base64);
  if (!match) throw new Error(`参考图 ${index + 1} 不是支持的 PNG/JPEG/WebP Data URL`);
  const extension = match[1].toLowerCase() === "image/jpeg" ? "jpg" : match[1].split("/")[1].toLowerCase();
  const image = Buffer.from(match[2], "base64");
  if (!image.length) throw new Error(`参考图 ${index + 1} 数据为空`);
  const form = new FormData();
  form.append("image", image, {
    filename: `toonflow_ref_${Date.now()}_${index}_${Math.floor(Math.random() * 1e9)}.${extension}`,
    contentType: match[1].toLowerCase(),
  });
  form.append("type", "input");
  try {
    const response = await axios.post(`${normalizedBaseUrl()}/upload/image`, form, {
      headers: form.getHeaders(), timeout: 60000, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    if (!response.data?.name) throw new Error("ComfyUI 上传成功但没有返回文件名");
    return response.data.name;
  } catch (error) {
    throw requestError(`上传第 ${index + 1} 张参考图`, error);
  }
}

function findVideoOutput(task: any, outputNode?: string): { filename: string; subfolder?: string; type?: string } | null {
  const outputs = task?.outputs || {};
  if (outputNode && !outputs[outputNode]) throw new Error(`ComfyUI 已执行完成，但指定的输出节点 ${outputNode} 没有输出；请核对节点映射`);
  const selected: any[] = outputNode ? [outputs[outputNode]] : Object.values(outputs);
  for (const output of selected) {
    for (const key of ["videos", "gifs", "files", "images"]) {
      for (const file of (Array.isArray(output?.[key]) ? output[key] : [])) {
        if (typeof file?.filename === "string" && /\.(mp4|webm|mov|mkv)$/i.test(file.filename)) return file;
      }
    }
  }
  return null;
}

async function comfyVideoRequest(config: VideoConfig): Promise<string> {
  const { prompt: workflow, mapping } = configuredWorkflow();
  // 从配置原件深拷贝；不能让上一条视频任务修改下一条任务的节点输入。
  const nodes = JSON.parse(JSON.stringify(workflow)) as Record<string, any>;
  const references = config.referenceList ?? [];
  if (references.some((ref) => ref.type !== "image")) {
    throw new Error("ComfyUI 直连当前仅支持参考图片；参考视频或音频需先在实际工作流中配置对应输入节点。");
  }
  const imageRefs = references.filter((ref) => ref.type === "image");
  const imageTargets = mapping.images ?? [];
  if (imageRefs.length > imageTargets.length) {
    throw new Error(`当前 ComfyUI 工作流仅映射 ${imageTargets.length} 张参考图，但 Toonflow 传入 ${imageRefs.length} 张；请补充实际工作流节点映射。`);
  }
  if (config.audio) throw new Error("当前 ComfyUI 直连工作流未配置音频生成，请在 Toonflow 选择不生成音频。");
  setNodeInput(nodes, mapping.prompt, config.prompt, "prompt");
  if (mapping.duration) setNodeInput(nodes, mapping.duration, config.duration, "duration");
  if (mapping.frames) {
    const fps = Number(mapping.frames.fps);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error("frames 节点映射必须指定正数 fps（工作流实际帧率）");
    setNodeInput(nodes, mapping.frames, Math.max(1, Math.round(config.duration * fps)), "frames");
  }
  if (mapping.width || mapping.height) {
    const { width, height } = videoDimensions(config.resolution, config.aspectRatio);
    if (mapping.width) setNodeInput(nodes, mapping.width, width, "width");
    if (mapping.height) setNodeInput(nodes, mapping.height, height, "height");
  }
  for (let i = 0; i < imageRefs.length; i++) {
    const filename = await uploadReferenceImage(imageRefs[i].base64, i);
    setNodeInput(nodes, imageTargets[i], filename, `image ${i + 1}`);
  }
  let promptId: string;
  try {
    const response = await axios.post(`${normalizedBaseUrl()}/prompt`, { prompt: nodes, client_id: "toonflow-video" }, { timeout: 60000 });
    promptId = response.data?.prompt_id;
    if (!promptId) throw new Error(`ComfyUI 未返回任务 ID：${JSON.stringify(response.data?.error || response.data?.node_errors || {})}`);
  } catch (error) {
    throw requestError("提交视频工作流", error);
  }
  const result = await pollTask(async () => {
    let task: any;
    try {
      const response = await axios.get(`${normalizedBaseUrl()}/history/${encodeURIComponent(promptId)}`, { timeout: 20000 });
      task = response.data?.[promptId];
    } catch (error) {
      throw requestError("查询视频任务", error);
    }
    if (!task) return { completed: false };
    if (task.status?.status_str === "error" || task.status?.status_str === "failed") {
      return { completed: true, error: `ComfyUI 工作流执行失败，请检查 ComfyUI 控制台：${JSON.stringify(task.status?.messages || [])}` };
    }
    if (task.status?.status_str !== "success") return { completed: false };
    const file = findVideoOutput(task, mapping.outputNode);
    if (!file) return { completed: true, error: "ComfyUI 执行成功但没有找到 MP4/WebM/MOV/MKV 输出。请检查 SaveVideo 节点及 outputNode 映射；自定义节点返回结构可能需要单独适配。" };
    const url = `${normalizedBaseUrl()}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder || "")}&type=${encodeURIComponent(file.type || "output")}`;
    return { completed: true, data: url };
  }, 3000, 1800000);
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI 视频工作流等待超时（30 分钟）");
  return result.data;
}

// 原 DramaClaw 路径保留为显式回退选项，不再默认把本地工作流发到未启动的 3000 端口。
async function gatewayVideoRequest(config: VideoConfig): Promise<string> {
  const gatewayUrl = normalizedGatewayUrl();
  const apiKey = (vendor.inputValues.gatewayApiKey || "").replace(/^Bearer\s+/i, "").trim();
  if (!gatewayUrl) throw new Error("缺少 DramaClaw 网关地址");
  if (!apiKey) throw new Error("缺少 DramaClaw API Key");
  const references = config.referenceList ?? [];
  const imageRefs = references.filter((item) => item.type === "image").map((item) => item.base64).filter(Boolean);
  const videoRefs = references.filter((item) => item.type === "video").map((item) => item.base64).filter(Boolean);
  const audioRefs = references.filter((item) => item.type === "audio").map((item) => item.base64).filter(Boolean);
  if (imageRefs.length > 9 || videoRefs.length > 3 || audioRefs.length > 3) throw new Error("DramaClaw 参考素材数量超过限制");
  const metadata: Record<string, any> = { ratio: config.aspectRatio, resolution: config.resolution || "480p", generate_audio: config.audio ?? true };
  const body: Record<string, any> = { model: "MiniMax-H3-local", prompt: config.prompt, duration: Math.max(5, Math.min(15, Math.round(config.duration || 5))), metadata };
  if (Array.isArray(config.mode)) {
    if (!imageRefs.length && !videoRefs.length && !audioRefs.length) throw new Error("多参考模式至少需要一个参考素材");
    if (imageRefs.length) metadata.reference_images = imageRefs;
    if (videoRefs.length) metadata.reference_videos = videoRefs;
    if (audioRefs.length) metadata.reference_audios = audioRefs;
  } else if (config.mode === "startFrameOptional" || config.mode === "singleImage") {
    if (imageRefs[0]) body.image = imageRefs[0];
  }
  let created: any;
  try {
    const response = await axios.post(`${gatewayUrl}/video/generations`, body, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 60000,
    });
    created = response.data;
  } catch (error: any) {
    throw new Error(`DramaClaw 提交视频任务失败：${error?.code || error?.message || String(error)}；地址 ${gatewayUrl}`);
  }
  const taskId = created.task_id || created.id;
  if (!taskId) throw new Error("DramaClaw 未返回 H3 任务 ID");
  const result = await pollTask(async () => {
    const response = await axios.get(`${gatewayUrl}/video/generations/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }, timeout: 20000,
    });
    const task = response.data;
    if (task.status === "succeeded") {
      const url = task.result_url || task.results?.find((item: any) => item.type === "video")?.url || task.url;
      return url ? { completed: true, data: url } : { completed: true, error: "H3 已完成但没有返回视频地址" };
    }
    if (task.status === "failed" || task.status === "cancelled") return { completed: true, error: task.error?.message || "MiniMax H3 任务失败" };
    return { completed: false };
  }, 3000, 1800000);
  if (result.error || !result.data) throw new Error(result.error || "DramaClaw H3 生成超时");
  return result.data;
}

const videoRequest = async (config: VideoConfig, _model: VideoModel): Promise<string> => {
  const backend = (vendor.inputValues.videoBackend || "comfyui").trim().toLowerCase();
  if (backend === "comfyui") return comfyVideoRequest(config);
  if (backend === "gateway") return gatewayVideoRequest(config);
  throw new Error(`未知视频后端 ${backend}；仅支持 comfyui 或 gateway`);
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;

export {};
