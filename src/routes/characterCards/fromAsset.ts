import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { characterAgeBands, characterCardFromAsset, characterCardOwner } from "@/utils/characterCards";
import { hydrateCharacterCard } from "@/utils/characterCardImageResponse";
import { getCharacterCardImagePhase } from "@/utils/characterCardImageGeneration";
const router = express.Router();
export default router.post("/", validateFields({
  assetId: z.number().int().positive(), projectId: z.number().int().positive().optional(), name: z.string().trim().min(1).max(100).optional(),
  roleDefinition: z.string().trim().min(1).max(600).optional(), ageBand: z.enum(characterAgeBands).optional(),
  ageMin: z.number().int().min(0).max(120).nullable().optional(), ageMax: z.number().int().min(0).max(120).nullable().optional(), gender: z.string().optional(),
}), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const card = await characterCardFromAsset(u.db, req.body, ownerId);
    res.send(success(await hydrateCharacterCard(u.db, card, ownerId, u.oss, getCharacterCardImagePhase), "人物外观已加入角色卡库"));
  }
  catch (cause) { res.status(400).send(error((cause as Error).message)); }
});
