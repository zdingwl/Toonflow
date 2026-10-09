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
  id: "comfyui_qwen21_fourview", version: "1.1.8", author: "Toonflow",
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
  // Layout and identity commonly share one sentence. Never drop that sentence:
  // doing so discards names, outfits and state facts before any view is rendered.
  // Strip presentation instructions, not the identity/wardrobe that may share
  // their sentence. Replacing 四栏 with 各视角 still requests a multi-view image.
  const portraitView = "(?:正面(?:脸部至肩胸|头肩|脸部)特写|脸部(?:正面)?特写(?:正面)?|脸部特写)(?:[（(](?:头顶|头部)(?:至|到|与)肩胸完整[）)])?(?:，?(?:完整)?头部(?:至|到|与)?肩胸?)?";
  const frontView = "正面全身(?:中性站姿)?(?:，?头顶(?:至|到)脚底完整)?";
  const sideView = "(?:(?:严格)?(?:90[°度]|九十度))?(?:严格)?左侧(?:面)?全身(?:严格侧面)?(?:，?头脚完整)?";
  const backView = "(?:正后方|背面)全身(?:展示(?:披发、)?(?:(?:后脑)(?:与|、))?后背(?:与鞋后跟)?|展示后脑与后背)?(?:，?头脚完整)?";
  const viewName = `(?:${portraitView}|${frontView}|${sideView}|${backView}|脸部|正面|侧面|背面)`;
  const numberedView = "(?:第[一二三四1-4]栏[：:]?\\s*)?" + viewName + "(?:视图|视角)?(?=[、，,；;。.!?\\s]|$)";
  const orderedViews = new RegExp(
    "(?:(?:(?:四栏|四格|四宫格|四视图|四个视角|展示板)(?:角色设定(?:展示)?(?:图|板)|角色设定|设定板|展示板)?[，,]?\\s*)?从左到右(?:固定)?(?:排列)?(?:分别|依次)?(?:为)?[：:]?|(?:四栏|四格|四宫格|四视图|四个视角)(?:固定)?(?:分别为|依次为|为|[：:]))\\s*" + numberedView + "(?:[、，,；;]\\s*" + numberedView + "){1,}",
    "g",
  );
  // Lists often include framing/pose clauses between the view names, so they
  // are not one contiguous orderedViews match. Strip their introducer only
  // when a recognizable camera list follows; retain e.g. hair-color gradients
  // described as 从左到右由黑过渡到银白.
  const layoutLead = new RegExp(
    "(?:四栏|四格|四宫格|四视图|四个视角)?从左到右(?:固定)?(?:排列)?(?:分别|依次)?(?:为)?[：:]?\\s*(?=(?:第[一二三四1-4]栏[：:]?\\s*)?" + viewName + ")",
    "g",
  );
  return prompt
    // New prompts may delimit the presentation block. It is never identity input
    // for a single-view job, so remove it before handling legacy prose.
    .replace(/【展示板布局】[\s\S]*?(?=【\/展示板布局】|$)/g, "")
    .replace(/【\/展示板布局】/g, "")
    .replace(/(?:一张)?展示板(?:呈现|展示)同一(?:个)?人的(?:四个视角|四视角)/g, "")
    .replace(orderedViews, "")
    .replace(layoutLead, "")
    .replace(/(?:四栏|四格|四宫格|四视图|四个视角)从左到右(?:固定)?(?:排列)?(?:分别|依次)?(?:为)?[：:]?/g, "")
    // Consume ordinal markers before 四栏, otherwise 第四栏 becomes 第各视角.
    .replace(/第[一二三四1-4]栏(?:[：:]?\s*(?:为|是))?/g, "")
    .replace(/(?:后|前)[二三四234]栏/g, "")
    .replace(/(?:正面)?(?:脸部|头部)(?:正面)?(?:至|到)?(?:肩胸)?特写|正面头肩特写/g, "")
    .replace(/(?:严格)?(?:(?:90[°度]|九十度))?左侧(?:面)?全身(?:严格侧面)?|正面全身(?:中性站姿)?|正后方全身|背面全身/g, "")
    .replace(/(?:严格90[°度]左侧面|侧面严格90[°度]|严格90[°度]|正后方)(?=[，,；;。.!?\s]|$)/g, "")
    .replace(/[（(](?:头顶|头部)(?:至|到|与)肩胸完整[）)]|(?:头顶|头部)(?:至|到|与)肩胸完整(?:入画)?|完整头部(?:至|到)肩胸|(?:完整)?头部与肩胸|(?:头顶(?:与|到)|头)脚(?:底)?完整(?:入画)?|头顶(?:与|至|到)脚底完整(?:入画)?/g, "")
    .replace(/后脑(?:与|、)后背朝向观众|正面朝向|中性站姿/g, "")
    .replace(/(?:正面|侧面|背面)[，,](?=\s*(?:第[一二三四1-4]栏|严格90))/g, "")
    .replace(/(?:CHARACTER\s+)?(?:TURNAROUND|DESIGN|REFERENCE)\s+(?:SHEET|BOARD)/gi, "single character design")
    .replace(/(?:exactly\s+)?four[- ](?:panels?|views?)(?:\s+in\s+(?:one|a|single)\s+horizontal\s+row)?/gi, "one character")
    .replace(/(?:first|second|third|fourth)\s+panel/gi, "")
    .replace(/(?:portrait|front\s+view|side\s+view|back\s+view)(?:\s*[,/+、]\s*(?:portrait|front\s+view|side\s+view|back\s+view)){1,}/gi, "")
    // Remove presentation wrappers before replacing remaining view-count
    // words. Keep their following fact list verbatim, including scars, face
    // geometry, clothing and current-state details in a mixed sentence.
    .replace(/(?:四栏|四格|四宫格|四视图|四(?:个|名)视角|四视角|各视角|跨视角|多个视角)(?:中|为)?同一(?:个)?(?:人|角色)(?:同一套设计)?(?:的)?/g, "")
    .replace(/(?:四栏|四格|四宫格|四视图|四(?:个|名)视角|四视角)(?:角色设定(?:展示)?(?:图|板)|角色设定|设定板|展示板)/g, "")
    .replace(/(?:四栏|四格|四宫格|四视图|四(?:个|名)视角|四视角|各视角|跨视角|多个视角)(?:角色设定(?:展示)?(?:图|板)|角色设定|设定板|展示板)?/g, "本角色")
    .replace(/(?:一张)?展示板(?:呈现|展示)同一个人的本角色/g, "同一角色")
    .replace(/同一角色([^，。；]{0,30})的本角色/g, "同一角色$1")
    .replace(/(?:角色设定(?:展示)?(?:图|板)|设定展示板|展示板)/g, "角色设计")
    .replace(/同一角色同一状态(?:的)?(?=[，,；;。.!?\s]|$)/g, "")
    .replace(/不因视角增减饰物或改变遮挡关系/g, "保持所列饰物与自然遮挡关系")
    .replace(/不是四个角色/g, "仅一个人物")
    .replace(/背面(?:可见|展示)|能看到/g, "")
    .replace(/同一角色(?:、同一[^，。；]+)?的(?=[。！？])/g, "同一角色")
    .replace(/[,，;；、]\s*[,，;；、]+/g, "，")
    .replace(/(?:[，,；;：:]\s*)+(?=[。.!?])/g, "")
    .replace(/([。.!?])(?:\s*[，,；;：:])+/g, "$1")
    .replace(/([。.!?])(?:\s*[。.!?])+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function hasPersistentBag(facts: string): boolean {
  return facts.split(/[，,；;。.!?\n]/).some(clause =>
    /手提包|挎包|皮包|肩包|背包|手袋|晚宴包|链条包|迷你包|皮革包/.test(clause) &&
    !/禁止|不要|不(?:带|持|背|携带|添加|新增)|没有|无(?:任何)?(?:手提包|挎包|皮包|肩包|背包|手袋|晚宴包|链条包|迷你包|皮革包)/.test(clause));
}
function garmentBackDesign(facts: string): string {
  // A front anchor cannot establish an explicitly designed opening on the
  // garment's back. Carry only that local construction, never body/layout facts.
  const garment = /衣装|服装|上衣|外套|衬衫|背心|礼服|礼裙|连衣裙|裙|吊带衫|泳衣|连体衣/;
  const opening = /(?:(?:低|深|浅|大|高)?\s*[UVＵＶ](?:字形|形|字)?\s*)?(?:开背|露背)|(?:背部|后背)(?:(?:采用|设为|为|的)?(?:低|深|浅|大|高)?\s*[UVＵＶ](?:字形|形|字)?)?(?:领口|开口|开襟|挖空|开(?=至|到))/i;
  const prohibited = /禁止|不要|不得|不(?:采用|使用|做|添加|新增|开背|露背)|没有|无(?:任何)?(?:开背|露背|背部开口|后背开口)/;
  const nonGarment = /伤疤|伤痕|刀疤|伤口|后脑|转身|背影|朝向|镜头|视角|正后方|侧面全身|背面全身/;
  const continuation = /^(?:(?:开口|领口)?(?:下缘|底缘|边缘|最低点)|(?:下探|延伸|终止|止|收)(?:于|至|到)?|(?:至|到)(?:腰|背)|(?:细|横向|背部)?固定带)/;
  const snippets: string[] = [];
  for (const sentence of facts.split(/[。.!?\n]/)) {
    const clauses = sentence.split(/[，,；;]/).map(part => part.trim()).filter(Boolean);
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i], match = opening.exec(clause);
      if (!match || prohibited.test(clause) || nonGarment.test(clause)) continue;
      // Allow a following construction clause to omit the garment noun, but
      // require nearby actual clothing rather than bare-skin/back descriptions.
      if (!garment.test(clauses.slice(Math.max(0, i - 3), i + 1).join("，"))) continue;
      const parts = [clause.slice(match.index)];
      for (let j = i + 1; j <= i + 2 && j < clauses.length; j++) {
        if (!continuation.test(clauses[j]) || nonGarment.test(clauses[j])) break;
        parts.push(clauses[j]);
      }
      const snippet = parts.join("，");
      // Never expand a very long mixed clause into a second full design block.
      if (Array.from(snippet).length <= 140 && !snippets.includes(snippet)) snippets.push(snippet);
      if (snippets.length === 3) return snippets.join("；");
    }
  }
  return snippets.join("；");
}
function characterPrompt(facts: string, view: "front" | "portrait" | "side" | "back", hasStyle: boolean): string {
  const style = view === "front"
    ? "Follow the project rendering style and visible design specified in CURRENT ASSET FACTS; preserve its facial proportions, hair, surface treatment and materials without switching render medium. Use the display background palette and lighting specified in CURRENT ASSET FACTS, keeping the background uncluttered and the full silhouette readable; do not replace the specified palette with a default gray studio. No text, no watermark."
    : "Preserve the reference person's identity, hairstyle, clothing, current state, rendering medium, background palette and lighting. Features outside the requested frame or hidden by this view remain unseen. No text, no watermark.";
  // The front image already establishes the design. Repeating the complete
  // body/face/back inventory in an image-edit request induces contact sheets.
  const identity = view === "front" ? `CURRENT ASSET FACTS (identity and CURRENT state, authoritative): ${facts}. Preserve the specified identity, wardrobe and state.` : "";
  const noGrid = "This is a SINGLE-VIEW render of ONE character. Output a single continuous image containing exactly one person, viewed once.";
  const viewPrompt = view === "front" ? "Create ONE straight-on front FULL-BODY image of ONE individual standing neutrally, shown ONCE, with the whole head and both feet in frame and margins. 唯一一人，正面全身中性站姿，只呈现一次；从头顶到双脚完整入画并留边。This single front-view framing is authoritative; use the asset facts for this individual's identity, appearance, current state, rendering style, background and lighting." :
    view === "portrait" ? "Replace the entire composition with a straight-on HEAD-AND-SHOULDERS close-up of the same individual. Show the full head and shoulders only; the bottom edge ends at the upper chest. 单人正面头肩近景，整个画面只有一个头像，上胸以下不入画。" :
    view === "side" ? "Replace the original pose with a strict 90-degree LEFT SIDE PROFILE of the same individual, full body and both feet in frame. Only the resulting side view fills the image. 单人严格左侧面全身。" :
    "Replace the original pose with a straight 180-degree BACK view of the same individual, full body and both feet in frame. Shoulders face directly away; neither cheek is visible. Only the resulting back view fills the image. 单人正后方全身，只呈现背影。";
  const references = view === "front" ? "" : view === "back"
    ? `Use <image1> as the approved strict side-view identity and CURRENT-STATE anchor. Continue rotating the SAME person another 90 degrees TOWARD THE BACK, not back toward the front, until the face and chest are completely invisible and only the back of the head, shoulders, torso and heels face the camera. Use <image${hasStyle ? 3 : 2}> as the approved front-view structure supplement for the SAME individual: preserve complete body proportions and garment construction on BOTH sides, including asymmetric shoulder, strap and sleeve shapes, lengths, colors and materials. Keep wearer-relative LEFT and RIGHT attached to the body as it rotates; never mirror, swap or symmetrize the design. This front supplement must not replace the BACK-view composition or copy the front-facing pose, face, chest or front-only garment details onto the back. Render this individual once. ${hasStyle ? "Use <image2> only for the requested project rendering style, NEVER for identity, clothing, scene, or composition." : ""}`
    : `Use <image1> as the approved front-view identity and CURRENT-STATE anchor; only change the requested camera/view. ${hasStyle ? "Use <image2> only for the requested project rendering style, NEVER for identity, clothing, scene, or composition." : ""}`;
  const accessories = (view === "side" || view === "back") && hasPersistentBag(facts)
    ? `The bag shown in the front anchor is a persistent part of this SAME outfit. Preserve that exact bag, its strap or chain, size, material and attachment to the same wearer-relative body side while rotating. Keep the bag on the body even when partly occluded; show its visible silhouette and strap wherever this view exposes the bag-bearing side. Do not delete the bag or its entire chain. A bag is not a front-only garment detail. Do not introduce any accessory absent from the reference. ${view === "back" ? `Check the original front supplement <image${hasStyle ? 3 : 2}> for the bag even if the side anchor omitted it.` : ""}`
    : "";
  const backDesign = view === "side" || view === "back" ? garmentBackDesign(facts) : "";
  const backConstruction = backDesign
    ? `CURRENT GARMENT BACK DESIGN (clothing only): ${backDesign}. This explicit construction defines garment surfaces hidden in the front anchor. Apply its stated neckline or opening shape and extent while preserving the same person's identity, proportions and all other approved outfit details. If an opening is explicitly specified, do not close it or extend it below its stated end point; never infer an opening that is not specified. Keep the requested view and natural occlusion; do not turn the person to reveal the opening.`
    : "";
  return [noGrid, references, viewPrompt, identity, accessories, backConstruction, style, `FINAL FRAMING: ${viewPrompt} Render exactly ONE person in this ONE view.`].filter(Boolean).join("\n");
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
    // Keep the side view first for rotation. It cannot establish the opposite
    // shoulder's construction, so supplement it with the complete front anchor.
    // The existing optional style slot stays image2; insert image3 after it.
    if (view === "back") inputs[styleFilename ? "images.image_3" : "images.image_2"] = anchor;
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
