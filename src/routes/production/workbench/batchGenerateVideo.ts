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
function referenceMediaType(item: ResolvedReference): "image" | "audio" | "video" {
  return item.referenceType === "audioReference" || item.fileType === "audio" ? "audio"
    : item.referenceType === "videoReference" || item.fileType === "video" ? "video" : "image";
}

export default router.post("/", validateFields({
  projectId: z.number(), scriptId: z.number(), validateOnly: z.boolean().optional(),
  trackData: z.array(z.object({
    uploadData: z.array(z.object({
      id: z.number(), sources: z.string(),
      type: z.enum(["imageReference", "startImage", "endImage", "videoReference", "audioReference"]).optional(),
      fileType: z.enum(["image", "video", "audio"]).optional(),
      label: z.string().optional(), prompt: z.string().optional(),
    })),
    language: dialogueLanguageSchema.optional(),
    trackId: z.number(), prompt: z.string(), duration: z.number(),
  })),
  model: z.string(), mode: z.string(), resolution: z.string(), audio: z.boolean().optional(),
}), async (req, res) => {
  const { scriptId, projectId, trackData, model, resolution, audio, mode } = req.body;
  const validateOnly = req.body.validateOnly === true;
  let modeData: any[] = [];
  if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
    try { modeData = JSON.parse(mode); } catch {}
  }
  const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
  const h3 = isMiniMaxH3(model);

  // Preflight ALL tracks BEFORE creating any video row; never start a batch with
  // a role + mutually-exclusive derivative or a prompt with mismatched Picture indices.
  let validationTracks: { trackId: number; language?: string; valid: boolean; pictureCount?: number; referenceCount?: number; reason?: string }[] = [];
  let prepared: { trackId: number; prompt: string; duration: number; referenceList: ReferenceList[]; language?: string }[];
  try {
    const preparationResults = await Promise.allSettled(
      (trackData as { uploadData: UploadItem[]; trackId: number; prompt: string; duration: number; language?: string }[]).map(async track => {
        const ownedTrack = await u.db("o_videoTrack").where({ id: track.trackId, projectId, scriptId }).first();
        if (!ownedTrack) throw new Error("视频段不存在");
        try {
          track.prompt = await resolveLanguagePrompt(languageDb, track.trackId, track.language, track.prompt, audio);
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
                .select(
                  "o_image.filePath", "o_image.type as imageType", "o_assets.id as assetId",
                  "o_assets.assetsId as parentAssetId", "o_assets.name", "o_assets.prompt", "o_assets.type as assetType",
                )
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
          let runtimeReferences = images;
          if (h3) {
            if (resolved.length !== images.length) throw new Error("轨道 " + track.trackId + "：参考资产已删除或不属于当前项目");
            const assetImages = images.filter(item => item.sourceType === "assets" && referenceMediaType(item) === "image");
            assertH3ActiveStates(assetImages.map(item => ({
              assetId: Number(item.assetId), parentAssetId: item.parentAssetId,
              assetType: item.assetType, name: item.label, filePath: item.path,
            })));
            const plan = await loadH3ReferencePlan(u.db, track.trackId, track.prompt);
            if (assetImages.length && !plan) throw new Error("该视频段使用旧版参考图规则，请重新生成视频提示词后再生成视频");
            const pictureReferences: ResolvedReference[] = plan ? resolveH3ReferencePlan(assetImages, plan) : [];
            assertH3PictureSlots(track.prompt, pictureReferences.length);
            if (plan) assertH3ReferenceBindings(track.prompt, plan.slots);
            const otherMedia = images.filter(item => item.sourceType !== "storyboard" && referenceMediaType(item) !== "image");
            runtimeReferences = [...pictureReferences, ...otherMedia];
          }
          // Read the exact references during preflight so a missing image never creates a video attempt.
          const loaded = await Promise.all(runtimeReferences.map(async item => {
            if (!item.path) return null;
            return {
              base64: await u.oss.getImageBase64(item.path), type: referenceMediaType(item),
              label: item.label, prompt: item.prompt, sourceType: item.sourceType, assetType: item.assetType,
            };
          }));
          if (h3 && loaded.some(item => !item)) throw new Error("H3 参考素材缺失：不能跳过某个 Picture 槽位继续生成");
          return { language: track.language, trackId: track.trackId, prompt: track.prompt, duration: track.duration, referenceList: loaded.filter(Boolean) as ReferenceList[] };
        } catch (cause) {
          const reason = "视频参考检查失败：" + u.error(cause).message;
          if (!validateOnly) await u.db("o_videoTrack").where({ id: track.trackId, projectId, scriptId }).update({ state: "生成失败", reason });
          throw new Error("轨道 " + track.trackId + "：" + reason);
        }
      }),
    );
    validationTracks = preparationResults.map((result, index) => ({
      trackId: trackData[index].trackId, language: trackData[index].language, valid: result.status === "fulfilled",
      ...(result.status === "fulfilled"
        ? { pictureCount: result.value.referenceList.filter(item => item.type === "image").length, referenceCount: result.value.referenceList.length }
        : { reason: u.error(result.reason).message }),
    }));
    const failed = preparationResults.filter(result => result.status === "rejected");
    if (failed.length) throw new Error(failed.map(result => u.error(result.reason).message).join("；"));
    prepared = preparationResults.filter(result => result.status === "fulfilled").map(result => result.value);
  } catch (cause) {
    return res.status(409).send(error(`批量视频检查失败：${u.error(cause).message}`, { valid: false, tracks: validationTracks }));
  }

  if (validateOnly) return res.status(200).send(success({ valid: true, tracks: validationTracks }));

  const tasks = await Promise.all(prepared.map(async item => {
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath, time: Date.now(), state: "生成中", scriptId, projectId, videoTrackId: item.trackId,
    });
    if (item.language) await languageDb("o_videoLanguage").insert({ videoId, language: item.language, prompt: item.prompt });
    return { ...item, videoId, videoPath };
  }));
  res.status(200).send(success(tasks.map(item => ({ videoId: item.videoId, trackId: item.trackId, language: item.language }))));

  const runTask = async ({ videoId, videoPath, prompt, duration, referenceList }: (typeof tasks)[number]) => {
    try {
      const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
      const aiVideo = u.Ai.Video(model);
      await aiVideo.run({
        prompt, referenceList,
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
