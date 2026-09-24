/**
 * Opt-in Toonflow image vendor for Qwen-Image-2.1 four-view character assets.
 * Does not replace comfyui_local or modify other image/video models.
 * References: first image = APPROVED FRONT-FULL-BODY character anchor;
 * second image (optional) = character/style reference.
 * No real LoRA is bundled: set loraName only after placing a compatible Qwen-Image-2.1 LoRA in ComfyUI/models/loras.
 */

type ImageRef = { type: "image"; sourceType: "base64"; base64: string };
type ImageModel = { name: string; modelName: string; type: "image"; mode: ("text" | "singleImage" | "multiReference")[]; associationSkills?: string };
type ImageConfig = { prompt: string; referenceList?: ImageRef[]; aspectRatio: `${number}:${number}`; size: "1K" | "2K" | "4K" };
declare const exports: Record<string, any>;
declare const axios: any;
declare const FormData: any;
declare const Buffer: any;
declare const pollTask: (fn: () => Promise<{completed: boolean; data?: string; error?: string}>, interval?: number, timeout?: number) => Promise<{completed: boolean; data?: string; error?: string}>;

const vendor = {
  id: "comfyui_qwen21_fourview", version: "1.0.0", author: "Toonflow",
  name: "本机 Qwen-Image-2.1 四视图（LoRA 可选）",
  description: "单角色四栏：头像特写、正面全身、90度侧面全身、背面全身。提供正面锚点参考图时，其余三栏经 Qwen-Image-2.1 参考图编辑生成；无参考图时先生成正面锚点。LoRA 需单独提供兼容权重。",
  inputs: [
    { key: "baseUrl", label: "本机 ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "unet", label: "Qwen-Image-2.1 扩散模型文件名", type: "text", required: true },
    { key: "clip", label: "Qwen-Image-2.1 文本编码器文件名", type: "text", required: true },
    { key: "vae", label: "Qwen-Image-2.1 VAE 文件名", type: "text", required: true },
    { key: "loraName", label: "Qwen-Image-2.1 LoRA 文件名（可选）", type: "text", required: false, placeholder: "留空禁用；请填实际安装的兼容权重文件名" },
    { key: "loraStrength", label: "LoRA 模型强度", type: "text", required: false, placeholder: "0.65" },
    { key: "steps", label: "每个视角采样步数", type: "text", required: false, placeholder: "35" },
    { key: "identityToken", label: "角色专属 LoRA 触发词（可选）", type: "text", required: false },
  ],
  inputValues: {
    baseUrl: "http://127.0.0.1:8188",
    unet: "qwen_image_2.1_int8_convrot.safetensors",
    clip: "qwen3vl_8b_int8_convrot.safetensors",
    vae: "qwen_image_2.1_vae_bf16.safetensors",
    loraName: "", loraStrength: "0.65", steps: "35", identityToken: "",
  } as Record<string, string>,
  models: [{
    name: "Qwen-Image-2.1 角色四视图", modelName: "qwen-image-2.1-fourview-local",
    type: "image" as const, mode: ["text", "singleImage", "multiReference"] as ("text" | "singleImage" | "multiReference")[],
    associationSkills: "同一角色四栏；参考图1为确认过的正面全身锚点，参考图2可选。四视图仅适用于角色资产，不用于场景或道具。",
  }],
};

const base = () => (vendor.inputValues.baseUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
const textRequest = () => { throw new Error("四视图供应商不提供文本模型"); };
const videoRequest = () => { throw new Error("四视图供应商不提供视频模型"); };
const ttsRequest = () => { throw new Error("四视图供应商不提供语音模型"); };
const uploadReference = async (base64: string, fileType: "image" | "audio" | "video"): Promise<ImageRef> => {
  if (fileType !== "image") throw new Error("只接受图片参考");
  return { type: "image", sourceType: "base64", base64: /^data:image\//i.test(base64) ? base64 : `data:image/png;base64,${base64}` };
};

async function uploadImage(dataUrl: string, index: number): Promise<string> {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(dataUrl.startsWith("data:") ? dataUrl : `data:image/png;base64,${dataUrl}`);
  if (!match) throw new Error(`参考图 ${index + 1} 必须为 PNG、JPEG 或 WebP`);
  const ext = match[1].toLowerCase() === "image/jpeg" ? "jpg" : match[1].split("/")[1];
  const form = new FormData();
  form.append("image", Buffer.from(match[2], "base64"), { filename: `toonflow_kor_anchor_${Date.now()}_${index}.${ext}`, contentType: match[1] });
  form.append("type", "input");
  const result = await axios.post(`${base()}/upload/image`, form, { headers: form.getHeaders(), timeout: 60000, proxy: false, maxBodyLength: Infinity });
  if (!result.data?.name) throw new Error(`ComfyUI 未返回参考图 ${index + 1} 的文件名`);
  return result.data.subfolder ? `${result.data.subfolder}/${result.data.name}` : result.data.name;
}

function checkFile(info: Record<string, any>, node: string, field: string, value: string) {
  const list = info[node]?.input?.required?.[field]?.[0];
  if (!Array.isArray(list) || !list.includes(value)) throw new Error(`ComfyUI 找不到 ${node} 模型文件：${value}；请检查 models 目录和 /object_info`);
}

const ref = (id: number, slot = 0): [string, number] => [String(id), slot];
const node = (class_type: string, inputs: Record<string, any>) => ({class_type, inputs});
function characterPrompt(subject: string, view: "front" | "portrait" | "side" | "back", hasStyle: boolean): string {
  const keep = `科尔，成年男性，海兽王觉醒形态。${subject}。high-end stylized realistic 3D anime CGI character sheet, PBR materials, believable adult anatomy, wet dark hair, red irises, worn dark deep-sea blue clothes, restrained anguished expression, subtle water near silhouette, controlled cool studio key lighting, neutral plain grey background, preserve identical character identity, haircut, outfit seams and proportions, no live-action photo look, no text or watermark`;
  if (view === "front") return `${keep}, one character only, front full-body neutral standing, 7.5 heads tall, head and feet fully in frame`;
  const styling = hasStyle ? " Use <image2> only for CG rendering style; do not copy its composition or replace the identity in <image1>." : "";
  const change = view === "portrait"
    ? "Reframe as chest-up front-facing portrait with expressive restrained anguish, precise red iris detail and identical face."
    : view === "side"
      ? "Rotate the SAME character to a strict 90-degree LEFT profile, full body, feet visible, standing neutrally, preserve all wardrobe construction."
      : "Rotate the SAME character to a straight 180-degree back view, full body, feet visible, standing neutrally, preserve all wardrobe construction.";
  return `Use <image1> as the exact character identity and front-body anchor. ${change}${styling} ${keep}`;
}

function graphFor(config: ImageConfig, anchorFilename?: string, styleFilename?: string): Record<string, any> {
  const v = vendor.inputValues;
  const info = config.size === "1K" ? [640, 960] : config.size === "4K" ? [1024, 1536] : [896, 1344];
  const [width, height] = info;
  const steps = Number(v.steps || "35");
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error("steps 必须是 1–100 的整数");
  const common = `${(v.identityToken || "").trim()} ${config.prompt}`.trim();
  const graph: Record<string, any> = {
    "1": node("UNETLoader", {unet_name: v.unet, weight_dtype: "default"}),
    "2": node("CLIPLoader", {clip_name: v.clip, type: "qwen_image", device: "default"}),
    "3": node("VAELoader", {vae_name: v.vae}),
  };
  let model = ref(1), clip = ref(2);
  if (v.loraName?.trim()) {
    const strength = Number(v.loraStrength || "0.65");
    if (!Number.isFinite(strength) || strength < 0 || strength > 2) throw new Error("LoRA 强度必须在 0–2 之间");
    graph["4"] = node("LoraLoader", {model, clip, lora_name: v.loraName.trim(), strength_model: strength, strength_clip: 0});
    model = ref(4); clip = ref(4, 1);
  }
  let anchor: [string, number];
  if (anchorFilename) {
    graph["10"] = node("LoadImage", {image: anchorFilename});
    anchor = ref(10);
  } else {
    graph["11"] = node("TextEncodeQwenImage21", {clip, vae: ref(3), prompt: characterPrompt(common, "front", false), negative_prompt: "", resolution: height});
    graph["12"] = node("EmptyLatentImage", {width, height, batch_size: 1});
    graph["13"] = node("KSampler", {model, seed: 2026092400, steps, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ref(11), negative: ref(11, 1), latent_image: ref(12), denoise: 1});
    graph["14"] = node("VAEDecode", {samples: ref(13), vae: ref(3)});
    anchor = ref(14);
  }
  if (styleFilename) graph["15"] = node("LoadImage", {image: styleFilename});
  const views: ["portrait" | "side" | "back", number][] = [["portrait", 20], ["side", 30], ["back", 40]];
  for (const [view, id] of views) {
    const inputs: Record<string, any> = {clip, vae: ref(3), prompt: characterPrompt(common, view, Boolean(styleFilename)), negative_prompt: "", resolution: height, "images.image_1": anchor};
    if (styleFilename) inputs["images.image_2"] = ref(15);
    graph[String(id)] = node("TextEncodeQwenImage21", inputs);
    graph[String(id + 1)] = node("KSampler", {model, seed: 2026092400 + id, steps, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ref(id), negative: ref(id, 1), latent_image: ref(id, 2), denoise: 1});
    graph[String(id + 2)] = node("VAEDecode", {samples: ref(id + 1), vae: ref(3)});
  }
  const stitch = (a: [string, number], b: [string, number]) => ({image1:a, image2:b, direction:"right", match_image_size:true, spacing_width:2, spacing_color:"white"});
  graph["50"] = node("ImageStitch", stitch(ref(22), anchor));
  graph["51"] = node("ImageStitch", stitch(ref(50), ref(32)));
  graph["52"] = node("ImageStitch", stitch(ref(51), ref(42)));
  graph["60"] = node("SaveImage", {images: ref(52), filename_prefix: "Toonflow/Qwen21_Kor_4View"});
  return graph;
}

async function imageRequest(config: ImageConfig, model: ImageModel): Promise<string> {
  if (model.modelName !== "qwen-image-2.1-fourview-local") throw new Error(`未支持的图片模型：${model.modelName}`);
  const infoResp = await axios.get(`${base()}/object_info`, {timeout: 30000, proxy: false});
  const info = infoResp.data as Record<string, any>;
  const necessary = ["UNETLoader", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21", "KSampler", "VAEDecode", "SaveImage", "ImageStitch", "EmptyLatentImage"];
  const missing = necessary.filter(key => !info[key]);
  if (missing.length) throw new Error(`ComfyUI 缺少节点：${missing.join("、")}；请更新至支持 Qwen-Image-2.1 / ImageStitch 的版本`);
  checkFile(info, "UNETLoader", "unet_name", vendor.inputValues.unet);
  checkFile(info, "CLIPLoader", "clip_name", vendor.inputValues.clip);
  checkFile(info, "VAELoader", "vae_name", vendor.inputValues.vae);
  if (vendor.inputValues.loraName?.trim()) {
    if (!info.LoraLoader) throw new Error("ComfyUI 缺少标准 LoraLoader 节点");
    checkFile(info, "LoraLoader", "lora_name", vendor.inputValues.loraName.trim());
  }
  const refs = (config.referenceList || []).filter(r => r.type === "image").slice(0, 2);
  const anchorFilename = refs[0] ? await uploadImage(refs[0].base64, 0) : undefined;
  const styleFilename = refs[1] ? await uploadImage(refs[1].base64, 1) : undefined;
  const graph = graphFor(config, anchorFilename, styleFilename);
  const sent = await axios.post(`${base()}/prompt`, {prompt: graph, client_id: "toonflow-qwen21-fourview"}, {timeout: 60000, proxy: false});
  const taskId = sent.data?.prompt_id;
  if (!taskId) throw new Error(`ComfyUI 未接受工作流：${JSON.stringify(sent.data?.node_errors || sent.data || {}).slice(0, 1200)}`);
  const completed = await pollTask(async () => {
    const resp = await axios.get(`${base()}/history/${taskId}`, {timeout: 30000, proxy: false});
    const task = resp.data?.[taskId];
    if (!task) return {completed:false};
    if (["error", "failed"].includes(task.status?.status_str)) return {completed:true, error:`ComfyUI 生成失败：${JSON.stringify(task.status?.messages || []).slice(0, 1000)}`};
    if (task.status?.status_str !== "success") return {completed:false};
    const image = task.outputs?.["60"]?.images?.[0];
    if (!image?.filename) return {completed:true, error:"ComfyUI 生成完成，但节点 60 未输出四视图"};
    return {completed:true, data: JSON.stringify({filename:image.filename, subfolder:image.subfolder || "", type:image.type || "output"})};
  }, 1500, 1200000);
  if (completed.error || !completed.data) throw new Error(completed.error || "ComfyUI 四视图生成超时");
  const image = JSON.parse(completed.data);
  return `${base()}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`;
}

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.uploadReference = uploadReference;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
export {};
