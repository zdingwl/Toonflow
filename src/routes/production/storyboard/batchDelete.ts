import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { ids, projectId } = req.body;
    if (!ids.length) return res.status(400).send(error("请先选择分镜"));
    const removed = await u.db.transaction(async (trx) => {
      const storyboardDataList = await trx("o_storyboard").whereIn("id", ids).where("projectId", projectId).select("id", "trackId", "flowId");
      if (!storyboardDataList.length) return 0;
      const storyBoardIds = storyboardDataList.map((item) => item.id);
      const flowIds = storyboardDataList.map((item) => item.flowId).filter((id): id is number => id != null);
      const trackIds = [...new Set(storyboardDataList.map((item) => item.trackId).filter((id): id is number => id != null))];
      await trx("o_assets2Storyboard").whereIn("storyboardId", storyBoardIds).delete();
      await trx("o_storyboard").whereIn("id", storyBoardIds).delete();
      if (flowIds.length) await trx("o_imageFlow").whereIn("id", flowIds).delete();
      for (const trackId of trackIds) {
        const remaining = await trx("o_storyboard").where({ trackId }).first("id");
        if (!remaining) await trx("o_videoTrack").where({ id: trackId, projectId }).update({ archived: 1 });
      }
      return storyBoardIds.length;
    });
    if (!removed) return res.status(400).send(error("当前选择分镜不存在"));
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);
