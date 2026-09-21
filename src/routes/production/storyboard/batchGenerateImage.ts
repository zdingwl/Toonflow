import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { assetItemSchema } from "@/agents/productionAgent/tools";
import { withOperationReceipt } from "@/utils/agent/runtime/operationReceipt";

const router = express.Router();
export type AssetData = z.infer<typeof assetItemSchema>;

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
    compulsory: z.boolean().optional(),
    requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
      concurrentCount = 5,
      compulsory = false,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId: number;
      concurrentCount: number;
      compulsory: boolean;
    } = req.body;
    const requestId = req.body.requestId ?? `storygen_${u.uuid()}`;
    const normalizedIds = [...new Set<number>(storyboardIds.map(Number))].sort((a, b) => a - b);
    if (!normalizedIds.length) return res.status(400).send(error("storyboardIds不能为空"));

    try {
      const projectSettingData = await u.db("o_project")
        .where("id", projectId)
        .select("imageModel", "imageQuality", "artStyle", "videoRatio")
        .first();
      if (!projectSettingData) return res.status(400).send(error("项目不存在"));

      const operationInput = { storyboardIds: normalizedIds, projectId, scriptId, compulsory };
      const claimed = await withOperationReceipt(
        u.db,
        { projectId, episodesId: scriptId },
        "storyboard-generate",
        requestId,
        operationInput,
        async (trx) => {
          const script = await trx("o_script").where({ id: scriptId, projectId }).select("id").first();
          if (!script) throw new Error("当前项目不存在该集剧本");

          const rows = await trx("o_storyboard")
            .where({ scriptId, projectId })
            .whereIn("id", normalizedIds)
            .select("id", "shouldGenerateImage");
          const found = new Set(rows.map((item: any) => Number(item.id)));
          const missing = normalizedIds.filter((id) => !found.has(id));
          if (missing.length) throw new Error(`分镜不属于当前项目或剧集：${missing.join(",")}`);

          if (compulsory) {
            await trx("o_storyboard")
              .where({ scriptId, projectId })
              .whereIn("id", normalizedIds)
              .update({ state: "生成中", shouldGenerateImage: 1, reason: null });
          } else {
            const skippedIds = rows.filter((item: any) => Number(item.shouldGenerateImage) === 0).map((item: any) => Number(item.id));
            const generateIds = rows.filter((item: any) => Number(item.shouldGenerateImage) !== 0).map((item: any) => Number(item.id));
            if (skippedIds.length) {
              await trx("o_storyboard")
                .where({ scriptId, projectId })
                .whereIn("id", skippedIds)
                .update({ state: "未生成", reason: null });
            }
            if (generateIds.length) {
              await trx("o_storyboard")
                .where({ scriptId, projectId })
                .whereIn("id", generateIds)
                .update({ state: "生成中", reason: null });
            }
          }
          return { storyboardIds: normalizedIds, compulsory };
        },
      );

      const assets2StoryboardRows = await u.db("o_assets2Storyboard")
        .whereIn("storyboardId", normalizedIds)
        .orderBy("rowid")
        .select("storyboardId", "assetId");
      const allAssetIds = [...new Set(assets2StoryboardRows.map((row: any) => Number(row.assetId)))];
      const assetImageMap: Record<number, number> = {};
      if (allAssetIds.length) {
        const assetRows = await u.db("o_assets")
          .where({ projectId })
          .whereIn("id", allAssetIds)
          .select("id", "imageId");
        assetRows.forEach((row: any) => {
          if (row.imageId != null) assetImageMap[row.id] = row.imageId;
        });
      }
      const assetRecord: Record<number, number[]> = {};
      assets2StoryboardRows.forEach((item: any) => {
        const imageId = assetImageMap[item.assetId];
        if (imageId != null) (assetRecord[item.storyboardId] ??= []).push(imageId);
      });

      const storyboardData = await u.db("o_storyboard")
        .where({ scriptId, projectId })
        .whereIn("id", normalizedIds)
        .orderBy("index", "asc");
      const responseData = await Promise.all(storyboardData.map(async (item: any) => ({
        id: item.id,
        prompt: item.prompt,
        associateAssetsIds: assetRecord[item.id] ?? [],
        src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : null,
        state: item.state,
        videoDesc: item.videoDesc,
        shouldGenerateImage: item.shouldGenerateImage,
      })));
      res.status(200).send(success(responseData));

      // 相同 requestId 已经受理过：返回真实当前状态，不再次启动图片任务。
      if (claimed.duplicate) return;

      const generateTask = async (item: (typeof storyboardData)[number]) => {
        const repeloadObj = {
          prompt: item.prompt!,
          size: projectSettingData.imageQuality as "1K" | "2K" | "4K",
          aspectRatio: projectSettingData.videoRatio as `${number}:${number}`,
        };
        try {
          const imageCls = await u.Ai.Image(projectSettingData.imageModel as `${string}:${string}`).run(
            {
              referenceList: await getAssetsImageBase64(assetRecord[item.id!] || []),
              ...repeloadObj,
            },
            {
              taskClass: "生成分镜图片",
              describe: "分镜图片生成",
              relatedObjects: JSON.stringify(repeloadObj),
              projectId,
            },
          );
          const savePath = `/${projectId}/assets/${scriptId}/${u.uuid()}.jpg`;
          await imageCls.save(savePath);
          await u.db("o_storyboard").where({ id: item.id, scriptId, projectId }).update({
            filePath: savePath,
            state: "已完成",
            reason: null,
          });
        } catch (reason) {
          await u.db("o_storyboard").where({ id: item.id, scriptId, projectId }).update({
            filePath: "",
            reason: u.error(reason).message,
            state: "生成失败",
          });
        }
      };

      const generateList = compulsory
        ? storyboardData
        : storyboardData.filter((item: any) => item.shouldGenerateImage !== 0);
      for (let i = 0; i < generateList.length; i += concurrentCount) {
        const batch = generateList.slice(i, i + concurrentCount);
        await Promise.all(batch.map(generateTask));
      }
    } catch (reason) {
      const message = u.error(reason).message;
      console.error("[storyboard/batchGenerateImage]", reason);
      if (!res.headersSent) return res.status(400).send(error(message));
    }
  },
);

async function getAssetsImageBase64(imageIds: number[]) {
  if (!imageIds.length) return [];

  const imagePaths = await u.db("o_image").whereIn("o_image.id", imageIds).select("o_image.id", "o_image.filePath");
  const id2Path = new Map<number, string>();
  for (const row of imagePaths) id2Path.set(row.id, row.filePath);

  const imageUrls = await Promise.all(
    imageIds.map(async (id) => {
      const filePath = id2Path.get(id);
      if (!filePath) return null;
      try {
        return await u.oss.getImageBase64(filePath);
      } catch {
        return null;
      }
    }),
  );
  return (imageUrls.filter(Boolean) as string[]).map((url) => ({ type: "image" as const, base64: url }));
}
