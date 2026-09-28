import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { descriptionMeta, saveDescription } from "@/utils/assetDescriptionVersion";
const router = express.Router();

// 更新资产
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    name: z.string(),
    describe: z.string(),
    remark: z.string().optional().nullable(),
    prompt: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { id, projectId, name, describe, remark, prompt } = req.body;
    try {
      await u.db.transaction(async trx => {
        const asset = await trx("o_assets").where({ id, projectId }).first();
        if (!asset) throw new Error("资产不存在或不属于当前项目");
        if ((asset.describe || "").trim() !== describe.trim()) {
          await saveDescription(trx, asset, describe, { ...descriptionMeta(asset), source: "user", userConstraints: describe.trim(),
            changedFields: ["face", "body", "hair", "clothing", "environment", "shape"], visualDesign: {}, updatedAt: Date.now() });
        }
        await trx("o_assets").where({ id, projectId }).update({ name, remark, prompt });
      });
    } catch (cause) { return res.status(400).send(error(u.error(cause).message)); }
    res.status(200).send(success({ message: "更新资产成功" }));
  },
);
