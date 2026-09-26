import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
import { loadH3ReferencePlan, resolveH3ReferencePlan } from "@/utils/h3ReferencePlan";
import { assertH3ReferenceBindings } from "@/utils/h3ReferenceBindings";
import { inspectVideoQuality } from "@/utils/videoQuality";
import { assertH3ActiveStates, assertH3PictureSlots } from "@/utils/h3VisualStateGuard";
import { db as languageDb } from "@/utils/db";
import { dialogueLanguageSchema, resolveLanguagePrompt } from "@/utils/videoLanguages";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType?: "image" | "video" | "audio";
  type?: Type;
  sources?: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}
interface ResolvedReference {
  path?: string;
  sourceType: "assets" | "storyboard";
  assetId?: number;
  parentAssetId?: number | null;
  assetType?: string;
  fileType?: "image" | "video" | "audio" | string;
  referenceType?: Type;
  label?: string;
  prompt?: string;
}
function isMiniMaxH3(model: string): boolean {
  const value = String(model || "").toLowerCase();
  return value.includes("minimax") && value.includes("h3");
}
function referenceMediaType(item: ResolvedReference): "image" | "audio" | "video" {
  return item.referenceType === "audioReference" || item.fileType === "audio" ? "audio"
    : item.referenceType === "videoReference" || item.fileType === "video" ? "video" : "image";
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(), scriptId: z.number(), validateOnly: z.boolean().optional(),
    uploadData: z.array(z.object({
      id: z.number(), sources: z.string(),
      type: z.enum(["imageReference", "startImage", "endImage", "videoReference", "audioReference"]).optional(),
      fileType: z.enum(["image", "video", "audio"]).optional(),
      label: z.string().optional(), prompt: z.string().optional(),
    })),
    language: dialogueLanguageSchema.optional(),
    prompt: z.string(), model: z.string(), mode: z.string(),
    resolution: z.string(), duration: z.number(), audio: z.boolean().optional(), trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, uploadData, model, duration, resolution, audio, mode, trackId, language } = req.body;
    const validateOnly = req.body.validateOnly === true;
    const ownedTrack = await u.db("o_videoTrack").where({ id: trackId, projectId, scriptId }).first();
    if (!ownedTrack) return res.status(404).send(error("视频段不存在"));
    let prompt: string;
    let modeData: any[] = [];
    if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try { modeData = JSON.parse(mode); } catch {}
    }
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const h3 = isMiniMaxH3(model);
    let base64: ReferenceList[];
    try {
      prompt = await resolveLanguagePrompt(languageDb, trackId, language, req.body.prompt, audio);
      const resolved = await Promise.all(
        (uploadData as UploadItem[]).map(async (item): Promise<ResolvedReference | null> => {
          if (item.sources === "storyboard") {
            const source = await u.db("o_storyboard").where({ id: item.id, projectId }).select("filePath", "prompt").first();
            return source ? {
              path: source.filePath ?? undefined, sourceType: "storyboard", assetType: "storyboard",
              fileType: item.fileType || "image", referenceType: item.type,
              label: item.label || `分镜图${item.id}`, prompt: item.prompt || source.prompt || undefined,
            } : null;
          }
          if (item.sources === "assets") {
            const source = await u.db("o_assets")
              .where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
              .leftJoin("o_image", "o_assets.imageId", "o_image.id")
              .select(
                "o_image.filePath", "o_image.type as imageType", "o_assets.id as assetId",
                "o_assets.assetsId as parentAssetId", "o_assets.name", "o_assets.prompt", "o_assets.type as assetType",
              )
              .first();
            return source ? {
              path: source.filePath ?? undefined, sourceType: "assets",
              assetId: source.assetId, parentAssetId: source.parentAssetId, assetType: source.assetType,
              fileType: item.fileType || source.imageType || "image", referenceType: item.type,
              label: item.label || source.name, prompt: item.prompt || source.prompt || undefined,
            } : null;
          }
          return null;
        }),
      );
      const images = resolved.filter(Boolean) as ResolvedReference[];
      let runtimeReferences = images;
      if (h3) {
        if (resolved.length !== images.length) throw new Error("部分 H3 参考资产已被删除或不属于当前项目；请重新生成视频提示词并选择参考图");
        const assetImages = images.filter(item => item.sourceType === "assets" && referenceMediaType(item) === "image");
        assertH3ActiveStates(assetImages.map(item => ({
          assetId: Number(item.assetId), parentAssetId: item.parentAssetId,
          assetType: item.assetType, name: item.label, filePath: item.path,
        })));
        const plan = await loadH3ReferencePlan(u.db, trackId, prompt);
        if (assetImages.length && !plan) throw new Error("该视频段使用旧版参考图规则，请重新生成视频提示词后再生成视频");
        // The persisted plan is the only authority for Picture order and complete-image selection.
        const pictureReferences: ResolvedReference[] = plan ? resolveH3ReferencePlan(assetImages, plan) : [];
        assertH3PictureSlots(prompt, pictureReferences.length);
        if (plan) assertH3ReferenceBindings(prompt, plan.slots);
        const otherMedia = images.filter(item => item.sourceType !== "storyboard" && referenceMediaType(item) !== "image");
        runtimeReferences = [...pictureReferences, ...otherMedia];
      }
      const loaded = await Promise.all(runtimeReferences.map(async item => {
        if (!item.path) return null;
        return {
          base64: await u.oss.getImageBase64(item.path), type: referenceMediaType(item),
          label: item.label, prompt: item.prompt, sourceType: item.sourceType, assetType: item.assetType,
        };
      }));
      if (h3 && loaded.some(item => !item)) throw new Error("H3 某张参考素材缺失，不允许跳过该槽位继续生成");
      base64 = loaded.filter(Boolean) as ReferenceList[];
    } catch (cause) {
      const reason = (h3 ? "H3 " : "") + "视频参考检查失败：" + u.error(cause).message;
      if (!validateOnly) await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成失败", reason });
      return res.status(409).send(error(reason, { valid: false, tracks: [{ trackId, language, valid: false, reason }] }));
    }
    if (validateOnly) return res.status(200).send(success({ valid: true, tracks: [{
      trackId, language, valid: true, pictureCount: base64.filter(item => item.type === "image").length, referenceCount: base64.length,
    }] }));
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath, time: Date.now(), state: "生成中", scriptId, projectId, videoTrackId: trackId,
    });
    if (language) await languageDb("o_videoLanguage").insert({ videoId, language, prompt });
    await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成中", reason: null });
    res.status(200).send(success(videoId));
    const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
    const aiVideo = u.Ai.Video(model);
    aiVideo.run({
      prompt, referenceList: base64,
      mode: modeData.length > 0 ? modeData : mode, duration,
      aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9", resolution, audio,
    }, {
      projectId, taskClass: "视频生成", describe: "根据提示词生成视频", relatedObjects: JSON.stringify(relatedObjects),
    })
      .then(async () => await aiVideo.save(videoPath))
      .then(async () => await u.db("o_video").where("id", videoId).update({ state: "生成成功", ...(await inspectVideoQuality(videoPath)) }))
      .catch(async (cause: any) => {
        await u.db("o_video").where("id", videoId).update({ state: "生成失败", errorReason: u.error(cause).message });
      });
  },
);
