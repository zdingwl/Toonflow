type ImageModel = {
  name: string; modelName: string; type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
};
type VideoModel = {
  name: string; modelName: string; type: "video";
  mode: ("text" | "singleImage" | "startFrameOptional" | (`imageReference:${number}`)[])[];
  audio: "optional" | boolean;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
};
type VideoConfig = {
  prompt: string; duration: number; resolution: string; aspectRatio: string;
  mode: string | string[]; audio?: boolean;
  referenceList?: { type: "image" | "video" | "audio"; base64: string; label?: string; prompt?: string; sourceType?: string; assetType?: string }[];
};
type InputTarget = { node: string; input: string };
type WorkflowMapping = {
  prompt: InputTarget; images?: InputTarget[];
  frames?: InputTarget & { fps: number }; duration?: InputTarget;
  width?: InputTarget; height?: InputTarget; outputNode?: string;
};
declare const exports: Record<string, any>;
declare const fetch: typeof globalThis.fetch;
declare const axios: any;
declare const FormData: any;
declare const Buffer: any;
declare const pollTask: (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>, interval?: number, timeout?: number) => Promise<{ completed: boolean; data?: string; error?: string }>;

const vendor = {
  id: "comfyui_local", version: "1.6", author: "Local ComfyUI",
  name: "本机 ComfyUI（FLUX + MiniMax H3）",
  description: "FLUX 图片走 ComfyUI；MiniMax H3 视频直连原生 Ref2VA/FL2VA。角色/场景/道具资产作为 <Picture N>，分镜图仅作文本构图指导，避免覆盖人物身份。",
  inputs: [
    { key: "baseUrl", label: "ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "checkpoint", label: "FLUX Checkpoint", type: "text", required: true, placeholder: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors" },
    { key: "videoBackend", label: "视频后端（comfyui 或 gateway）", type: "text", required: true, placeholder: "comfyui" },
    { key: "h3Unet", label: "H3 FL2VA 模型文件名", type: "text", required: false, placeholder: "minimax_h3_fl2va_pruned_int8_convrot.safetensors" },
    { key: "h3RefUnet", label: "H3 Ref2VA 模型文件名", type: "text", required: false, placeholder: "minimax_h3_ref2va_pruned_int8_convrot.safetensors" },
    { key: "h3Clip", label: "H3 文本编码器文件名", type: "text", required: false, placeholder: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" },
    { key: "h3VideoVae", label: "H3 视频 VAE 文件名", type: "text", required: false, placeholder: "minimax_h3_video_vae_fp16.safetensors" },
    { key: "h3AudioVae", label: "H3 音频 VAE 文件名", type: "text", required: false, placeholder: "minimax_h3_audio_vae_fp32.safetensors" },
    { key: "h3Steps", label: "H3 无参考图采样步数", type: "text", required: false, placeholder: "20" },
    { key: "h3RefLora", label: "H3 Ref2VA 加速 LoRA", type: "text", required: false, placeholder: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors" },
    { key: "h3RefLoraStrength", label: "H3 Ref2VA LoRA 强度", type: "text", required: false, placeholder: "1.0" },
    { key: "h3RefSteps", label: "H3 Ref2VA 采样步数", type: "text", required: false, placeholder: "4" },
    { key: "workflowApi", label: "自定义视频工作流 API JSON（可选）", type: "text", required: false, placeholder: "留空自动使用原生 H3 节点图" },
    { key: "workflowMapping", label: "自定义工作流节点映射 JSON（可选）", type: "text", required: false, placeholder: "仅在使用自定义工作流时填写" },
    { key: "gatewayUrl", label: "DramaClaw 网关地址（仅 gateway 模式）", type: "url", required: false, placeholder: "http://127.0.0.1:3000/v1" },
    { key: "gatewayApiKey", label: "DramaClaw API Key（仅 gateway 模式）", type: "password", required: false },
  ],
  inputValues: {
    baseUrl: "http://127.0.0.1:8188", checkpoint: "Flux\\flux1-schnell-fp8-with_clip_vae.safetensors",
    videoBackend: "comfyui", h3Unet: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    h3RefUnet: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    h3Clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    h3VideoVae: "minimax_h3_video_vae_fp16.safetensors",
    h3AudioVae: "minimax_h3_audio_vae_fp32.safetensors", h3Steps: "20",
    h3RefLora: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    h3RefLoraStrength: "1.0", h3RefSteps: "4",
    workflowApi: "", workflowMapping: "", gatewayUrl: "http://127.0.0.1:3000/v1", gatewayApiKey: "",
  } as Record<string, string>,
  models: [
    { name: "FLUX Schnell 本机", modelName: "flux-schnell-local", type: "image" as const, mode: ["text"] },
    {
      name: "MiniMax H3 本机（多图参考）", modelName: "MiniMax-H3-local", type: "video" as const,
      mode: ["text", "startFrameOptional", ["imageReference:9"]], audio: "optional" as const,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
  ],
};

const baseUrl = () => (vendor.inputValues.baseUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
const gatewayUrl = () => (vendor.inputValues.gatewayUrl || "").replace(/\/+$/, "");
const setting = (name: string, fallback: string) => (vendor.inputValues[name] || "").trim() || fallback;

function dimensions(ratio: string): { width: number; height: number } {
  const [a, b] = ratio.split(":").map(Number);
  if (!a || !b) return { width: 1024, height: 1024 };
  const shortSide = Math.max(512, Math.round(1024 * Math.min(a, b) / Math.max(a, b) / 8) * 8);
  return a >= b ? { width: 1024, height: shortSide } : { width: shortSide, height: 1024 };
}
const textRequest = () => { throw new Error("本机 ComfyUI 供应商不提供文本模型"); };

// Preserve the existing FLUX image workflow and its model identifier.
const imageRequest = async (config: { prompt: string; aspectRatio: string }, _model: ImageModel): Promise<string> => {
  const { width, height } = dimensions(config.aspectRatio);
  const prompt = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: vendor.inputValues.checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: config.prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, text, watermark", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": { class_type: "KSampler", inputs: {
      model: ["1", 0], seed: Math.floor(Math.random() * 2147483647), steps: 4, cfg: 1,
      sampler_name: "euler", scheduler: "simple", positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], denoise: 1,
    } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "Toonflow" } },
  };
  const response = await fetch(`${baseUrl()}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, client_id: "toonflow" }) });
  if (!response.ok) throw new Error(`ComfyUI 提交图片失败: ${await response.text()}`);
  const created = await response.json();
  if (!created.prompt_id) throw new Error("ComfyUI 未返回图片任务 ID");
  const result = await pollTask(async () => {
    const historyResponse = await fetch(`${baseUrl()}/history/${created.prompt_id}`);
    if (!historyResponse.ok) return { completed: true, error: `ComfyUI 查询图片失败: ${await historyResponse.text()}` };
    const task = (await historyResponse.json())[created.prompt_id];
    if (!task) return { completed: false };
    const status = task.status?.status_str;
    if (status === "error" || status === "failed") return { completed: true, error: `ComfyUI 图片生成失败: ${status}` };
    if (status !== "success") return { completed: false };
    const image = task.outputs?.["7"]?.images?.[0];
    return image?.filename ? { completed: true, data: `${image.filename}|${image.subfolder || ""}|${image.type || "output"}` } : { completed: true, error: "图片生成成功但没有输出" };
  }, 1500, 600000);
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI 图片生成超时");
  const [filename, subfolder, type] = result.data.split("|");
  return `${baseUrl()}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
};

const videoError = (action: string, error: any) => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const detail = data ? JSON.stringify(data).slice(0, 700) : "";
  return new Error(`ComfyUI ${action}失败：${error?.cause?.code || error?.code || error?.message || String(error)}${status ? ` (HTTP ${status})` : ""}${detail ? `；${detail}` : ""}；地址 ${baseUrl()}`);
};

async function getObjectInfo(): Promise<Record<string, any>> {
  try {
    const [stats, info] = await Promise.all([
      axios.get(`${baseUrl()}/system_stats`, { timeout: 15000, proxy: false }),
      axios.get(`${baseUrl()}/object_info`, { timeout: 20000, proxy: false }),
    ]);
    if (!stats.data?.system?.comfyui_version || !info.data || typeof info.data !== "object") {
      throw new Error("/system_stats 或 /object_info 非预期 ComfyUI 响应");
    }
    return info.data;
  } catch (error) { throw videoError("检测 H3 Runtime", error); }
}

function modelOptions(info: any, node: string, field: string): string[] {
  const entry = info[node]?.input?.required?.[field];
  return Array.isArray(entry?.[0]) ? entry[0].map(String) : [];
}
function assertModel(info: any, node: string, field: string, filename: string) {
  const available = modelOptions(info, node, field);
  if (!available.includes(filename)) throw new Error(`ComfyUI H3 模型文件不可用：${filename}；请在供应商设置中填写 /object_info 返回的实际文件名`);
}

async function uploadImage(base64: string, index: number): Promise<string> {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(base64);
  if (!match) throw new Error(`第 ${index + 1} 张参考图不是 PNG/JPEG/WebP Data URL`);
  const mime = match[1].toLowerCase();
  const filename = `toonflow_h3_${Date.now()}_${index}_${Math.floor(Math.random() * 1e9)}.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`;
  const form = new FormData();
  form.append("image", Buffer.from(match[2], "base64"), { filename, contentType: mime });
  form.append("type", "input");
  try {
    const response = await axios.post(`${baseUrl()}/upload/image`, form, {
      headers: form.getHeaders(), timeout: 60000, proxy: false, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    const result = response.data;
    if (!result?.name) throw new Error("ComfyUI 未返回参考图文件名");
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
  } catch (error) { throw videoError(`上传参考图 ${index + 1}`, error); }
}

function sizeForVideo(resolution: string, ratio: string) {
  const sides: Record<string, number[]> = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:3": [4, 3], "3:4": [3, 4], "21:9": [21, 9] };
  const pair = sides[ratio];
  if (!pair) throw new Error(`H3 不支持比例 ${ratio}`);
  const shortSide = Number.parseInt(resolution, 10);
  if (!Number.isFinite(shortSide) || shortSide <= 0) throw new Error(`H3 分辨率无效：${resolution}`);
  const [w, h] = pair;
  return w >= h
    ? { width: Math.max(32, Math.floor(shortSide * w / h / 32) * 32), height: shortSide }
    : { width: shortSide, height: Math.max(32, Math.floor(shortSide * h / w / 32) * 32) };
}

function referenceLabel(ref: NonNullable<VideoConfig["referenceList"]>[number], index: number): string {
  const preferred = typeof ref.label === "string" && ref.label.trim()
    ? ref.label.trim()
    : (typeof ref.prompt === "string" ? ref.prompt.trim() : "");
  const clean = preferred.replace(/\s+/g, " ").replace(/[<>]/g, "").trim();
  return clean ? clean.slice(0, 120) : `参考图 ${index + 1}`;
}

function h3ReferenceRank(ref: NonNullable<VideoConfig["referenceList"]>[number]): number {
  const type = String(ref.assetType || "").toLowerCase();
  if (type === "role" || type === "character") return 0;
  if (type === "scene" || type === "environment") return 1;
  if (type === "tool" || type === "prop" || type === "creature") return 2;
  return 3;
}

function prepareH3Config(config: VideoConfig): VideoConfig {
  const refs = (config.referenceList || [])
    .filter((item) => !/^storyboard$/i.test(String(item.sourceType || "")))
    .sort((a, b) => h3ReferenceRank(a) - h3ReferenceRank(b));
  return { ...config, referenceList: refs };
}

function compileReferencePrompt(config: VideoConfig): string {
  const refs = (config.referenceList || []).filter(item => item.type === "image");
  if (!refs.length) return config.prompt;

  const expected = refs.map((_, index) => index + 1);
  const rawTags = config.prompt.match(/<Picture\s*\d+\s*>/gi) || [];

  // A dedicated H3 Prompt Skill owns Picture semantics. If it emitted any Picture tags,
  // fail closed unless they exactly match Runtime reference slots 1..N.
  if (rawTags.length) {
    const numbers = rawTags
      .map(tag => Number((tag.match(/\d+/) || [""])[0]))
      .filter(value => Number.isInteger(value));
    const unique = Array.from(new Set(numbers)).sort((a, b) => a - b);
    const invalidSyntax = rawTags.some(tag => {
      const n = Number((tag.match(/\d+/) || [""])[0]);
      return tag !== `<Picture ${n}>`;
    });
    const matches = unique.length === expected.length && expected.every((value, index) => unique[index] === value);
    if (invalidSyntax || !matches) {
      throw new Error(
        `MiniMax H3 Picture 槽位与实际参考图不一致：实际参考图 ${refs.length} 张，提示词引用 [${unique.join(", ")}]。请重新生成 H3 专属提示词，确保使用连续的 <Picture 1>..<Picture ${refs.length}>。`,
      );
    }
    return config.prompt;
  }

  // Backward-compatible guard for old/manual prompts. Normal production prompts should already
  // come from minimaxH3Multi-referenceMode.md and therefore never need this branch.
  const exactTags = refs.map((_, index) => `<Picture ${index + 1}>`);
  const bindings = refs.map((ref, index) => {
    const tag = exactTags[index];
    return `${tag} = ${referenceLabel(ref, index)}。必须把该图作为权威视觉参考。`;
  });

  return [
    "【MiniMax H3 多图参考绑定｜兼容回退】",
    ...bindings,
    "严格按照上述 Picture 编号与传入图片的顺序一一对应。",
    "保持参考主体的身份与视觉设计连续：人物脸型与五官、年龄感、发型发色、肤色、体型比例、服装与关键配饰不得无故变化；场景和道具参考保持其核心结构与设计。",
    "允许改变动作、表情、镜头角度和构图，但不得忽略参考图、替换主体、混合不同人物特征或擅自重新设计。",
    "",
    "【场景与动作指令】",
    config.prompt,
  ].join("\n");
}

// Same native MiniMax H3 FL2VA/Ref2VA node contract as ai-drama-studio backend/app/p16/provider.py.
function nativeH3Graph(config: VideoConfig, uploaded: string[], info: Record<string, any>): Record<string, any> {
  const referenceMode = uploaded.length > 0;
  const required = ["UNETLoader", "CLIPLoader", "VAELoader", referenceMode ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", "RandomNoise", "BasicGuider", "KSamplerSelect", "BasicScheduler", "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo"];
  if (referenceMode) required.push("LoraLoaderModelOnly");
  if (referenceMode) required.push("LoadImage");
  const missing = required.filter(name => !info[name]);
  if (missing.length) throw new Error(`ComfyUI 缺少原生 MiniMax H3 节点：${missing.join("、")}；请更新 ComfyUI H3 节点或改用已有工作流 JSON`);
  const unet = setting(referenceMode ? "h3RefUnet" : "h3Unet", referenceMode ? "minimax_h3_ref2va_pruned_int8_convrot.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors");
  const clip = setting("h3Clip", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors");
  const videoVae = setting("h3VideoVae", "minimax_h3_video_vae_fp16.safetensors");
  const audioVae = setting("h3AudioVae", "minimax_h3_audio_vae_fp32.safetensors");
  assertModel(info, "UNETLoader", "unet_name", unet);
  assertModel(info, "CLIPLoader", "clip_name", clip);
  assertModel(info, "VAELoader", "vae_name", videoVae);
  assertModel(info, "VAELoader", "vae_name", audioVae);
  const refLora = referenceMode ? setting("h3RefLora", "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors") : "";
  if (referenceMode) assertModel(info, "LoraLoaderModelOnly", "lora_name", refLora);
  const refLoraStrength = Number(setting("h3RefLoraStrength", "1.0"));
  if (referenceMode && (!Number.isFinite(refLoraStrength) || refLoraStrength < -100 || refLoraStrength > 100)) {
    throw new Error("H3 Ref2VA LoRA 强度必须为 -100 到 100 的数字");
  }
  const steps = Number(setting(referenceMode ? "h3RefSteps" : "h3Steps", referenceMode ? "4" : "20"));
  if (!Number.isInteger(steps) || steps < 1 || steps > 150) throw new Error("H3 采样步数必须为 1–150 的整数");
  const { width, height } = sizeForVideo(config.resolution || "480p", config.aspectRatio);
  const duration = Math.max(4, Math.min(15, Math.ceil(config.duration || 5)));
  const frames = Math.max(5, Math.round(duration * 24));
  const length = frames + (5 - frames % 17 + 17) % 17;
  const prefix = `Toonflow/H3_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const graph: Record<string, any> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: videoVae } },
    "4": { class_type: "VAELoader", inputs: { vae_name: audioVae } },
    "5": { class_type: referenceMode ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", inputs: {
      clip: ["2", 0], vae: ["3", 0], ...(referenceMode ? { audio_vae: ["4", 0], ref_image_size: "match" } : {}),
      prompt: compileReferencePrompt(config), width, height, length,
    } },
    "6": { class_type: "RandomNoise", inputs: { noise_seed: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) } },
    "7": { class_type: "BasicGuider", inputs: { model: referenceMode ? ["15", 0] : ["1", 0], conditioning: ["5", 0] } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "9": { class_type: "BasicScheduler", inputs: { model: referenceMode ? ["15", 0] : ["1", 0], scheduler: "simple", steps, denoise: 1.0 } },
    "10": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["6", 0], guider: ["7", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["5", 1] } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["3", 0] } },
    "12": { class_type: "VAEDecodeAudio", inputs: { samples: ["10", 0], vae: ["4", 0] } },
    "13": { class_type: "CreateVideo", inputs: { images: ["11", 0], audio: ["12", 0], fps: 24.0, bit_depth: 8 } },
    "14": { class_type: "SaveVideo", inputs: { video: ["13", 0], filename_prefix: prefix, format: "mp4" } },
  };
  if (referenceMode) {
    graph["15"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: refLora, strength_model: refLoraStrength } };
  }
  uploaded.forEach((filename, index) => {
    const id = String(index + 16);
    graph[id] = { class_type: "LoadImage", inputs: { image: filename } };
    graph["5"].inputs.ref_images = graph["5"].inputs.ref_images || {};
    graph["5"].inputs.ref_images[`ref_image_${index}`] = [id, 0];
  });
  return graph;
}

function customGraph(config: VideoConfig, uploaded: string[]) {
  const apiText = vendor.inputValues.workflowApi?.trim();
  const mapText = vendor.inputValues.workflowMapping?.trim();
  if (!apiText || !mapText) throw new Error("自定义工作流需要同时填写 API JSON 和节点映射 JSON；留空两项则自动使用原生 MiniMax H3 工作流");
  let parsed: any; let map: WorkflowMapping;
  try { parsed = JSON.parse(apiText); map = JSON.parse(mapText); }
  catch { throw new Error("自定义 ComfyUI 工作流或节点映射不是有效 JSON"); }
  const nodes = JSON.parse(JSON.stringify(parsed.prompt || parsed));
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes) || !map?.prompt) throw new Error("工作流必须为含 class_type/inputs 的 API 格式，且映射必须含 prompt");
  const write = (target: InputTarget, value: unknown) => {
    const node = nodes[String(target?.node || "")];
    if (!node?.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, target?.input)) throw new Error(`工作流节点映射无效：${target?.node}.${target?.input}`);
    node.inputs[target.input] = value;
  };
  write(map.prompt, compileReferencePrompt(config));
  if (uploaded.length > (map.images || []).length) throw new Error(`工作流仅映射 ${(map.images || []).length} 张参考图，实际输入 ${uploaded.length} 张`);
  uploaded.forEach((filename, index) => write((map.images || [])[index], filename));
  if (map.duration) write(map.duration, config.duration);
  if (map.frames) write(map.frames, Math.round(config.duration * map.frames.fps));
  if (map.width || map.height) {
    const size = sizeForVideo(config.resolution, config.aspectRatio);
    if (map.width) write(map.width, size.width);
    if (map.height) write(map.height, size.height);
  }
  return { graph: nodes, outputNode: map.outputNode };
}

function findVideo(task: any, outputNode?: string): any {
  const outputs = task?.outputs || {};
  if (outputNode && !outputs[outputNode]) return null;
  const selected = outputNode ? [outputs[outputNode]] : Object.values(outputs);
  const visit = (value: any): any => {
    if (Array.isArray(value)) { for (const item of value) { const found = visit(item); if (found) return found; } }
    else if (value && typeof value === "object") {
      if (typeof value.filename === "string" && /\.(mp4|webm|mov|mkv)$/i.test(value.filename)) return value;
      for (const item of Object.values(value)) { const found = visit(item); if (found) return found; }
    }
    return null;
  };
  for (const output of selected) { const file = visit(output); if (file) return file; }
  return null;
}

async function comfyVideoRequest(config: VideoConfig): Promise<string> {
  // Defense in depth: even an older frontend/backend may still send storyboard images.
  // Never feed them into Ref2VA; they are composition guidance only and can otherwise override faces.
  const runtimeConfig = prepareH3Config(config);
  const refs = runtimeConfig.referenceList || [];
  if (refs.some(item => item.type !== "image")) throw new Error("ComfyUI 原生 H3 直连仅接收参考图片；不能静默忽略视频或音频参考素材");
  if (refs.length > 9) throw new Error("MiniMax H3 最多接收 9 张参考图片");
  const custom = !!(vendor.inputValues.workflowApi?.trim() || vendor.inputValues.workflowMapping?.trim());
  const info = custom ? null : await getObjectInfo();
  const uploaded: string[] = [];
  for (let i = 0; i < refs.length; i++) uploaded.push(await uploadImage(refs[i].base64, i));
  const { graph, outputNode } = custom
    ? customGraph(runtimeConfig, uploaded)
    : { graph: nativeH3Graph(runtimeConfig, uploaded, info!), outputNode: "14" };
  let promptId: string;
  try {
    const response = await axios.post(`${baseUrl()}/prompt`, { prompt: graph, client_id: "toonflow-h3" }, { timeout: 60000, proxy: false, maxBodyLength: Infinity });
    promptId = response.data?.prompt_id;
    if (!promptId) throw new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(response.data?.node_errors || response.data?.error || {})}`);
  } catch (error) { throw videoError("提交 H3 工作流", error); }
  const result = await pollTask(async () => {
    let task: any;
    try {
      const response = await axios.get(`${baseUrl()}/history/${encodeURIComponent(promptId)}`, { timeout: 20000, proxy: false });
      task = response.data?.[promptId] || response.data?.history?.[promptId];
    } catch (error) { throw videoError("查询 H3 任务", error); }
    if (!task) return { completed: false };
    const status = task.status || {};
    if (status.status_str === "error" || status.status_str === "failed") return { completed: true, error: `ComfyUI H3 执行失败：${JSON.stringify(status.messages || []).slice(0, 800)}` };
    const video = findVideo(task, outputNode);
    if (video) {
      const url = `${baseUrl()}/view?filename=${encodeURIComponent(video.filename)}&subfolder=${encodeURIComponent(video.subfolder || "")}&type=${encodeURIComponent(video.type || "output")}`;
      return { completed: true, data: url };
    }
    if (status.completed === true || status.status_str === "success") return { completed: true, error: `ComfyUI H3 工作流已完成但未找到视频输出（节点 ${outputNode || "auto"}）` };
    return { completed: false };
  }, 3000, 1800000);
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI H3 生成超时（30 分钟）");
  return result.data;
}

// Retain the former DramaClaw backend as an explicit opt-in for existing users.
async function gatewayVideoRequest(config: VideoConfig): Promise<string> {
  const url = gatewayUrl();
  const apiKey = (vendor.inputValues.gatewayApiKey || "").replace(/^Bearer\s+/i, "").trim();
  if (!url || !apiKey) throw new Error("DramaClaw 网关地址或 API Key 未配置");
  const refs = config.referenceList || [];
  const imageRefs = refs.filter(item => item.type === "image").map(item => item.base64).filter(Boolean);
  const videoRefs = refs.filter(item => item.type === "video").map(item => item.base64).filter(Boolean);
  const audioRefs = refs.filter(item => item.type === "audio").map(item => item.base64).filter(Boolean);
  if (imageRefs.length > 9 || videoRefs.length > 3 || audioRefs.length > 3) throw new Error("DramaClaw 参考素材超出限制");
  const metadata: Record<string, any> = { ratio: config.aspectRatio, resolution: config.resolution || "480p", generate_audio: config.audio ?? true };
  const body: Record<string, any> = { model: "MiniMax-H3-local", prompt: config.prompt, duration: Math.max(5, Math.min(15, Math.round(config.duration || 5))), metadata };
  if (Array.isArray(config.mode)) {
    if (!refs.length) throw new Error("DramaClaw 多参考模式至少需要一个素材");
    if (imageRefs.length) metadata.reference_images = imageRefs;
    if (videoRefs.length) metadata.reference_videos = videoRefs;
    if (audioRefs.length) metadata.reference_audios = audioRefs;
  } else if (config.mode === "singleImage" || config.mode === "startFrameOptional") {
    if (imageRefs[0]) body.image = imageRefs[0];
  }
  const submit = await axios.post(`${url}/video/generations`, body, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 60000, proxy: false });
  const id = submit.data?.task_id || submit.data?.id;
  if (!id) throw new Error("DramaClaw 未返回视频任务 ID");
  const result = await pollTask(async () => {
    const response = await axios.get(`${url}/video/generations/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 20000, proxy: false });
    const task = response.data;
    if (task.status === "succeeded") {
      const output = task.result_url || task.results?.find((item: any) => item.type === "video")?.url || task.url;
      return output ? { completed: true, data: output } : { completed: true, error: "DramaClaw 已完成但没有视频地址" };
    }
    if (task.status === "failed" || task.status === "cancelled") return { completed: true, error: task.error?.message || "DramaClaw H3 任务失败" };
    return { completed: false };
  }, 3000, 1800000);
  if (result.error || !result.data) throw new Error(result.error || "DramaClaw H3 任务超时");
  return result.data;
}

const videoRequest = async (config: VideoConfig, _model: VideoModel): Promise<string> => {
  const backend = (vendor.inputValues.videoBackend || "comfyui").trim().toLowerCase();
  if (backend === "comfyui") return comfyVideoRequest(config);
  if (backend === "gateway") return gatewayVideoRequest(config);
  throw new Error(`未知视频后端 ${backend}；请选择 comfyui 或 gateway`);
};
exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
export {};
