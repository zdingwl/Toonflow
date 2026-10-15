import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { characterAgeBands, characterCardOwner, characterCardSummary, searchCharacterCards } from "@/utils/characterCards";
import { hydrateCharacterCard } from "@/utils/characterCardImageResponse";
import { getCharacterCardImagePhase } from "@/utils/characterCardImageGeneration";
const router = express.Router();
export default router.post("/", validateFields({
  artStyle: z.string().trim().min(1), roleDefinition: z.string().optional(),
  ageBand: z.enum(characterAgeBands).optional(), ageMin: z.number().int().min(0).max(120).nullable().optional(),
  ageMax: z.number().int().min(0).max(120).nullable().optional(), gender: z.string().optional(),
}), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const cards = await searchCharacterCards(u.db, { ...req.body, ownerId, limit: 3 });
    const list = await Promise.all(cards.map(async card => {
      const hydrated = await hydrateCharacterCard(u.db, card, ownerId, u.oss, getCharacterCardImagePhase);
      return { ...characterCardSummary(card), score: card.score, matchKind: card.matchKind,
        imageUrl: hydrated.imageUrl, imageFullUrl: hydrated.imageFullUrl, imageGeneration: hydrated.imageGeneration,
        candidateImageUrl: hydrated.candidateImageUrl, candidateFullUrl: hydrated.candidateFullUrl,
        imageState: hydrated.imageState, imageNeedsRegeneration: hydrated.imageNeedsRegeneration, imageErrorReason: hydrated.imageErrorReason };
    }));
    res.send(success({ list }));
  } catch (cause) { res.status(400).send(error((cause as Error).message)); }
});
