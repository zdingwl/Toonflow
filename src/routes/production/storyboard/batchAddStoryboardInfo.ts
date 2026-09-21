import express from "express";
import { createHash } from "node:crypto";
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
    // 可选：同一个业务写入操作的重试必须复用相同的 requestId；旧客户端无需提供。
    requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  }),
  async (req, res) => {
    const { data, scriptId, projectId, requestId } = req.body;
    if (!data.length) return res.status(400).send(error("数据不能为空"));
    const requestKey = requestId ? `storyboardWrite:${requestId}` : null;
    const payloadHash = requestKey ? createHash("sha256").update(JSON.stringify(data)).digest("hex") : null;

    try {
      const { stored, createdIds, associationMap } = await u.db.transaction(async (trx) => {
        const script = await trx("o_script").where({ id: scriptId, projectId }).first();
        if (!script) throw new Error("剧本不属于当前项目，分镜未写入");

        let createdIds: number[] | null = null;
        if (requestKey) {
          const previous = await trx("o_agentWorkData")
            .where({ projectId, episodesId: scriptId, key: requestKey })
            .first();
          if (previous) {
            const prior = JSON.parse(previous.data ?? "{}");
            if (prior.payloadHash !== payloadHash || !Array.isArray(prior.createdIds) || prior.createdIds.length !== data.length) {
              throw new Error("相同 requestId 对应不同的分镜内容，已拒绝重复提交");
            }
            createdIds = prior.createdIds;
            const persisted = await trx("o_storyboard")
              .where({ scriptId, projectId })
              .whereIn("id", createdIds)
              .select("id");
            if (persisted.length !== createdIds.length) {
              throw new Error("原请求的部分分镜已不存在，不能作为成功的重试返回");
            }
          }
        }

        if (!createdIds) {
          // 在新增分镜之前验证全部引用资产，避免写入一半才发现资产 ID 无效。
          const assetIds: number[] = [...new Set<number>(data.flatMap((item: any) => item.associateAssetsIds))];
          if (assetIds.length) {
            const assets = await trx("o_assets").where({ projectId }).whereIn("id", assetIds).select("id");
            const found = new Set<number>(assets.map((item: any) => Number(item.id)));
            const missing = assetIds.filter((id) => !found.has(id));
            if (missing.length) throw new Error(`引用资产不属于当前项目或不存在：${missing.join(",")}`);
          }

          createdIds = [];
          for (const item of data) {
            const [id] = await trx("o_storyboard").insert({
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
            createdIds.push(id);
            if (item.associateAssetsIds?.length) {
              await trx("o_assets2Storyboard").insert(
                [...new Set<number>(item.associateAssetsIds)].map((assetId) => ({ assetId, storyboardId: id })),
              );
            }
          }

          const lastStoryboard = await trx("o_storyboard").where({ scriptId, projectId });
          if (!lastStoryboard.length) throw new Error("未查到分镜数据");
          const storyboardGroupByTrack: Record<string, number[]> = {};
          for (const item of lastStoryboard) {
            (storyboardGroupByTrack[item.track] ??= []).push(item.id);
          }

          for (const track of Object.keys(storyboardGroupByTrack)) {
            const storyboardIds = storyboardGroupByTrack[track];
            const trackDuration = lastStoryboard
              .filter((item: any) => item.track === track)
              .reduce((sum: number, item: any) => sum + Number(item.duration), 0);
            const existingStoryboard = await trx("o_storyboard")
              .where({ scriptId, projectId, track })
              .whereNotNull("trackId")
              .first();

            let trackId: number;
            if (existingStoryboard?.trackId) {
              trackId = existingStoryboard.trackId;
              const updated = await trx("o_videoTrack").where({ id: trackId, scriptId, projectId }).update({ duration: trackDuration });
              if (updated !== 1) throw new Error(`分镜分组 ${track} 不属于当前剧本`);
            } else {
              // Date.now() 在同一毫秒连续创建分组时可能重复；保留原有时间戳 ID 形式，同时确保唯一。
              const maxRow = await trx("o_videoTrack").max({ maxId: "id" }).first();
              trackId = Math.max(Date.now(), Number(maxRow?.maxId ?? 0) + 1);
              await trx("o_videoTrack").insert({ id: trackId, scriptId, projectId, duration: trackDuration });
            }
            await trx("o_storyboard").where({ scriptId, projectId }).whereIn("id", storyboardIds).update({ trackId });
          }

          const verified = await trx("o_storyboard").where({ scriptId, projectId });
          if (verified.length !== lastStoryboard.length || verified.some((item: any) => !item.trackId)) {
            throw new Error("分镜分组保存不完整");
          }
          if (requestKey) {
            // 操作回执与分镜写入使用同一事务；回执丢失后以同一 requestId 可安全读取原始 ID。
            await trx("o_agentWorkData").insert({
              projectId,
              episodesId: scriptId,
              key: requestKey,
              data: JSON.stringify({ payloadHash, createdIds }),
            });
          }
        }

        // 所有数据库读取均在提交前完成，避免提交成功后查询异常导致客户端误以为整批失败而重复发起插入。
        const stored = await trx("o_storyboard").where({ scriptId, projectId });
        const storyboardIds = stored.map((item: any) => item.id);
        const links = storyboardIds.length
          ? await trx("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).orderBy("rowid").select("storyboardId", "assetId")
          : [];
        const associationMap: Record<number, number[]> = {};
        for (const link of links) {
          (associationMap[link.storyboardId] ??= []).push(link.assetId);
        }
        return { stored, createdIds, associationMap };
      });

      const storyboardData = await Promise.all(
        stored.map(async (item: any) => ({
          associateAssetsIds: associationMap[item.id] ?? [],
          src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath).catch(() => "") : "",
          id: item.id,
          trackId: item.trackId,
          prompt: item.prompt,
          duration: Number(item.duration),
          state: item.state,
          scriptId: item.scriptId,
          reason: item.reason,
          videoDesc: item.videoDesc,
        })),
      );
      // data 仍保持原有分镜列表；另附本批新增 ID，供客户端按提交顺序一一回填，而不是根据文案模糊匹配。
      return res.status(200).send({ ...success(storyboardData), createdIds });
    } catch (reason) {
      console.error("[storyboard/batchAddStoryboardInfo]", reason);
      return res.status(400).send(error(reason instanceof Error ? reason.message : "分镜批量写入失败"));
    }
  },
);
