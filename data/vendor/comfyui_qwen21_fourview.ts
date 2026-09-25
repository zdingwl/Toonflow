/* Qwen-Image-2.1 opt-in four-view provider.
 * Generic for ALL characters: visual facts arrive from the current asset;
 * never hard-code an example character, age, outfit or transformation.
 */
type ImageRef = { type: "image"; sourceType?: string; base64: string };
type ImageModel = { name: string; modelName: string; type: "image"; mode: ("text" | "singleImage" | "multiReference")[]; associationSkills?: string };
type ImageConfig = { prompt: string; referenceList?: ImageRef[]; aspectRatio: `${number}:${number}`; size: "1K" | "2K" | "4K" };
declare const exports: Record<string, any>;
declare const axios: any;
declare const FormData: any;
declare const Buffer: any;
declare const pollTask: (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>, interval?: number, timeout?: number) => Promise<{ completed: boolean; data?: string; error?: string }>;

const vendor = {
  id: "comfyui_qwen21_fourview", version: "1.1.3", author: "Toonflow",
  name: "本机 Qwen-Image-2.1 四视图（LoRA 可选）",
  description: "任意角色四栏：头像特写、正面全身、90°左侧面全身、背面全身；角色身份、外观及形态由当前资产提示词提供。首张参考图必须是当前目标状态的正面全身锚点；第二张可选风格参考。LoRA 权重需另外安装。",
  inputs: [
    { key: "baseUrl", label: "本机 ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "unet", label: "Qwen-Image-2.1 模型", type: "text", required: true },
    { key: "clip", label: "Qwen-Image-2.1 文本编码器", type: "text", required: true },
    { key: "vae", label: "Qwen-Image-2.1 VAE", type: "text", required: true },
    { key: "loraName", label: "兼容的 Qwen-Image-2.1 LoRA 文件名（可选）", type: "text", required: false },
    { key: "loraStrength", label: "LoRA 模型强度", type: "text", required: false },
    { key: "steps", label: "每视角采样步数", type: "text", required: false },
    { key: "identityToken", label: "角色 LoRA 触发词（可选）", type: "text", required: false },
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
    associationSkills: "四栏角色资产；参考图1必须是此角色此状态正面全身锚点，参考图2可为风格参考；不适用于场景或道具。",
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
  const source = dataUrl.startsWith("data:") ? dataUrl : `data:image/png;base64,${dataUrl}`;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(source);
  if (!match) throw new Error(`参考图 ${index + 1} 必须为 PNG、JPEG 或 WebP`);
  const ext = match[1].toLowerCase() === "image/jpeg" ? "jpg" : match[1].split("/")[1];
  const form = new FormData();
  form.append("image", Buffer.from(match[2], "base64"), { filename: `toonflow_role_anchor_${Date.now()}_${index}.${ext}`, contentType: match[1] });
  form.append("type", "input");
  const resp = await axios.post(`${base()}/upload/image`, form, { headers: form.getHeaders(), timeout: 60000, proxy: false, maxBodyLength: Infinity });
  if (!resp.data?.name) throw new Error(`ComfyUI 参考图 ${index + 1} 上传失败`);
  return resp.data.subfolder ? `${resp.data.subfolder}/${resp.data.name}` : resp.data.name;
}
function checkFile(info: Record<string, any>, node: string, field: string, value: string) {
  const allowed = info[node]?.input?.required?.[field]?.[0];
  if (!Array.isArray(allowed) || !allowed.includes(value)) throw new Error(`ComfyUI 找不到 ${node} 模型文件：${value}`);
}
const ref = (id: number, slot = 0): [string, number] => [String(id), slot];
const node = (class_type: string, inputs: Record<string, any>) => ({ class_type, inputs });
function identityFactsOnly(prompt: string): string {
  const normalized = prompt
    .replace(/同一角色的(?:四栏|四格|四视图)角色设定图/g, "同一角色的角色设定")
    .replace(/CHARACTER TURNAROUND SHEET/gi, "CHARACTER DESIGN REFERENCE");
  return normalized
    .split(/(?<=[。！？.!?])\s*/u)
    .filter(sentence => !/(?:四栏|四格|四宫格|四视图|四个视角|从左到右|第一栏|第二栏|第三栏|第四栏|(?:exactly\s+)?four[- ]panels?|first panel|second panel|third panel|fourth panel)/i.test(sentence))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function characterPrompt(facts: string, view: "front" | "portrait" | "side" | "back", hasStyle: boolean): string {
  const style = "cinematic stylized realistic 3D animated CGI character, controlled stylization of adult facial anatomy where appropriate, PBR cloth and skin, coherent studio lighting, plain neutral backdrop, a single character only, no live-action photographic look, no text, no watermark";
  const identity = `CURRENT ASSET FACTS (identity and CURRENT state, authoritative): ${facts}. Preserve every explicitly specified face feature, hair, outfit detail, proportion, eye color and state; do not invent character names or swap character states.`;
  const noGrid = "This is a SINGLE-VIEW render of ONE character, NOT a four-panel sheet, collage, split screen, or multiple bodies. Ignore any multi-panel composition instructions inside asset facts; the final sheet is assembled programmatically.";
  const viewPrompt = view === "front" ? "Standing neutral, exact straight-on front FULL BODY, whole head and both feet in frame with margins." :
    view === "portrait" ? "Same individual in a straight-on HEAD-AND-SHOULDERS portrait, full head visible, face details legible." :
    view === "side" ? "Rotate the SAME individual to a strict 90-degree LEFT SIDE PROFILE, full body and both feet in frame, no three-quarter angle." :
    "Rotate the SAME individual to a straight 180-degree BACK view, full body and both feet in frame, no three-quarter angle.";
  const references = view === "front" ? "" : view === "back"
    ? `Use <image1> as the approved strict side-view identity and CURRENT-STATE anchor. Continue rotating the SAME person another 90 degrees until the face and chest are completely invisible and only the back of the head, shoulders, torso and heels face the camera. ${hasStyle ? "Use <image2> only for CG style, NEVER for identity, clothing, scene, or composition." : ""}`
    : `Use <image1> as the approved front-view identity and CURRENT-STATE anchor; only change the requested camera/view. ${hasStyle ? "Use <image2> only for CG style, NEVER for identity, clothing, scene, or composition." : ""}`;
  return [references, viewPrompt, identity, style, noGrid].filter(Boolean).join("\n");
}
function graphFor(config: ImageConfig, anchorFilename?: string, styleFilename?: string): Record<string, any> {
  const v = vendor.inputValues;
  if (!config.prompt?.trim()) throw new Error("当前角色缺少资产身份与状态描述；不能生成通用示例角色替代当前资产");
  const [width, height] = config.size === "1K" ? [640, 960] : config.size === "4K" ? [1024, 1536] : [896, 1344];
  const steps = Number(v.steps || "35");
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error("steps 必须是 1–100 的整数");
  const facts = identityFactsOnly(`${(v.identityToken || "").trim()} ${config.prompt}`.trim());
  const graph: Record<string, any> = {
    "1": node("UNETLoader", { unet_name: v.unet, weight_dtype: "default" }),
    "2": node("CLIPLoader", { clip_name: v.clip, type: "qwen_image", device: "default" }),
    "3": node("VAELoader", { vae_name: v.vae }),
  };
  let model = ref(1), clip = ref(2);
  if (v.loraName?.trim()) {
    const strength = Number(v.loraStrength || "0.65");
    if (!Number.isFinite(strength) || strength < 0 || strength > 2) throw new Error("LoRA 强度必须在 0–2 之间");
    graph["4"] = node("LoraLoader", { model, clip, lora_name: v.loraName.trim(), strength_model: strength, strength_clip: 0 });
    model = ref(4); clip = ref(4, 1);
  }
  let anchor: [string, number];
  if (anchorFilename) {
    graph["10"] = node("LoadImage", { image: anchorFilename }); anchor = ref(10);
  } else {
    graph["11"] = node("TextEncodeQwenImage21", { clip, vae: ref(3), prompt: characterPrompt(facts, "front", false), negative_prompt: "", resolution: height });
    graph["12"] = node("EmptyLatentImage", { width, height, batch_size: 1 });
    graph["13"] = node("KSampler", { model, seed: Math.floor(Math.random() * 2147483647), steps, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ref(11), negative: ref(11, 1), latent_image: ref(12), denoise: 1 });
    graph["14"] = node("VAEDecode", { samples: ref(13), vae: ref(3) }); anchor = ref(14);
  }
  if (styleFilename) graph["15"] = node("LoadImage", { image: styleFilename });
  for (const [view, id] of [["portrait", 20], ["side", 30], ["back", 40]] as const) {
    const viewAnchor = view === "back" ? ref(32) : anchor;
    const inputs: Record<string, any> = { clip, vae: ref(3), prompt: characterPrompt(facts, view, Boolean(styleFilename)), negative_prompt: "", resolution: height, "images.image_1": viewAnchor };
    if (styleFilename) inputs["images.image_2"] = ref(15);
    graph[String(id)] = node("TextEncodeQwenImage21", inputs);
    graph[String(id + 1)] = node("KSampler", { model, seed: Math.floor(Math.random() * 2147483647), steps, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ref(id), negative: ref(id, 1), latent_image: ref(id, 2), denoise: 1 });
    graph[String(id + 2)] = node("VAEDecode", { samples: ref(id + 1), vae: ref(3) });
  }
  const stitch = (a: [string, number], b: [string, number]) => ({ image1: a, image2: b, direction: "right", match_image_size: true, spacing_width: 2, spacing_color: "white" });
  graph["50"] = node("ImageStitch", stitch(ref(22), anchor));
  graph["51"] = node("ImageStitch", stitch(ref(50), ref(32)));
  graph["52"] = node("ImageStitch", stitch(ref(51), ref(42)));
  graph["60"] = node("SaveImage", { images: ref(52), filename_prefix: "Toonflow/Qwen21_Character_4View" });
  return graph;
}
async function imageRequest(config: ImageConfig, model: ImageModel): Promise<string> {
  if (model.modelName !== "qwen-image-2.1-fourview-local") throw new Error(`不支持的图片模型：${model.modelName}`);
  const response = await axios.get(`${base()}/object_info`, { timeout: 30000, proxy: false });
  const info = response.data as Record<string, any>;
  const required = ["UNETLoader", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21", "KSampler", "VAEDecode", "SaveImage", "ImageStitch", "EmptyLatentImage"];
  const missing = required.filter(key => !info[key]);
  if (missing.length) throw new Error(`ComfyUI 缺少节点：${missing.join("、")}`);
  checkFile(info, "UNETLoader", "unet_name", vendor.inputValues.unet);
  checkFile(info, "CLIPLoader", "clip_name", vendor.inputValues.clip);
  checkFile(info, "VAELoader", "vae_name", vendor.inputValues.vae);
  if (vendor.inputValues.loraName?.trim()) {
    if (!info.LoraLoader) throw new Error("ComfyUI 缺少 LoraLoader 节点");
    checkFile(info, "LoraLoader", "lora_name", vendor.inputValues.loraName.trim());
  }
  const refs = config.referenceList || [];
  if (refs.length > 2 || refs.some(item => item.type !== "image")) throw new Error("四视图最多接收2张图片参考：当前状态正面锚点、可选风格图");
  const anchorFilename = refs[0] ? await uploadImage(refs[0].base64, 0) : undefined;
  const styleFilename = refs[1] ? await uploadImage(refs[1].base64, 1) : undefined;
  const graph = graphFor(config, anchorFilename, styleFilename);
  const sent = await axios.post(`${base()}/prompt`, { prompt: graph, client_id: "toonflow-qwen21-fourview" }, { timeout: 60000, proxy: false });
  const taskId = sent.data?.prompt_id;
  if (!taskId) throw new Error(`ComfyUI 未接受四视图工作流：${JSON.stringify(sent.data?.node_errors || sent.data || {}).slice(0, 1200)}`);
  const result = await pollTask(async () => {
    const resp = await axios.get(`${base()}/history/${encodeURIComponent(taskId)}`, { timeout: 30000, proxy: false });
    const task = resp.data?.[taskId]; if (!task) return { completed: false };
    if (["error", "failed"].includes(task.status?.status_str)) return { completed: true, error: `ComfyUI 四视图失败：${JSON.stringify(task.status?.messages || []).slice(0, 1000)}` };
    if (task.status?.status_str !== "success") return { completed: false };
    const image = task.outputs?.["60"]?.images?.[0];
    return image?.filename ? { completed: true, data: JSON.stringify({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" }) } : { completed: true, error: "节点60没有输出四视图" };
  }, 1500, 1200000);
  if (result.error || !result.data) throw new Error(result.error || "ComfyUI 四视图超时");
  const image = JSON.parse(result.data);
  return `${base()}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`;
}
exports.vendor = vendor;
exports.identityFactsOnly = identityFactsOnly;
exports.textRequest = textRequest;
exports.uploadReference = uploadReference;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
export {};
