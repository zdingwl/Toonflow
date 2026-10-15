import express from "express";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { getAssetExtractionProgress } from "@/utils/assetExtractionCheckpoint";
const router = express.Router();

export default router.post("/", validateFields({ projectId: z.number() }), async (req, res) => {
  const project = await u.db("o_project").where({ id: req.body.projectId, userId: (req as any).user?.id }).first();
  if (!project) return res.status(404).send(error("项目不存在或不属于当前用户"));
  return res.send(success(await getAssetExtractionProgress(u.db, req.body.projectId)));
});
