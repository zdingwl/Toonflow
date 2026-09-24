import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { latestAssetImageAttempts } from "@/utils/latestAssetImageAttempts";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    // imageId intentionally remains on the last successful image while a new
    // batch job runs. Poll the newest image attempt for each asset instead of
    // joining through o_assets.imageId, otherwise first-time jobs are invisible
    // and regenerations incorrectly report the previous completed image.
    const attempts = await u
      .db("o_image")
      .whereIn("assetsId", ids)
      .select("id", "assetsId", "state", "filePath", "errorReason")
      .orderBy("id", "desc");
    const data = latestAssetImageAttempts(attempts).filter((item) => item.state !== "生成中");
    const result = await Promise.all(
      data.map(async (item: any) => ({
        id: item.assetsId,
        state: item.state,
        errorReason: item.errorReason,
        filePath: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : null,
      })),
    );
    res.status(200).send(success(result));
  },
);
