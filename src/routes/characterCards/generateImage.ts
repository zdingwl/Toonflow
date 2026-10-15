import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { beginCharacterCardImage, characterCardOwner, getCharacterCard } from "@/utils/characterCards";
import { resolveAssetImageModel } from "@/utils/assetImageModel";
import { characterCardImageQueue } from "@/utils/characterCardImageGeneration";
import { renderCharacterCardImage } from "@/utils/characterCardImageRenderer";
const router = express.Router();
export default router.post("/", validateFields({ id: z.number().int().positive(), version: z.number().int().positive(),
  model: z.string().min(1), resolution: z.enum(["1K", "2K", "4K"]) }), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const card = await getCharacterCard(u.db, req.body.id, ownerId);
    if (!card) return res.status(404).send(error("角色卡不存在或无权访问"));
    const model = await resolveAssetImageModel(req.body.model, "role");
    const attempt = await beginCharacterCardImage(u.db, { cardId: req.body.id, baseVersion: req.body.version,
      ownerId, prompt: JSON.stringify(card.visualDesign), model, resolution: req.body.resolution });
    if (!attempt.duplicate) void characterCardImageQueue({ db: u.db, render: renderCharacterCardImage }).enqueue(attempt)
      .catch(cause => console.error("角色卡图片任务状态保存失败", cause));
    res.send(success({ attemptId: attempt.id, cardId: attempt.cardId, duplicate: !!attempt.duplicate }, "角色卡图片已加入生成队列"));
  } catch (cause) { res.status(400).send(error((cause as Error).message)); }
});
