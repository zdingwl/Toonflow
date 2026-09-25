import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { db as languageDb } from "@/utils/db";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    trackId: z.number(),
    videoId: z.number(),
  }),
  async (req, res) => {
    const { trackId, videoId } = req.body;
    const meta = await languageDb("o_videoLanguage").where({ videoId }).first();
    if (meta) {
      const video = await u.db("o_video").where({ id: videoId, videoTrackId: trackId }).first();
      if (!video) return res.status(400).send("视频不属于当前段");
      await languageDb("o_videoPromptVariant").where({ trackId, language: meta.language }).update({ videoId });
      return res.status(200).send(success({ message: "语言版本视频选择成功" }));
    }
    await u.db("o_videoTrack").where("id", trackId).update({
      videoId: videoId,
    });
    res.status(200).send(success({ message: "视频选择成功" }));
  },
);
