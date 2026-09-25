import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import sharp from "sharp";
import { ensureRoleReferenceMedia, roleReferenceDatabaseFields, roleReferenceFingerprint } from "@/utils/assetReferenceMedia";
const router = express.Router();

// These failures describe a finished candidate rejected by the new visual review,
// not a cancelled job, provider failure, invalid board, or missing output.
const isVisualReviewFailure = (reason: string | null | undefined) =>
  /^(?:新图片与资产设定不一致，保留原图：|图文一致性检查(?:未返回有效结果|结果不完整)，已保留原资产)/.test(reason || "");

// 保存资产图片。选择历史候选是用户的显式采用操作，不自动覆盖审核失败回执。
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    type: z.enum(["role", "scene", "tool"]),
    prompt: z.string().optional().nullable(),
    imageId: z.number().optional().nullable(),
    referenceLayout: z.enum(["four_view", "front_back"]).optional(),
  }),
  async (req, res) => {
    const { id, base64, type, prompt, projectId, imageId, referenceLayout: requestedLayout } = req.body;
    const asset = await u.db("o_assets").where({ id, projectId, type }).select("name", "imageId", "referenceLayout").first();
    if (!asset) return res.status(404).send(error("资产不存在、类型不符或不属于当前项目"));
    try {
      // A prompt blur/save does not select an image. Preserve every selected-image and reference field.
      if (!base64 && imageId === undefined) {
        if (prompt !== undefined) await u.db("o_assets").where({ id, projectId, type }).update({ prompt: prompt ?? "" });
        return res.status(200).send(success({ message: "资产提示词已保存", imageId: asset.imageId ?? null }));
      }
      let adoptedImageId = imageId ?? null;
      let adoptedPath: string | null = null;
      let adoptedModel: string | null = null;
      if (base64) {
        const realBase64 = base64.replace(/^data:image\/[^;]+;base64,/, "");
        const source = Buffer.from(realBase64, "base64");
        const metadata = await sharp(source).metadata();
        if (!metadata.width || !metadata.height) throw new Error("上传文件不是可用图片");
        const savePath = `/${projectId}/${type}/${uuidv4()}.png`;
        await u.oss.writeFile(savePath, await sharp(source).png().toBuffer());
        const [newImageId] = await u.db("o_image").insert({
          assetsId: id, filePath: savePath, type, state: "已完成",
          resolution: `${metadata.width}x${metadata.height}`,
        });
        adoptedImageId = newImageId;
        adoptedPath = savePath;
      } else if (adoptedImageId !== null) {
        const selected = await u.db("o_image").where({ id: adoptedImageId, assetsId: id, type }).first();
        if (!selected) throw new Error("所选图片不存在或不属于当前资产和类型");
        if (!selected.filePath) throw new Error("所选图片没有可用文件，不能采用");
        const manuallyAcceptedCandidate = selected.state === "生成失败" && isVisualReviewFailure(selected.errorReason);
        if (selected.state !== "已完成" && !manuallyAcceptedCandidate) throw new Error("所选图片尚未完成或不是可人工采用的审核候选");
        // Decode before any adoption write. A stale filePath must not clear the current selection.
        const source = await u.oss.getFile(selected.filePath);
        const metadata = await sharp(source).metadata();
        if (!metadata.width || !metadata.height) throw new Error("所选图片文件不可用，不能采用");
        adoptedModel = selected.model || null;
        adoptedPath = selected.filePath;
        if (manuallyAcceptedCandidate) {
          // Preserve the failed receipt and its output. A separate image/record records human adoption.
          const acceptedPath = `/${projectId}/${type}/${uuidv4()}.png`;
          await u.oss.writeFile(acceptedPath, await sharp(source).png().toBuffer());
          const [acceptedId] = await u.db("o_image").insert({
            assetsId: id, filePath: acceptedPath, type, state: "已完成", model: adoptedModel,
            resolution: `${metadata.width}x${metadata.height}`,
            errorReason: `人工采用审核候选 #${selected.id}；原审核意见：${selected.errorReason}`,
          });
          adoptedImageId = acceptedId;
          adoptedPath = acceptedPath;
        }
      }
      // All new/adopted character images use the four-view contract. Preserve a known legacy
      // two-panel layout only while keeping the very same selected image, or by explicit request.
      const referenceLayout: "four_view" | "front_back" = requestedLayout
        ?? (adoptedImageId === asset.imageId && asset.referenceLayout === "front_back" ? "front_back" : "four_view");
      const references = type === "role" && adoptedPath ? await ensureRoleReferenceMedia(adoptedPath, asset.name || "role", referenceLayout) : [];
      await u.db("o_assets").where({ id, projectId, type }).update({
        ...(prompt !== undefined ? { prompt: prompt ?? "" } : {}),
        imageId: adoptedImageId,
        ...(type === "role" && adoptedPath && references.length >= 2 ? {
          designStatus: "ready",
          designVersion: u.db.raw("COALESCE(designVersion, 0) + 1"),
          ...roleReferenceDatabaseFields(references, referenceLayout),
          referenceFingerprint: await roleReferenceFingerprint(adoptedPath),
        } : {}),
      });
      return res.status(200).send(success({ message: "保存资产图片成功", imageId: adoptedImageId }));
    } catch (cause) {
      return res.status(400).send(error(u.error(cause).message || "所选图片不可用，已保留原资产"));
    }
  },
);
