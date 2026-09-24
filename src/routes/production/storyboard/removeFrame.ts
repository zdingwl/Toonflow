import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const removed = await u.db.transaction(async (trx) => {
      const storyboardData = await trx("o_storyboard").where({ id }).select("id", "trackId", "flowId", "projectId", "scriptId").first();
      if (!storyboardData) return false;
      await trx("o_assets2Storyboard").where("storyboardId", id).delete();
      await trx("o_storyboard").where({ id }).delete();
      if (storyboardData.flowId != null) await trx("o_imageFlow").where("id", storyboardData.flowId).delete();
      if (storyboardData.trackId != null) {
        const remaining = await trx("o_storyboard").where({ trackId: storyboardData.trackId }).first("id");
        if (!remaining) {
          await trx("o_videoTrack").where({ id: storyboardData.trackId, projectId: storyboardData.projectId, scriptId: storyboardData.scriptId }).update({ archived: 1 });
        }
      }
      return true;
    });
    if (!removed) return res.status(400).send(error("未找到该分镜"));
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);
