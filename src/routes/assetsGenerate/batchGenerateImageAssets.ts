import express from "express";
import pLimit from "p-limit";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { roleReferenceFingerprint } from "@/utils/assetReferenceMedia";
import { error, success } from "@/lib/responseFormat";
import { buildAssetImagePrompt } from "@/utils/assetPrompt";
import { validateFields } from "@/middleware/middleware";
import { isRoleFourViewModel, resolveAssetImageModel } from "@/utils/assetImageModel";

const router = express.Router();
type AssetType = "role" | "scene" | "tool";
type BatchItem = { id: number; type: string; name: string; prompt: string; base64?: string | null; styleBase64?: string | null };
const assetTypeConfig: Record<AssetType, { label: string; taskClass: string; dir: string }> = {
  role: { label: "角色", taskClass: "角色图生成", dir: "role" },
  scene: { label: "场景", taskClass: "场景图生成", dir: "scene" },
  tool: { label: "道具", taskClass: "道具图生成", dir: "props" },
};

const requestSchema = {
  projectId: z.number(),
  model: z.string(),
  resolution: z.string(),
  concurrentCount: z.number().int().min(1).optional(),
  items: z.array(z.object({
    id: z.number(),
    type: z.enum(["role", "scene", "tool", "storyboard"]),
    name: z.string(),
    prompt: z.string(),
    base64: z.string().optional().nullable(),
    styleBase64: z.string().optional().nullable(),
  })),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, model, resolution, concurrentCount, items } = req.body;
  const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
  if (!project) return res.status(404).send(error("项目为空"));

  // Validate every target before creating jobs. A mixed-project item must not acquire a candidate.
  const prepared: Array<{
    item: BatchItem;
    runtimeModel: Awaited<ReturnType<typeof resolveAssetImageModel>>;
  }> = [];
  try {
    for (const item of items as BatchItem[]) {
      if (!assetTypeConfig[item.type as AssetType]) throw new Error("不支持的资产类型");
      const asset = await u.db("o_assets").where({ id: item.id, projectId, type: item.type }).select("*").first();
      if (!asset) throw new Error(`${item.name}：资产不存在或不属于当前项目和类型`);
      const runtimeModel = await resolveAssetImageModel(model, item.type);
      const isQwenFourView = isRoleFourViewModel(runtimeModel);
      if (isQwenFourView && item.type !== "role") throw new Error("Qwen 四视图工作流仅支持角色资产，场景和道具请选对应模型");
      if (isQwenFourView && asset.assetsId && !item.base64) throw new Error(`${asset.name || item.name}：衍生形态必须传入同一角色的已确认参考图；不能从文本静默猜测父角色身份`);
      if (item.styleBase64 && (!isQwenFourView || !item.base64)) throw new Error("第二张风格参考图仅用于 Qwen 四视图，且必须先提供当前状态的正面全身锚点图");
      prepared.push({ item, runtimeModel });
    }
  } catch (cause) {
    return res.status(400).send(error(u.error(cause).message));
  }

  const imageIds: number[] = [];
  for (const { item, runtimeModel } of prepared) {
    const [imageId] = await u.db("o_image").insert({
      type: item.type, state: "生成中", assetsId: item.id,
      model: runtimeModel.split(/:(.+)/)[1], resolution,
    });
    imageIds.push(imageId);
  }

  const limit = pLimit(concurrentCount ?? 1);
  const tasks = prepared.map(({ item, runtimeModel }, index) => limit(async () => {
    const imageId = imageIds[index];
    const cfg = assetTypeConfig[item.type as AssetType];
    const imagePath = `/${projectId}/${cfg.dir}/${uuidv4()}.jpg`;
    const describe = `生成${cfg.label}图，名称：${item.name}，提示词：${item.prompt}`;
    const relatedObjects = { id: item.id, projectId, type: cfg.label };
    try {
      const data = await u.db("o_image").where("id", imageId).select("state").first();
      if (!data || data.state === "生成失败") return;
      const isQwenFourView = isRoleFourViewModel(runtimeModel);
      const userPrompt = isQwenFourView
        ? `Project style preset: ${project.artStyle || "use the rendering style specified in the asset prompt"}. Current character and state: ${item.name}. Authoritative visible identity, wardrobe and state facts: ${item.prompt}`
        : buildAssetImagePrompt(item.type as AssetType, project.artStyle ?? "", item.name, item.prompt);
      const references = item.base64 ? [{ base64: item.base64, type: "image" as const }] : [];
      if (isQwenFourView && item.styleBase64) references.push({ base64: item.styleBase64, type: "image" as const });
      const aiImage = u.Ai.Image(runtimeModel);
      await aiImage.run({
        prompt: userPrompt,
        referenceList: references,
        size: resolution,
        aspectRatio: isQwenFourView ? "2:3" : item.type === "tool" || item.type === "role" ? "1:1" : "16:9",
      }, { taskClass: cfg.taskClass, describe, projectId, relatedObjects: JSON.stringify(relatedObjects) });
      await aiImage.save(imagePath);
      // Persist the output before validating the complete image file.
      await u.db("o_image").where("id", imageId).update({ filePath: imagePath });
      const metadata = await sharp(await u.oss.getFile(imagePath)).metadata();
      const actualResolution = metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : resolution;
      if (item.type === "role" && (!(metadata.width && metadata.height) || metadata.width / metadata.height < (isQwenFourView ? 1.7 : 0.95))) {
        throw new Error("角色设定图画布比例异常，请检查完整人物四视图");
      }
      const imageData = await u.db("o_image").where("id", imageId).select("*").first();
      if (!imageData || imageData.state === "生成失败") return;
      await u.db("o_image").where("id", imageId).update({
        state: "已完成", filePath: imagePath, type: item.type,
        model: runtimeModel.split(/:(.+)/)[1], resolution: actualResolution,
      });
      await u.db("o_assets").where({ id: item.id, projectId, type: item.type }).update({
        imageId,
        ...(item.type === "role" ? {
          // ready indicates a usable complete image, not human approval.
          designStatus: "ready", designVersion: u.db.raw("COALESCE(designVersion, 0) + 1"),
          referenceLayout: "four_view",
          referenceFingerprint: await roleReferenceFingerprint(imagePath),
        } : {}),
      });
    } catch (cause) {
      await u.db("o_image").where("id", imageId).update({ state: "生成失败", errorReason: u.error(cause).message });
    }
  }));
  Promise.all(tasks).catch(() => {});
  return res.status(200).send(success({ total: items.length }));
});
