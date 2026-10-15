import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { archiveCharacterCard, characterCardOwner } from "@/utils/characterCards";
import { hydrateCharacterCard } from "@/utils/characterCardImageResponse";
import { getCharacterCardImagePhase } from "@/utils/characterCardImageGeneration";
const router = express.Router();
export default router.post("/", validateFields({ id: z.number().int().positive(), version: z.number().int().positive().optional() }), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const card = await archiveCharacterCard(u.db, req.body.id, ownerId, req.body.version);
    res.send(success(await hydrateCharacterCard(u.db, card, ownerId, u.oss, getCharacterCardImagePhase), "角色卡已归档"));
  }
  catch (cause) { res.status(400).send(error((cause as Error).message)); }
});
