import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
import { ensureRoleReferenceMedia } from "@/utils/assetReferenceMedia";
import { inspectVideoQuality } from "@/utils/videoQuality";
import { assertH3ActiveStates, assertH3PictureSlots } from "@/utils/h3VisualStateGuard";
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
function h3ReferenceRank(item: ResolvedReference): number {
  const type = String(item.assetType || "").toLowerCase();
  if (type === "role" || type === "character") return 0;
  if (type === "scene" || type === "environment") return 1;
  if (type === "tool" || type === "prop" || type === "creature") return 2;
  return 3;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(), scriptId: z.number(),
    uploadData: z.array(z.object({
      id: z.number(), sources: z.string(),
      type: z.enum(["imageReference", "startImage", "endImage", "videoReference", "audioReference"]).optional(),
      fileType: z.enum(["image", "video", "audio"]).optional(),
      label: z.string().optional(), prompt: z.string().optional(),
    })),
    prompt: z.string(), model: z.string(), mode: z.string(),
    resolution: z.string(), duration: z.number(), audio: z.boolean().optional(), trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
    let modeData: any[] = [];
    if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try { modeData = JSON.parse(mode); } catch {}
    }
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const h3 = isMiniMaxH3(model);
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
            .select("o_image.filePath", "o_image.type as imageType", "o_assets.id as assetId", "o_assets.assetsId as parentAssetId", "o_assets.name", "o_assets.prompt", "o_assets.type as assetType")
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
    if (h3) {
      try {
        if (resolved.length !== images.length) throw new Error("部分 H3 参考资产已被删除或不属于当前项目；请重新生成视频提示词并选择参考图");
        const actualAssets = images.filter(item => item.sourceType === "assets");
        assertH3ActiveStates(actualAssets.map(item => ({
          assetId: Number(item.assetId), parentAssetId: item.parentAssetId,
          assetType: item.assetType, name: item.label, filePath: item.path,
        })));
      } catch (cause) {
        await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成失败" });
        return res.status(409).send(error(`H3 资产状态检查失败：${u.error(cause).message}`));
      }
    }
    const h3Images = h3
      ? (await Promise.all(images.map(async item => {
          if (item.sourceType === "assets" && item.assetType === "role" && item.path) {
            const refs = await ensureRoleReferenceMedia(item.path, item.label || "role");
            return refs.length ? refs : [item];
          }
          return [item];
        }))).flat()
      : images;
    // Storyboard images may guide composition in text, but are NOT identity references for H3.
    const runtimeImages = h3
      ? h3Images.filter(item => item.sourceType !== "storyboard").sort((a, b) => h3ReferenceRank(a) - h3ReferenceRank(b))
      : images;
    if (h3) {
      try { assertH3PictureSlots(prompt, runtimeImages.length); }
      catch (cause) {
        await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成失败" });
        return res.status(409).send(error(`H3 Picture 编号检查失败：${u.error(cause).message}`));
      }
    }
    const base64 = await Promise.all(runtimeImages.map(async item => {
      if (!item.path) return null;
      const type = item.referenceType === "audioReference" || item.fileType === "audio" ? "audio"
        : item.referenceType === "videoReference" || item.fileType === "video" ? "video" : "image";
      return {
        base64: await u.oss.getImageBase64(item.path), type,
        label: item.label, prompt: item.prompt, sourceType: item.sourceType, assetType: item.assetType,
      };
    }));
    if (h3 && base64.some(item => !item)) {
      await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成失败" });
      return res.status(409).send(error("H3 某张参考图缺失，不允许跳过该槽位继续生成"));
    }
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath, time: Date.now(), state: "生成中", scriptId, projectId, videoTrackId: trackId,
    });
    await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成中" });
    res.status(200).send(success(videoId));
    const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
    const aiVideo = u.Ai.Video(model);
    aiVideo.run({
      prompt, referenceList: base64.filter(Boolean) as ReferenceList[],
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
