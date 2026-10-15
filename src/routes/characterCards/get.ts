import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { characterCardOwner, getCharacterCard } from "@/utils/characterCards";
import { hydrateCharacterCard } from "@/utils/characterCardImageResponse";
import { getCharacterCardImagePhase } from "@/utils/characterCardImageGeneration";
const router = express.Router();
export default router.post("/", validateFields({ id: z.number().int().positive(), version: z.number().int().positive().optional() }), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const card = await getCharacterCard(u.db, req.body.id, ownerId, req.body.version);
    if (!card) return res.status(404).send(error("角色卡不存在或无权访问"));
    res.send(success(await hydrateCharacterCard(u.db, card, ownerId, u.oss, getCharacterCardImagePhase)));
  } catch (cause) { res.status(400).send(error((cause as Error).message)); }
});
