/* MiniMax H3 + optional HD postprocess, standalone opt-in video provider.
 * This keeps comfyui_local.ts and gateway/H3 legacy output unchanged.
 * The built-in Lanczos mode needs no new model. AI mode needs a compatible
 * per-frame image upscaler in ComfyUI/models/upscale_models.
 */
declare const exports: Record<string, any>;
declare const axios: any;
declare const Buffer: any;
declare const FormData: any;
declare const pollTask: (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>, interval?: number, timeout?: number) => Promise<{ completed: boolean; data?: string; error?: string }>;

const vendor = {
  id: "comfyui_h3_hd", version: "1.0.0", author: "Toonflow",
  name: "本机 MiniMax H3 · 高清放大",
  description: "H3 原生 Ref2VA/FL2VA，生成后对视频帧进行高清放大、原声回接。默认 Lanczos 1080 短边；可选图像超分模型。独立供应商，不影响原 H3。",
  inputs: [
    { key: "baseUrl", label: "ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "h3Unet", label: "H3 FL2VA 模型", type: "text", required: false },
    { key: "h3RefUnet", label: "H3 Ref2VA 模型", type: "text", required: false },
    { key: "h3Clip", label: "H3 文本编码器", type: "text", required: false },
    { key: "h3VideoVae", label: "H3 视频 VAE", type: "text", required: false },
    { key: "h3AudioVae", label: "H3 音频 VAE", type: "text", required: false },
    { key: "h3Steps", label: "H3 步数", type: "text", required: false },
    { key: "upscaleMode", label: "放大模式 off / lanczos1080 / ai1080", type: "text", required: false },
    { key: "upscaleModel", label: "AI 放大模型文件名（仅 ai1080）", type: "text", required: false },
  ],
  inputValues: {
    baseUrl: "http://127.0.0.1:8188",
    h3Unet: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    h3RefUnet: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    h3Clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    h3VideoVae: "minimax_h3_video_vae_fp16.safetensors",
    h3AudioVae: "minimax_h3_audio_vae_fp32.safetensors",
    h3Steps: "20", upscaleMode: "lanczos1080", upscaleModel: "",
  } as Record<string, string>,
  models: [{
    name: "MiniMax H3 本机 · 高清放大", modelName: "minimax-h3-hd-local", type: "video" as const,
    mode: ["text", "startFrameOptional", ["imageReference:9"]], audio: "optional" as const,
    durationResolutionMap: [{ duration: [5,6,7,8,9,10,11,12,13,14,15], resolution: ["480p","720p","768p"] }],
  }],
};
const url = () => (vendor.inputValues.baseUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
const option = (key: string, def: string) => (vendor.inputValues[key] || "").trim() || def;
const textRequest = () => { throw new Error("H3 高清供应商不支持文本模型"); };
const imageRequest = async () => { throw new Error("H3 高清供应商不支持图片模型"); };
const ttsRequest = async () => { throw new Error("H3 高清供应商不支持语音模型"); };
const uploadReference = async (base64: string, fileType: string) => {
  if (fileType !== "image") throw new Error("仅支持图片参考");
  return { type: "image", sourceType: "base64", base64: base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}` };
};
const req = async (path: string, ms = 20000) => (await axios.get(`${url()}${path}`, { timeout: ms, proxy: false })).data;
const knownModels = (info: any, node: string, field: string) => info[node]?.input?.required?.[field]?.[0] || [];
const hasModel = (info: any, node: string, field: string, name: string) => {
  if (!knownModels(info, node, field).includes(name)) throw new Error(`ComfyUI 未找到 ${node} 模型 ${name}；请检查 models 目录或更新供应商配置`);
};
const aligned = (num: number) => Math.max(32, Math.floor(num / 32) * 32);
function videoSize(res: string, ratio: string) {
  const parts = ratio.split(":").map(Number); const a = parts[0], b = parts[1];
  if (!(a > 0 && b > 0)) throw new Error("H3 宽高比无效");
  if (!["480p", "720p", "768p"].includes(res)) throw new Error(`H3 不支持 ${res}`);
  const short = parseInt(res, 10);
  let width = aligned(a >= b ? short * a / b : short);
  let height = aligned(a >= b ? short : short * b / a);
  const max = 1344 * 768;
  if (width * height > max) { const factor = Math.sqrt(max / (width * height)); width = aligned(width * factor); height = aligned(height * factor); }
  return { width, height };
}
async function uploadImage(data: string, n: number) {
  const source = data.startsWith("data:") ? data : `data:image/png;base64,${data}`;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(source);
  if (!match) throw new Error(`第 ${n+1} 张图片必须为 PNG、JPG 或 WebP base64`);
  const filename = `toonflow_h3_hd_${Date.now()}_${n}.${match[1].toLowerCase() === "image/jpeg" ? "jpg" : match[1].split("/")[1]}`;
  const form = new FormData(); form.append("image", Buffer.from(match[2], "base64"), { filename, contentType: match[1] }); form.append("type", "input");
  const response = await axios.post(`${url()}/upload/image`, form, { headers: form.getHeaders(), timeout: 60000, proxy: false, maxBodyLength: Infinity });
  if (!response.data?.name) throw new Error("ComfyUI 参考图上传失败");
  return response.data.subfolder ? `${response.data.subfolder}/${response.data.name}` : response.data.name;
}
const rank = (ref: any) => ({ role: 0, character: 0, scene: 1, environment: 1, tool: 2, prop: 2, creature: 2 } as Record<string, number>)[String(ref.assetType || "").toLowerCase()] ?? 3;
function referencePrompt(config: any, refs: any[]) {
  const text = String(config.prompt || "");
  const tags = [...text.matchAll(/<Picture\s*(\d+)\s*>/gi)].map(m => Number(m[1]));
  if (tags.length) {
    const ids = [...new Set(tags)].sort((a,b) => a-b);
    if (ids.length !== refs.length || ids.some((v,i) => v !== i+1)) throw new Error(`H3 提示词 Picture 编号必须连续对应 ${refs.length} 张参考图`);
    return text;
  }
  if (!refs.length) return text;
  return refs.map((r,i) => `<Picture ${i+1}> = ${String(r.label || r.prompt || `参考主体${i+1}`).replace(/[<>]/g, "").slice(0,100)}，保持身份、服装及视觉设计。`).join("\n") + "\n" + text;
}
function fileOf(output: any): any {
  if (!output) return null;
  if (Array.isArray(output)) { for (const item of output) { const f = fileOf(item); if (f) return f; } return null; }
  if (typeof output === "object") {
    if (typeof output.filename === "string" && /\.(mp4|webm|mov|mkv)$/i.test(output.filename)) return output;
    for (const item of Object.values(output)) { const f = fileOf(item); if (f) return f; }
  }
  return null;
}
function graphFor(config: any, refs: any[], uploaded: string[], info: any) {
  const usingRefs = uploaded.length > 0;
  const unet = option(usingRefs ? "h3RefUnet" : "h3Unet", usingRefs ? "minimax_h3_ref2va_pruned_int8_convrot.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors");
  const clip = option("h3Clip", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors");
  const videoVae = option("h3VideoVae", "minimax_h3_video_vae_fp16.safetensors");
  const audioVae = option("h3AudioVae", "minimax_h3_audio_vae_fp32.safetensors");
  const required = ["UNETLoader","CLIPLoader","VAELoader",usingRefs ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo","RandomNoise","BasicGuider","KSamplerSelect","BasicScheduler","SamplerCustomAdvanced","VAEDecode","VAEDecodeAudio","CreateVideo","SaveVideo"];
  if (usingRefs) required.push("LoadImage");
  const mode = option("upscaleMode", "lanczos1080").toLowerCase();
  if (!["off", "lanczos1080", "ai1080"].includes(mode)) throw new Error("upscaleMode 必须为 off、lanczos1080 或 ai1080");
  if (mode === "lanczos1080") required.push("ImageScaleBy");
  if (mode === "ai1080") required.push("UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScaleBy");
  const missing = required.filter(n => !info[n]);
  if (missing.length) throw new Error(`ComfyUI 缺少节点：${missing.join("、")}`);
  hasModel(info,"UNETLoader","unet_name",unet); hasModel(info,"CLIPLoader","clip_name",clip);
  hasModel(info,"VAELoader","vae_name",videoVae); hasModel(info,"VAELoader","vae_name",audioVae);
  const steps = Number(option("h3Steps","20"));
  if (!Number.isInteger(steps) || steps < 1 || steps > 150) throw new Error("h3Steps 必须为 1-150");
  const {width,height} = videoSize(config.resolution || "480p", config.aspectRatio || "16:9");
  const duration = Math.max(4, Math.min(15, Math.ceil(config.duration || 5)));
  const frames = Math.max(5, Math.round(duration*24));
  const length = frames + (5-frames%17+17)%17;
  const graph: Record<string,any> = {
    "1": { class_type:"UNETLoader", inputs:{unet_name:unet,weight_dtype:"default"} },
    "2": { class_type:"CLIPLoader", inputs:{clip_name:clip,type:"minimax",device:"default"} },
    "3": { class_type:"VAELoader", inputs:{vae_name:videoVae} },
    "4": { class_type:"VAELoader", inputs:{vae_name:audioVae} },
    "5": { class_type:usingRefs ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", inputs:{clip:["2",0],vae:["3",0],...(usingRefs ? { audio_vae:["4",0],ref_image_size:"match" } : {}),prompt:referencePrompt(config,refs),width,height,length} },
    "6": { class_type:"RandomNoise",inputs:{noise_seed:Math.floor(Math.random()*Number.MAX_SAFE_INTEGER)} },
    "7": { class_type:"BasicGuider",inputs:{model:["1",0],conditioning:["5",0]} },
    "8": { class_type:"KSamplerSelect",inputs:{sampler_name:"res_multistep"} },
    "9": { class_type:"BasicScheduler",inputs:{model:["1",0],scheduler:"simple",steps,denoise:1} },
    "10": { class_type:"SamplerCustomAdvanced",inputs:{noise:["6",0],guider:["7",0],sampler:["8",0],sigmas:["9",0],latent_image:["5",1]} },
    "11": { class_type:"VAEDecode",inputs:{samples:["10",0],vae:["3",0]} },
    "12": { class_type:"VAEDecodeAudio",inputs:{samples:["10",0],vae:["4",0]} },
  };
  uploaded.forEach((file,index)=>{ const id=String(30+index); graph[id]={class_type:"LoadImage",inputs:{image:file}}; graph["5"].inputs.ref_images=graph["5"].inputs.ref_images||{}; graph["5"].inputs.ref_images[`ref_image_${index}`]=[id,0]; });
  let source:[string,number] = ["11",0];
  if (mode === "lanczos1080") {
    graph["40"]={class_type:"ImageScaleBy",inputs:{image:source,upscale_method:"lanczos",scale_by:1080/Math.min(width,height)}};
    source=["40",0];
  } else if (mode === "ai1080") {
    const name=option("upscaleModel","");
    if (!name) throw new Error("ai1080 需要在 upscaleModel 填写 models/upscale_models 中的模型文件名");
    hasModel(info,"UpscaleModelLoader","model_name",name);
    graph["40"]={class_type:"UpscaleModelLoader",inputs:{model_name:name}};
    graph["41"]={class_type:"ImageUpscaleWithModel",inputs:{upscale_model:["40",0],image:source}};
    // AI models usually enlarge to 4x. Resize back to 1080 short edge without changing frame order.
    // Warning: the intermediate 4x frames can require considerable RAM/VRAM for long clips.
    graph["42"]={class_type:"ImageScaleBy",inputs:{image:["41",0],upscale_method:"lanczos",scale_by:1080/(Math.min(width,height)*4)}};
    source=["42",0];
  }
  graph["13"]={class_type:"CreateVideo",inputs:{images:source,audio:["12",0],fps:24.0,bit_depth:8}};
  graph["14"]={class_type:"SaveVideo",inputs:{video:["13",0],filename_prefix:`Toonflow/H3_HD_${Date.now()}`,format:"mp4"}};
  return graph;
}
async function videoRequest(config: any, model: any): Promise<string> {
  if (model.modelName !== "minimax-h3-hd-local") throw new Error("此供应商只提供 H3 高清视频模型");
  const refs = (config.referenceList || []).filter((r:any)=>r.sourceType !== "storyboard").sort((a:any,b:any)=>rank(a)-rank(b));
  if (refs.length > 9) throw new Error("H3 最多允许 9 张参考图");
  if (refs.some((r:any)=>r.type !== "image")) throw new Error("H3 高清模式仅支持图像参考");
  const info=await req("/object_info",60000);
  const uploaded=[];
  for(let i=0;i<refs.length;i++) uploaded.push(await uploadImage(refs[i].base64,i));
  const graph=graphFor(config,refs,uploaded,info);
  const created=(await axios.post(`${url()}/prompt`,{prompt:graph,client_id:"toonflow-h3-hd"},{timeout:60000,proxy:false,maxBodyLength:Infinity})).data;
  if(!created.prompt_id) throw new Error(`H3 高清工作流提交失败: ${JSON.stringify(created.node_errors || created.error || {})}`);
  const promptId=created.prompt_id;
  const result=await pollTask(async()=>{
    const response=await axios.get(`${url()}/history/${encodeURIComponent(promptId)}`,{timeout:30000,proxy:false});
    const task=response.data?.[promptId]; if(!task) return {completed:false};
    const status=task.status?.status_str;
    if(status === "error" || status === "failed") return {completed:true,error:`H3 高清生成失败: ${JSON.stringify(task.status?.messages || []).slice(0,1000)}`};
    if(status !== "success") return {completed:false};
    const video=fileOf(task.outputs?.["14"]);
    return video ? {completed:true,data:JSON.stringify(video)} : {completed:true,error:"高清工作流已完成，但最终 SaveVideo 节点没有输出视频"};
  },1500,1800000);
  if(result.error || !result.data) throw new Error(result.error || "H3 高清生成超时");
  const f=JSON.parse(result.data);
  return `${url()}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${encodeURIComponent(f.type || "output")}`;
}
exports.vendor=vendor;
exports.textRequest=textRequest;
exports.imageRequest=imageRequest;
exports.videoRequest=videoRequest;
exports.ttsRequest=ttsRequest;
exports.uploadReference=uploadReference;
export {};
