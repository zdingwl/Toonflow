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
  fileType?: "image" | "video" | "audio"; type?: Type;
  sources?: "assets" | "storyboard"; id?: number;
  src?: string; label?: string; prompt?: string;
}
interface ResolvedReference {
  path?: string; sourceType: "assets" | "storyboard";
  assetId?: number; parentAssetId?: number | null;
  assetType?: string; fileType?: string; referenceType?: Type;
  label?: string; prompt?: string;
}
const isMiniMaxH3 = (model: string) => {
  const value = String(model || "").toLowerCase();
  return value.includes("minimax") && value.includes("h3");
};
function h3ReferenceRank(item: ResolvedReference): number {
  const type = String(item.assetType || "").toLowerCase();
  if (type === "role" || type === "character") return 0;
  if (type === "scene" || type === "environment") return 1;
  if (type === "tool" || type === "prop" || type === "creature") return 2;
  return 3;
}

export default router.post("/", validateFields({
  projectId: z.number(), scriptId: z.number(),
  trackData: z.array(z.object({
    uploadData: z.array(z.object({
      id: z.number(), sources: z.string(),
      type: z.enum(["imageReference", "startImage", "endImage", "videoReference", "audioReference"]).optional(),
      fileType: z.enum(["image", "video", "audio"]).optional(),
      label: z.string().optional(), prompt: z.string().optional(),
    })),
    trackId: z.number(), prompt: z.string(), duration: z.number(),
  })),
  model: z.string(), mode: z.string(), resolution: z.string(), audio: z.boolean().optional(),
}), async (req, res) => {
  const { scriptId, projectId, trackData, model, resolution, audio, mode } = req.body;
  let modeData: any[] = [];
  if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
    try { modeData = JSON.parse(mode); } catch {}
  }
  const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
  const h3 = isMiniMaxH3(model);

  // Preflight ALL tracks BEFORE creating any video row; never start a batch with
  // a role + mutually-exclusive derivative or a prompt with mismatched Picture indices.
  let prepared: { trackId: number; prompt: string; duration: number; images: ResolvedReference[] }[];
  try {
    prepared = await Promise.all(
      (trackData as { uploadData: UploadItem[]; trackId: number; prompt: string; duration: number }[]).map(async track => {
        const resolved = await Promise.all(track.uploadData.map(async (item): Promise<ResolvedReference | null> => {
          if (item.sources === "storyboard") {
            const found = await u.db("o_storyboard").where({ id: item.id, projectId }).select("filePath", "prompt").first();
            return found ? {
              path: found.filePath ?? undefined, sourceType: "storyboard", assetType: "storyboard",
              fileType: item.fileType || "image", referenceType: item.type,
              label: item.label || `分镜图${item.id}`, prompt: item.prompt || found.prompt || undefined,
            } : null;
          }
          if (item.sources === "assets") {
            const found = await u.db("o_assets")
              .where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
              .leftJoin("o_image", "o_assets.imageId", "o_image.id")
              .select("o_image.filePath", "o_image.type as imageType", "o_assets.id as assetId", "o_assets.assetsId as parentAssetId", "o_assets.name", "o_assets.prompt", "o_assets.type as assetType")
              .first();
            return found ? {
              path: found.filePath ?? undefined, sourceType: "assets", assetId: found.assetId,
              parentAssetId: found.parentAssetId, assetType: found.assetType,
              fileType: item.fileType || found.imageType || "image", referenceType: item.type,
              label: item.label || found.name, prompt: item.prompt || found.prompt || undefined,
            } : null;
          }
          return null;
        }));
        const images = resolved.filter(Boolean) as ResolvedReference[];
        if (h3) {
          if (resolved.length !== images.length) throw new Error(`轨道 ${track.trackId}：参考资产已删除或不属于当前项目`);
          assertH3ActiveStates(images.filter(item => item.sourceType === "assets").map(item => ({
            assetId: Number(item.assetId), parentAssetId: item.parentAssetId,
            assetType: item.assetType, name: item.label, filePath: item.path,
          })));
        }
        const expanded = h3 ? (await Promise.all(images.map(async item => {
          if (item.sourceType === "assets" && item.assetType === "role" && item.path) {
            const refs = await ensureRoleReferenceMedia(item.path, item.label || "role");
            return refs.length ? refs : [item];
          }
          return [item];
        }))).flat() : images;
        const runtimeImages = h3
          ? expanded.filter(item => item.sourceType !== "storyboard").sort((a,b) => h3ReferenceRank(a) - h3ReferenceRank(b))
          : expanded;
        if (h3) assertH3PictureSlots(track.prompt, runtimeImages.length);
        return { trackId: track.trackId, prompt: track.prompt, duration: track.duration, images: runtimeImages };
      }),
    );
  } catch (cause) {
    return res.status(409).send(error(`批量 H3 视频参考状态/槽位检查失败：${u.error(cause).message}`));
  }

  const tasks = await Promise.all(prepared.map(async item => {
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath, time: Date.now(), state: "生成中", scriptId, projectId, videoTrackId: item.trackId,
    });
    return { ...item, videoId, videoPath };
  }));
  res.status(200).send(success(tasks.map(item => ({ videoId: item.videoId, trackId: item.trackId }))));

  const runTask = async ({ videoId, videoPath, prompt, duration, images }: (typeof tasks)[number]) => {
    try {
      const base64 = await Promise.all(images.map(async item => {
        if (!item.path) return null;
        const type = item.referenceType === "audioReference" || item.fileType === "audio" ? "audio"
          : item.referenceType === "videoReference" || item.fileType === "video" ? "video" : "image";
        return {
          base64: await u.oss.getImageBase64(item.path), type,
          label: item.label, prompt: item.prompt, sourceType: item.sourceType, assetType: item.assetType,
        };
      }));
      if (h3 && base64.some(item => !item)) throw new Error("H3 参考图缺失：不能跳过某个 Picture 槽位继续生成");
      const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
      const aiVideo = u.Ai.Video(model);
      await aiVideo.run({
        prompt, referenceList: base64.filter(Boolean) as ReferenceList[],
        mode: modeData.length > 0 ? modeData : mode,
        duration, aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9", resolution, audio,
      }, { projectId, taskClass: "视频生成", describe: "根据提示词生成视频", relatedObjects: JSON.stringify(relatedObjects) });
      await aiVideo.save(videoPath);
      await u.db("o_video").where("id", videoId).update({ state: "生成成功", errorReason: null, ...(await inspectVideoQuality(videoPath)) });
    } catch (cause: any) {
      await u.db("o_video").where("id", videoId).update({ state: "生成失败", errorReason: u.error(cause).message });
    }
  };
  if (h3) { for (const task of tasks) await runTask(task); }
  else await Promise.all(tasks.map(runTask));
});
