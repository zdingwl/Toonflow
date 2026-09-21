import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
export default router.post(
  "/",
  validateFields({
    data: z.array(
      z.object({
        prompt: z.string(),
        duration: z.number(),
        track: z.string(),
        state: z.string(),
        src: z.string().nullable(),
        videoDesc: z.string(),
        shouldGenerateImage: z.number(),
        associateAssetsIds: z.array(z.number()),
      }),
    ),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { data, scriptId, projectId } = req.body;
    if (!data.length) return res.status(400).send({ success: false, message: "数据不能为空" });
    for (const item of data) {
      const [id] = await u.db("o_storyboard").insert({
        prompt: item.prompt,
        duration: String(item.duration),
        state: item.state,
        scriptId,
        projectId,
        track: item.track,
        videoDesc: item.videoDesc,
        shouldGenerateImage: item.shouldGenerateImage,
        createTime: Date.now(),
      });
      if (item.associateAssetsIds?.length) {
        await u.db("o_assets2Storyboard").insert(
          item.associateAssetsIds.map((assetId: number) => ({
            assetId,
            storyboardId: id,
          })),
        );
      }
      item.id = id;
    }
    const lastStoryboard = await u.db("o_storyboard").where({ scriptId, projectId });
    if (!lastStoryboard || !lastStoryboard.length) return res.status(400).send(error("未查到分镜数据"));
    // 根据 track 分组；限定当前项目和剧本，避免混入其他项目的数据。
    const storyboardGroupByTrack: Record<string, number[]> = {};
    lastStoryboard.forEach((item: any) => {
      if (!storyboardGroupByTrack[item.track]) {
        storyboardGroupByTrack[item.track] = [];
      }
      storyboardGroupByTrack[item.track].push(item.id);
    });

    // 查找已有分组并更新时长；新分组沿用原有 videoTrack 创建逻辑。
    for (const track in storyboardGroupByTrack) {
      const storyboardIds = storyboardGroupByTrack[track] ?? [];
      const trackDuration = lastStoryboard
        .filter((item: any) => item.track == track)
        .reduce((sum: number, item: any) => sum + Number(item.duration), 0);
      const existingStoryboard = await u.db("o_storyboard").where({ scriptId, projectId, track }).whereNotNull("trackId").first();

      let trackId: number;
      if (existingStoryboard?.trackId) {
        trackId = existingStoryboard.trackId;
        await u.db("o_videoTrack").where({ id: trackId, scriptId, projectId }).update({ duration: trackDuration });
      } else {
        const newTrackId = Date.now();
        await u.db("o_videoTrack").insert({
          id: newTrackId,
          scriptId,
          projectId,
          duration: trackDuration,
        });
        trackId = newTrackId;
      }

      await u.db("o_storyboard").where({ scriptId, projectId }).whereIn("id", storyboardIds).update({ trackId });
    }

    // 上面的 lastStoryboard 是分配 trackId 之前读取的快照；重新查询，确保回执包含真实已保存的分组 ID。
    const persistedStoryboard = await u.db("o_storyboard").where({ scriptId, projectId }).whereIn(
      "id",
      lastStoryboard.map((item: any) => item.id),
    );
    const persistedById = new Map(persistedStoryboard.map((item: any) => [item.id, item]));
    const storyboardData = await Promise.all(
      lastStoryboard.map(async (i: any) => {
        const persisted = persistedById.get(i.id) as any;
        return {
          associateAssetsIds: await u.db("o_assets2Storyboard").where("storyboardId", i.id).orderBy("rowid").select("assetId").pluck("assetId"),
          src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "",
          id: i.id,
          trackId: persisted?.trackId ?? i.trackId,
          prompt: i.prompt,
          duration: Number(i.duration),
          state: i.state,
          scriptId: i.scriptId,
          reason: i.reason,
          videoDesc: i.videoDesc,
        };
      }),
    );
    return res.status(200).send(success(storyboardData));
  },
);
