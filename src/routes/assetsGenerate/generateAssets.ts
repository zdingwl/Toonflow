import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { ensureRoleReferenceMedia, roleReferenceFingerprint } from "@/utils/assetReferenceMedia";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildAssetImagePrompt, buildFluxPromptTranslationRequest, needsFluxPromptTranslation } from "@/utils/assetPrompt";

const router = express.Router();
type AssetType = "role" | "scene" | "tool";
interface AssetTypeConfig { label: string; taskClass: string; dir: string }
const assetTypeConfig: Record<AssetType, AssetTypeConfig> = {
  role: { label: "角色", taskClass: "角色图生成", dir: "role" },
  scene: { label: "场景", taskClass: "场景图生成", dir: "scene" },
  tool: { label: "道具", taskClass: "道具图生成", dir: "props" },
};
const requestSchema = {
  projectId: z.number(), model: z.string(), resolution: z.string(), id: z.number(),
  type: z.enum(["role", "scene", "tool", "storyboard"]), name: z.string(), prompt: z.string(),
  base64: z.string().optional().nullable(),
  // Optional, backward-compatible second reference for Qwen-Image-2.1 single-view rendering.
  styleBase64: z.string().optional().nullable(),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, model, resolution, id, type, name, prompt, base64, styleBase64 } = req.body;
  const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
  if (!project) return res.status(404).send(error("项目为空"));
  const cfg = assetTypeConfig[type as AssetType];
  if (!cfg) return res.status(400).send(error("不支持的资产类型"));
  const [vendorId, selectedModelName] = model.split(/:(.+)/);
  const isQwenFourView = vendorId === "comfyui_qwen21_fourview" && selectedModelName === "qwen-image-2.1-fourview-local";
  if (isQwenFourView && type !== "role") return res.status(400).send(error("Qwen 四视图工作流仅支持角色资产，场景和道具请选对应模型"));
  if (styleBase64 && (!isQwenFourView || !base64)) return res.status(400).send(error("第二张风格参考图仅用于 Qwen 四视图，且必须先提供当前状态的正面全身锚点图"));

  // Prevent silent identity drift when creating a transformed character from no reference.
  if (isQwenFourView) {
    const asset = await u.db("o_assets").where({ id, projectId }).select("assetsId").first();
    if (!asset) return res.status(404).send(error("资产不存在"));
    if (asset.assetsId && !base64) return res.status(400).send(error("衍生形态必须传入同一角色的已确认参考图；不能从文本静默猜测父角色身份"));
  }

  const [imageId] = await u.db("o_image").insert({ type, state: "生成中", assetsId: id, model: selectedModelName, resolution });
  const imagePath = `/${projectId}/${cfg.dir}/${uuidv4()}.jpg`;
  const describe = `生成${cfg.label}图，名称：${name}，提示词：${prompt}`;
  const relatedObjects = { id, projectId, type: cfg.label };
  try {
    let runtimePrompt = prompt;
    let runtimeArtStyle = project.artStyle || "";
    let runtimeName = name;
    const localPromptSource = `Art style: ${runtimeArtStyle || "unspecified"}. Asset name: ${runtimeName}. Visual facts: ${runtimePrompt}`;
    if (vendorId === "comfyui_local" && selectedModelName === "flux-schnell-local" && needsFluxPromptTranslation(localPromptSource)) {
      const translation = buildFluxPromptTranslationRequest(localPromptSource);
      const translated = (await u.Ai.Text("universalAi").invoke({ system: translation.system, messages: [{ role: "user", content: translation.user }], temperature: 0 })) as any;
      runtimePrompt = String(translated?._output || "").replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/i, "").trim();
      if (!runtimePrompt || needsFluxPromptTranslation(runtimePrompt)) throw new Error("本地 FLUX 提示词英文转换失败，已停止生成");
      runtimeArtStyle = "as specified in the translated visual facts";
      runtimeName = "the same specified character";
    }
    // The Qwen four-view provider performs four SINGLE-VIEW jobs itself.
    // Do not prepend the generic four-panel composition contract to each of its jobs.
    const userPrompt = isQwenFourView
      ? `Project CGI style: ${runtimeArtStyle || "cinematic stylized realistic 3D animation"}. Current character and state: ${runtimeName}. Authoritative visible identity, wardrobe and state facts: ${runtimePrompt}`
      : buildAssetImagePrompt(type as AssetType, runtimeArtStyle, runtimeName, runtimePrompt);
    const references = base64 ? [{ type: "image" as const, base64 }] : [];
    if (isQwenFourView && styleBase64) references.push({ type: "image" as const, base64: styleBase64 });
    const aiImage = u.Ai.Image(model);
    await aiImage.run({
      prompt: userPrompt, referenceList: references, size: resolution,
      // A standard four-column board is wide; Qwen renders each source panel portrait internally.
      aspectRatio: isQwenFourView ? "2:3" : type === "tool" || type === "role" ? "1:1" : "16:9",
    }, { taskClass: cfg.taskClass, describe, projectId, relatedObjects: JSON.stringify(relatedObjects) });
    await aiImage.save(imagePath);
    const metadata = await sharp(await u.oss.getFile(imagePath)).metadata();
    const actualResolution = metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : resolution;
    // A model reporting success is NOT a semantic quality review. Only derive stable reference crops
    // for a four-column role board, and never mark face identity independently verified here.
    if (type === "role" && (!(metadata.width && metadata.height) || metadata.width / metadata.height < (isQwenFourView ? 1.7 : 0.95))) {
      throw new Error("角色设定图画布比例异常，无法创建人物参考图");
    }
    const roleReferences = type === "role" ? await ensureRoleReferenceMedia(imagePath, name) : [];
    const imageData = await u.db("o_image").where("id", imageId).select("*").first();
    if (!imageData) return res.status(500).send(error("资产已被删除"));
    if (imageData.state === "生成失败") return;
    await u.db("o_image").where("id", imageId).update({ state: "已完成", filePath: imagePath, type, model: selectedModelName, resolution: actualResolution });
    await u.db("o_assets").where({ id, projectId }).update({
      imageId,
      ...(type === "role" && roleReferences.length >= 2 ? {
        designStatus: "ready", designVersion: u.db.raw("COALESCE(designVersion, 0) + 1"),
        faceReferencePath: roleReferences[0].path, fullBodyReferencePath: roleReferences[1].path,
        referenceFingerprint: await roleReferenceFingerprint(imagePath),
      } : {}),
    });
    const path = await u.oss.getSmallImageUrl(imagePath);
    return res.status(200).send(success({ path, assetsId: id }));
  } catch (e) {
    await u.db("o_image").where("id", imageId).update({ state: "生成失败", errorReason: u.error(e).message });
    return res.status(400).send(error(u.error(e).message || "图片生成失败"));
  }
});
