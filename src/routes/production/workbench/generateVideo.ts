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
const referenceMode = z.enum(["board", "auto", "manual"]);
const shotView = z.enum(["front", "side", "back", "turn", "closeup"]);
const uploadSchema = z.object({
  id: z.number(), sources: z.string(),
  type: z.enum(["imageReference", "startImage", "endImage", "videoReference", "audioReference"]).optional(),
  fileType: z.enum(["image", "video", "audio"]).optional(),
  label: z.string().optional(), prompt: z.string().optional(),
  h3ReferenceMode: referenceMode.optional(), h3Views: z.array(view).optional(), h3ShotView: shotView.optional(),
});
type Upload = z.infer<typeof uploadSchema>;
type Source = {
  path?: string; sourceType: "assets" | "storyboard"; assetType?: string;
  fileType?: string; referenceType?: string; label?: string; prompt?: string;
};
const isH3 = (model: string) => /minimax/i.test(model) && /h3/i.test(model);

export default router.post("/", validateFields({
  projectId: z.number(), scriptId: z.number(), uploadData: z.array(uploadSchema),
  prompt: z.string(), model: z.string(), mode: z.string(),
  resolution: z.string(), duration: z.number(), audio: z.boolean().optional(), trackId: z.number(),
  h3ReferenceMode: referenceMode.optional(), h3Views: z.array(view).optional(), h3ShotView: shotView.optional(),
}), async (req, res) => {
  const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
  const h3 = isH3(model);
  let cleanPrompt = prompt;
  let referenceList: ReferenceList[] = [];
  try {
    const existingTrack = await u.db("o_videoTrack").where({ id: trackId, projectId }).select("id", "duration").first();
    if (!existingTrack) throw new Error("视频轨道不属于当前项目");
    if (h3) {
      const options = {
        h3ReferenceMode: req.body.h3ReferenceMode, h3Views: req.body.h3Views, h3ShotView: req.body.h3ShotView,
      };
      const plan = await prepareH3ReferencePlan(projectId, (uploadData as Upload[]).map(item => ({
        ...item, reference: true,
      })), options);
      cleanPrompt = verifyAndStripH3Prompt(prompt, plan);
      // The exact same ordered path list produced the prompt's Picture IDs.
      referenceList = await Promise.all(plan.pictures.map(async picture => ({
        base64: await u.oss.getImageBase64(picture.path), type: "image" as const,
        label: picture.name, prompt: picture.assetPrompt,
        sourceType: "assets", assetType: picture.assetType,
      })));
    } else {
      const resolved = await Promise.all((uploadData as Upload[]).map(async item: Promise<Source | null> => {
        if (item.sources === "storyboard") {
          const found = await u.db("o_storyboard").where({ id: item.id, projectId }).select("filePath", "prompt").first();
          return found ? { path: found.filePath, sourceType: "storyboard", fileType: item.fileType || "image", referenceType: item.type, label: item.label || `分镜图${item.id}`, prompt: item.prompt || found.prompt } : null;
        }
        if (item.sources === "assets") {
          const found = await u.db("o_assets").where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_image.filePath", "o_image.type as imageType", "o_assets.name", "o_assets.prompt", "o_assets.type as assetType").first();
          return found ? { path: found.filePath, sourceType: "assets", assetType: found.assetType, fileType: item.fileType || found.imageType || "image", referenceType: item.type, label: item.label || found.name, prompt: item.prompt || found.prompt } : null;
        }
        return null;
      }));
      referenceList = (await Promise.all(resolved.filter(Boolean).map(async item => {
        if (!item?.path) return null;
        const type = item.referenceType === "audioReference" || item.fileType === "audio" ? "audio"
          : item.referenceType === "videoReference" || item.fileType === "video" ? "video" : "image";
        return { base64: await u.oss.getImageBase64(item.path), type, label: item.label, prompt: item.prompt, sourceType: item.sourceType, assetType: item.assetType };
      }))).filter(Boolean) as ReferenceList[];
    }
  } catch (cause) {
    await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成失败" });
    return res.status(409).send(error(`视频参考图/提示词检查失败：${u.error(cause).message}`));
  }
  let modeData: string[] = [];
  if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
    try { modeData = JSON.parse(mode); } catch { /* Leave original mode intact. */ }
  }
  const ratio = await u.db("o_project").select("videoRatio").where({ id: projectId }).first();
  const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
  const [videoId] = await u.db("o_video").insert({
    filePath: videoPath, time: Date.now(), state: "生成中", scriptId, projectId, videoTrackId: trackId,
  });
  await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成中" });
  res.status(200).send(success(videoId));
  const aiVideo = u.Ai.Video(model);
  const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
  aiVideo.run({
    prompt: cleanPrompt, referenceList, mode: modeData.length ? modeData : mode, duration,
    aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9", resolution, audio,
  }, {
    projectId, taskClass: "视频生成", describe: "根据提示词生成视频", relatedObjects: JSON.stringify(relatedObjects),
  }).then(async () => aiVideo.save(videoPath))
    .then(async () => u.db("o_video").where("id", videoId).update({ state: "生成成功", errorReason: null, ...(await inspectVideoQuality(videoPath)) }))
    .catch(async (cause: unknown) => {
      await u.db("o_video").where("id", videoId).update({ state: "生成失败", errorReason: u.error(cause).message });
    });
});
