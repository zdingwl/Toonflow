import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getOperationReceipt, withOperationReceipt } from "@/utils/agent/runtime/operationReceipt";

import { generateAssetPrompt, loadAssetPromptContext, reviewAssetImage } from "@/utils/assetPromptGeneration";
import { ensureRoleReferenceMedia, roleReferenceDatabaseFields, roleReferenceFingerprint } from "@/utils/assetReferenceMedia";

const router = express.Router();
const activeAssetGenerationRequests = new Set<string>();

export default router.post(
  "/",
  validateFields({
    assetIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
    requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  }),
  async (req, res) => {
    const { assetIds, projectId, scriptId, concurrentCount = 5 } = req.body;
    const requestId = req.body.requestId ?? `assetgen_${u.uuid()}`;
    const normalizedIds = [...new Set<number>(assetIds.map(Number))].sort((a, b) => a - b);
    if (!normalizedIds.length) return res.status(400).send(error("assetIds不能为空"));
    const generationKey = `${projectId}:${scriptId}:${requestId}`;
    let ownsGenerationWorker = false;

    try {
      const projectSettingData = await u.db("o_project")
        .where("id", projectId)
        .select("imageModel", "imageQuality", "artStyle")
        .first();
      if (!projectSettingData) return res.status(400).send(error("项目不存在"));

      const operationInput = { assetIds: normalizedIds, projectId, scriptId };
      const claimed = await withOperationReceipt(
        u.db,
        { projectId, episodesId: scriptId },
        "asset-generate",
        requestId,
        operationInput,
        async (trx) => {
          const script = await trx("o_script").where({ id: scriptId, projectId }).select("id").first();
          if (!script) throw new Error("当前项目不存在该集剧本");

          const assets = await trx("o_assets")
            .where({ projectId })
            .whereIn("id", normalizedIds)
            .select("id", "type", "assetsId", "imageId");
          const found = new Set(assets.map((item: any) => Number(item.id)));
          const missing = normalizedIds.filter((id) => !found.has(id));
          if (missing.length) throw new Error(`资产不属于当前项目或不存在：${missing.join(",")}`);

          const links = await trx("o_scriptAssets")
            .where({ scriptId })
            .whereIn("assetId", normalizedIds)
            .select("assetId");
          const linked = new Set(links.map((item: any) => Number(item.assetId)));
          const unlinked = normalizedIds.filter((id) => !linked.has(id));
          if (unlinked.length) throw new Error(`资产未绑定到当前剧集：${unlinked.join(",")}`);

          // Persist the selected inputs in the receipt so recovery cannot read an empty pending image.
          const referenceImageIdMap: Record<number, number | null> = {};
          const referenceIds = [...new Set(assets.flatMap((a: any) => [a.id, a.assetsId]).filter(Boolean))];
          const referenceAssets = await trx("o_assets").where({ projectId }).whereIn("id", referenceIds).select("id", "imageId");
          for (const a of referenceAssets) referenceImageIdMap[Number(a.id)] = a.imageId ?? null;
          const imageIdMap: Record<number, number> = {};
          for (const item of assets) {
            const [imageId] = await trx("o_image").insert({
              assetsId: item.id,
              type: item.type,
              state: "生成中",
              resolution: projectSettingData.imageQuality,
              model: projectSettingData.imageModel,
            });
            imageIdMap[Number(item.id)] = Number(imageId);
            const updated = await trx("o_assets").where({ id: item.id, projectId }).update({ imageId });
            if (updated !== 1) throw new Error(`资产 ${item.id} 的图片任务绑定失败`);
          }
          return { assetIds: normalizedIds, imageIdMap, referenceImageIdMap };
        },
      );

      if (!claimed.duplicate || !activeAssetGenerationRequests.has(generationKey)) {
        activeAssetGenerationRequests.add(generationKey);
        ownsGenerationWorker = true;
      }

      const currentRows = await u.db("o_assets")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .where({ "o_assets.projectId": projectId })
        .whereIn("o_assets.id", normalizedIds)
        .select("o_assets.id", "o_image.state", "o_image.filePath", "o_image.errorReason", "o_assets.prompt");
      const currentData = await Promise.all(
        currentRows.map(async (item: any) => ({
          id: item.id,
          state: item.state ?? "未生成",
          src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : null,
          errorReason: item.errorReason ?? "",
          prompt: item.prompt ?? "",
        })),
      );
      res.status(200).send(success(currentData));

      if (!ownsGenerationWorker) return;
      // A later request may already own the asset's selected image. Recovery must
      // inspect this receipt's attempts, or retrying completed A while B is pending
      // would rerun A and overwrite its completed result.
      const receiptImages = claimed.duplicate
        ? await u.db("o_image").whereIn("id", Object.values(claimed.receipt.data.imageIdMap)).select("id", "assetsId", "state")
        : [];
      const generationIds = claimed.duplicate
        ? receiptImages
            .filter((item: any) => item.state === "生成中" && Number(item.id) === Number(claimed.receipt.data.imageIdMap[item.assetsId]))
            .map((item: any) => Number(item.assetsId))
        : normalizedIds;
      if (!generationIds.length) {
        activeAssetGenerationRequests.delete(generationKey);
        ownsGenerationWorker = false;
        return;
      }

      // 进程重启后内存中的 worker 锁会丢失；相同 requestId 若仍有“生成中”记录，
      // 使用原 operation receipt 里的 imageId 继续任务，而不是创建第二批 image 记录。
      const assetsDataArr = await u.db("o_assets")
        .where({ projectId })
        .whereIn("id", generationIds)
        .select("id", "describe", "name", "type", "assetsId");
      const visionDeps = { loadImage: (path: string) => u.oss.getImageBase64(path), invoke: (input: any) => u.Ai.Text("universalAi").invoke(input) };
      const referenceImageIdMap = claimed.receipt.data.referenceImageIdMap || {};

      const generateSingleAsset = async (item: any) => {
        const imageId = Number(claimed.receipt.data.imageIdMap[item.id]);
        try {
          const context = await loadAssetPromptContext(u.db, { projectId, assetsId: item.id, type: item.type, name: item.name, describe: item.describe || "" }, referenceImageIdMap);
          const manualKind = item.type === "role" ? "character" : item.type === "scene" ? "scene" : "prop";
          const manual = u.getArtPrompt(projectSettingData.artStyle!, "art_skills", `art_${manualKind}${context.parent ? "_derivative" : ""}`);
          if (!manual) throw new Error("视觉手册未定义");
          const text = await generateAssetPrompt(visionDeps, context, manual);
          await u.db("o_assets").where({ id: item.id, projectId }).update({ prompt: text, promptState: "已完成", promptErrorReason: null });
          const sourcePath = context.parent?.selectedImagePath || context.asset.selectedImagePath;
          const imageBase64 = sourcePath ? await u.oss.getImageBase64(sourcePath) : null;
          const repeloadObj = {
            prompt: text,
            size: projectSettingData.imageQuality as "1K" | "2K" | "4K",
            aspectRatio: "16:9" as `${number}:${number}`,
          };
          const imageCls = await u.Ai.Image(projectSettingData.imageModel as `${string}:${string}`).run(
            {
              referenceList: imageBase64 ? [{ type: "image", base64: imageBase64 }] : [],
              ...repeloadObj,
            },
            {
              taskClass: "生成图片",
              describe: "资产图片生成",
              relatedObjects: JSON.stringify(repeloadObj),
              projectId,
            },
          );
          const savePath = `/${projectId}/assets/${scriptId}/${item.type}/${u.uuid()}.jpg`;
          await imageCls.save(savePath);
          await u.db("o_image").where({ id: imageId, assetsId: item.id }).update({ filePath: savePath });
          await reviewAssetImage(visionDeps, context, text, savePath);
          // Generated role prompts use the reviewed four-column contract regardless of canvas ratio.
          const layout = "four_view" as const;
          const roleReferences = item.type === "role" ? await ensureRoleReferenceMedia(savePath, item.name, layout) : [];
          if (item.type === "role" && roleReferences.length < 2) throw new Error("新角色图片无法建立脸部和全身参考，已保留原图");
          const referenceFields = item.type === "role" ? {
            designStatus: "ready",
            designVersion: u.db.raw("COALESCE(designVersion, 0) + 1"),
            ...roleReferenceDatabaseFields(roleReferences, layout),
            referenceFingerprint: await roleReferenceFingerprint(savePath),
          } : null;
          await u.db.transaction(async (trx) => {
            const completed = await trx("o_image").where({ id: imageId, assetsId: item.id, state: "生成中" }).update({
              state: "已完成", filePath: savePath, errorReason: null,
            });
            // A later generation or manual selection may now own this asset. Its
            // selected image and reference crops must remain together.
            if (completed && referenceFields) {
              await trx("o_assets").where({ id: item.id, projectId, imageId }).update(referenceFields);
            }
          });
        } catch (reason) {
          // Keep the failed candidate for inspection and restore the previously selected result.
          if (Object.hasOwn(referenceImageIdMap, item.id)) {
            await u.db("o_assets").where({ id: item.id, projectId, imageId }).update({ imageId: referenceImageIdMap[item.id] });
          }
          await u.db("o_assets").where({ id: item.id, projectId }).update({ promptState: "生成失败", promptErrorReason: u.error(reason).message });
          await u.db("o_image").where({ id: imageId, assetsId: item.id }).update({
            state: "生成失败",
            errorReason: u.error(reason).message,
          });
        }
      };

      try {
        for (let i = 0; i < assetsDataArr.length; i += concurrentCount) {
          const batch = assetsDataArr.slice(i, i + concurrentCount);
          await Promise.all(batch.map(generateSingleAsset));
        }
      } finally {
        if (ownsGenerationWorker) {
          activeAssetGenerationRequests.delete(generationKey);
          ownsGenerationWorker = false;
        }
      }
    } catch (reason) {
      const message = u.error(reason).message;
      console.error("[assets/batchGenerateAssetsImage]", reason);
      if (ownsGenerationWorker) {
        activeAssetGenerationRequests.delete(generationKey);
        ownsGenerationWorker = false;
      }
      if (res.headersSent) {
        try {
          const receipt = await getOperationReceipt<{ imageIdMap: Record<number, number> }>(
            u.db,
            { projectId, episodesId: scriptId },
            "asset-generate",
            requestId,
          );
          const imageIds = Object.values(receipt?.data?.imageIdMap ?? {}).map(Number).filter(Number.isSafeInteger);
          if (imageIds.length) {
            await u.db("o_image").whereIn("id", imageIds).where({ state: "生成中" }).update({
              state: "生成失败",
              errorReason: `生成任务初始化失败：${message}`,
            });
          }
        } catch (markError) {
          console.error("[assets/batchGenerateAssetsImage] 标记初始化失败状态失败:", markError);
        }
        return;
      }
      return res.status(400).send(error(message));
    }
  },
);
