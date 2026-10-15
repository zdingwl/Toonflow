import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { characterAgeBands, characterCardOwner, listCharacterCards } from "@/utils/characterCards";
import { hydrateCharacterCard } from "@/utils/characterCardImageResponse";
import { getCharacterCardImagePhase } from "@/utils/characterCardImageGeneration";
const router = express.Router();
export default router.post("/", validateFields({
  artStyle: z.string().optional(), roleDefinition: z.string().optional(), keyword: z.string().optional(),
  ageBand: z.enum(characterAgeBands).optional(), ageMin: z.number().int().min(0).max(120).nullable().optional(),
  ageMax: z.number().int().min(0).max(120).nullable().optional(), gender: z.string().optional(),
  projectId: z.number().int().positive().optional(), includeArchived: z.boolean().optional(),
}), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const cards = await listCharacterCards(u.db, { ...req.body, ownerId });
    const list = await Promise.all(cards.map(card => hydrateCharacterCard(u.db, card, ownerId, u.oss, getCharacterCardImagePhase)));
    res.send(success({ list }));
  } catch (cause) { res.status(400).send(error((cause as Error).message)); }
});
