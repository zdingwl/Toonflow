import express from "express";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { dialogueLanguagesSchema } from "@/utils/videoLanguages";
import { generateVideoPromptForTrack, isVideoPromptRunning } from "@/utils/videoPromptGeneration";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    languages: dialogueLanguagesSchema.optional(),
    regenerate: z.boolean().optional(),
    replaceBasePrompt: z.boolean().optional(),
    projectId: z.number(),
    trackData: z.array(
      z.object({
        trackId: z.number(),
        info: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
            reference: z.boolean().optional(),
            slotType: z.string().optional(),
            fileType: z.string().optional(),
            prompt: z.string().optional(),
          }),
        ),
      }),
    ),
    mode: z.string(),
    model: z.string(),
    concurrentCount: z.number().int().min(1).max(10).optional(), //并发数
  }),
  async (req, res) => {
    const { trackData, projectId, mode, model, languages, regenerate, replaceBasePrompt, concurrentCount = 5 } = req.body;
    try {
      const uniqueTracks = [...new Map(trackData.map((track: any) => [track.trackId, track])).values()] as any[];
      if (uniqueTracks.some(track => isVideoPromptRunning(track.trackId))) return res.status(409).send(error("所选视频段提示词正在生成，请完成后再重试"));
      const tracks = await u.db("o_videoTrack").where({ projectId }).whereIn("id", uniqueTracks.map(track => track.trackId));
      if (tracks.length !== uniqueTracks.length) return res.status(404).send(error("部分视频段不存在"));
      await u.db("o_videoTrack").where({ projectId }).whereIn("id", uniqueTracks.map(track => track.trackId)).update({ state: "生成中", reason: null });
      const limit = pLimit(concurrentCount);
      // Each request uses exactly the same image grounding, slot plan, validation and failure handling as the single route.
      const tasks = uniqueTracks.map(track => limit(() => generateVideoPromptForTrack({
        projectId, mode, model, languages, regenerate, replaceBasePrompt, trackId: track.trackId, info: track.info,
      })));
      void Promise.allSettled(tasks).then(async results => {
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected" && result.reason?.status !== 409) await u.db("o_videoTrack").where({ id: uniqueTracks[index].trackId, projectId })
            .update({ state: "生成失败", reason: u.error(result.reason).message });
        }
      }).catch(cause => console.error("批量提示词状态保存失败", u.error(cause).message));
      return res.status(200).send(success("开始生成提示词"));
    } catch (cause) { return res.status(400).send(error(u.error(cause).message)); }
  },
);
