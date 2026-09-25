import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ensureRoleReferenceMedia, roleReferenceDatabaseFields, roleReferenceFingerprint } from "@/utils/assetReferenceMedia";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number(), assetsId: z.number() }),
  async (req, res) => {
    const { projectId, assetsId } = req.body;
    const asset = await u.db("o_assets")
      .where({ "o_assets.id": assetsId, "o_assets.projectId": projectId, "o_assets.type": "role" })
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_assets.name", "o_image.filePath", "o_image.model")
      .first();
    if (!asset) return res.status(404).send(error("人物资产不存在"));
    if (!asset.filePath) return res.status(409).send(error("请先生成或选择一张人物角色图"));
    try {
      const layout = asset.model === "qwen-image-2.1-fourview-local" ? "four_view" : "auto";
      const references = await ensureRoleReferenceMedia(asset.filePath, asset.name || "role", layout);
      if (references.length < 2) return res.status(422).send(error("当前人物图尺寸无效，无法生成身份参考"));
      await u.db("o_assets").where({ id: assetsId, projectId }).update({
        designStatus: "ready",
        designVersion: u.db.raw("COALESCE(designVersion, 0) + 1"),
        ...roleReferenceDatabaseFields(references, layout === "four_view" ? "four_view" : references.length >= 4 ? "four_view" : "front_back"),
        referenceFingerprint: await roleReferenceFingerprint(asset.filePath),
      });
      const updated = await u.db("o_assets").where({ id: assetsId, projectId }).select("designVersion").first();
      return res.send(success({
        designStatus: "ready",
        designVersion: updated?.designVersion,
        faceReferenceUrl: await u.oss.getFileUrl(references[0].path),
        fullBodyReferenceUrl: await u.oss.getFileUrl(references[1].path),
        sideReferenceUrl: references.find(item => item.referenceKind === "FULL_BODY_SIDE")?.path
          ? await u.oss.getFileUrl(references.find(item => item.referenceKind === "FULL_BODY_SIDE")!.path) : null,
        backReferenceUrl: references.find(item => item.referenceKind === "FULL_BODY_BACK")?.path
          ? await u.oss.getFileUrl(references.find(item => item.referenceKind === "FULL_BODY_BACK")!.path) : null,
      }));
    } catch (cause) {
      return res.status(422).send(error(`生成身份参考失败：${u.error(cause).message}`));
    }
  },
);
