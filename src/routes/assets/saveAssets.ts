import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import sharp from "sharp";
import { ensureRoleReferenceMedia, roleReferenceFingerprint } from "@/utils/assetReferenceMedia";
const router = express.Router();

// 保存资产图片
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    type: z.enum(["role", "scene", "tool"]),
    prompt: z.string().optional().nullable(),
    imageId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    const { id, base64, type, prompt, projectId, imageId } = req.body;
    const asset = await u.db("o_assets").where({ id, projectId }).select("name").first();
    if (!asset) return res.status(404).send({ code: 404, message: "资产不存在" });
    let adoptedImageId = imageId ?? null;
    let adoptedPath: string | null = null;
    if (base64) {
      //自定义上传选择的图片
      const matches = base64.match(/^data:image\/\w+;base64,(.+)$/);
      const realBase64 = matches ? matches[1] : base64;
      // 生成新的图片路径
      const savePath = `/${projectId}/${type}/${uuidv4()}.png`;
      // 写入文件
      await u.oss.writeFile(savePath, Buffer.from(realBase64, "base64"));
      // 插入图片表
      const [idData] = await u.db("o_image").insert({
        assetsId: id,
        filePath: savePath,
        type: type,
        state: "已完成",
      });
      adoptedImageId = idData;
      adoptedPath = savePath;
      const metadata = await sharp(await u.oss.getFile(savePath)).metadata();
      await u.db("o_image").where("id", idData).update({
        resolution: metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null,
      });
    } else if (adoptedImageId) {
      const selected = await u.db("o_image").where({ id: adoptedImageId, assetsId: id }).select("filePath").first();
      adoptedPath = selected?.filePath || null;
    }
    const references = type === "role" && adoptedPath ? await ensureRoleReferenceMedia(adoptedPath, asset.name || "role") : [];
    await u.db("o_assets").where({ id, projectId }).update({
      prompt: prompt ?? "",
      imageId: adoptedImageId,
      ...(type === "role" && adoptedPath && references.length >= 2
        ? {
            designStatus: "ready",
            designVersion: u.db.raw("COALESCE(designVersion, 0) + 1"),
            faceReferencePath: references[0].path,
            fullBodyReferencePath: references[1].path,
            referenceFingerprint: await roleReferenceFingerprint(adoptedPath),
          }
        : {}),
    });
    res.status(200).send(success({ message: "保存资产图片成功" }));
  },
);
