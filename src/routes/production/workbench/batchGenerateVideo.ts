import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import type { ReferenceList } from "@/utils/ai";
import { inspectVideoQuality } from "@/utils/videoQuality";
import { prepareH3ReferencePlan, verifyAndStripH3Prompt } from "@/utils/h3GenerationContract";

const router = express.Router();
const view = z.enum(["BOARD", "FACE", "FRONT", "SIDE", "BACK"]);
const refMode = z.enum(["board", "auto", "manual"]);
const shotView = z.enum(["front", "side", "back", "turn", "closeup"]);
const options = { h3ReferenceMode: refMode.optional(), h3Views: z.array(view).optional(), h3ShotView: shotView.optional() };
const uploadSchema = z.object({
  id: z.number(), sources: z.string(),
  type: z.enum(["imageReference", "startImage", "endImage", "videoReference", "audioReference"]).optional(),
  fileType: z.enum(["image", "video", "audio"]).optional(),
  label: z.string().optional(), prompt: z.string().optional(), ...options,
});
type Upload = z.infer<typeof uploadSchema>;
type Track = { trackId: number; duration: number; prompt: string; uploadData: Upload[] } & {
  h3ReferenceMode?: z.infer<typeof refMode>; h3Views?: z.infer<typeof view>[];
  h3ShotView?: z.infer<typeof shotView>;
};
const isH3 = (model: string) => /minimax/i.test(model) && /h3/i.test(model);

export default router.post("/", validateFields({
  projectId: z.number(), scriptId: z.number(),
  trackData: z.array(z.object({ uploadData: z.array(uploadSchema), trackId: z.number(), prompt: z.string(), duration: z.number(), ...options })),
  model: z.string(), mode: z.string(), resolution: z.string(), audio: z.boolean().optional(), ...options,
}), async (req, res) => {
  const { scriptId, projectId, trackData, model, resolution, audio, mode } = req.body as {
    scriptId: number; projectId: number; trackData: Track[]; model: string; resolution: string; audio?: boolean; mode: string;
  };
  let modeData: string[] = [];
  if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
    try { modeData = JSON.parse(mode); } catch { /* preserve original mode */ }
  }
  const h3 = isH3(model);
  type Prepared = { trackId: number; duration: number; prompt: string; refs: ReferenceList[] };
  let prepared: Prepared[];
  try {
    const ratio = await u.db("o_project").select("videoRatio").where({ id: projectId }).first();
    if (!ratio) throw new Error("项目不存在");
    prepared = await Promise.all(trackData.map(async track => {
      const current = await u.db("o_videoTrack").where({ id: track.trackId, projectId }).select("id").first();
      if (!current) throw new Error(`轨道 ${track.trackId} 不属于当前项目`);
      if (h3) {
        const plan = await prepareH3ReferencePlan(projectId, track.uploadData.map(item => ({ ...item, reference: true })), {
          h3ReferenceMode: track.h3ReferenceMode ?? req.body.h3ReferenceMode,
          h3Views: track.h3Views ?? req.body.h3Views,
          h3ShotView: track.h3ShotView ?? req.body.h3ShotView,
        });
        const prompt = verifyAndStripH3Prompt(track.prompt, plan);
        const refs = await Promise.all(plan.pictures.map(async picture => ({
          base64: await u.oss.getImageBase64(picture.path), type: "image" as const,
          label: picture.name, prompt: picture.assetPrompt,
          sourceType: "assets", assetType: picture.assetType,
        })));
        return { trackId: track.trackId, duration: track.duration, prompt, refs };
      }
      const resolved = await Promise.all(track.uploadData.map(async item => {
        if (item.sources === "storyboard") {
          const found = await u.db("o_storyboard").where({ id: item.id, projectId }).select("filePath", "prompt").first();
          return found ? { path: found.filePath, type: item.type, fileType: item.fileType || "image", prompt: item.prompt || found.prompt, sourceType: "storyboard", label: item.label, assetType: "storyboard" } : null;
        }
        if (item.sources === "assets") {
          const found = await u.db("o_assets").where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_image.filePath", "o_image.type as imageType", "o_assets.name", "o_assets.prompt", "o_assets.type as assetType").first();
          return found ? { path: found.filePath, type: item.type, fileType: item.fileType || found.imageType || "image", prompt: item.prompt || found.prompt, sourceType: "assets", label: item.label || found.name, assetType: found.assetType } : null;
        }
        return null;
      }));
      const refs = (await Promise.all(resolved.filter(Boolean).map(async item => {
        if (!item?.path) return null;
        const type = item.type === "audioReference" || item.fileType === "audio" ? "audio"
          : item.type === "videoReference" || item.fileType === "video" ? "video" : "image";
        return { base64: await u.oss.getImageBase64(item.path), type, label: item.label, prompt: item.prompt, sourceType: item.sourceType, assetType: item.assetType };
      }))).filter(Boolean) as ReferenceList[];
      return { trackId: track.trackId, duration: track.duration, prompt: track.prompt, refs };
    }));
  } catch (cause) {
    return res.status(409).send(error(`批量生成前检查失败（尚未创建视频任务）：${u.error(cause).message}`));
  }
  const ratio = await u.db("o_project").select("videoRatio").where({ id: projectId }).first();
  const tasks = await Promise.all(prepared.map(async entry => {
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath, time: Date.now(), state: "生成中", scriptId, projectId, videoTrackId: entry.trackId,
    });
    return { ...entry, videoId, videoPath };
  }));
  res.status(200).send(success(tasks.map(item => ({ videoId: item.videoId, trackId: item.trackId }))));
  const runTask = async ({ videoId, videoPath, prompt, duration, refs }: (typeof tasks)[number]) => {
    try {
      const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
      const aiVideo = u.Ai.Video(model);
      await aiVideo.run({
        prompt, referenceList: refs, mode: modeData.length ? modeData : mode,
        duration, aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9", resolution, audio,
      }, { projectId, taskClass: "视频生成", describe: "根据提示词生成视频", relatedObjects: JSON.stringify(relatedObjects) });
      await aiVideo.save(videoPath);
      await u.db("o_video").where("id", videoId).update({ state: "生成成功", errorReason: null, ...(await inspectVideoQuality(videoPath)) });
    } catch (cause) {
      await u.db("o_video").where("id", videoId).update({ state: "生成失败", errorReason: u.error(cause).message });
    }
  };
  if (h3) { for (const task of tasks) await runTask(task); }
  else await Promise.all(tasks.map(runTask));
});
