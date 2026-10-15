import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { characterCardInputSchema, characterCardOwner, saveCharacterCard } from "@/utils/characterCards";
import { hydrateCharacterCard } from "@/utils/characterCardImageResponse";
import { getCharacterCardImagePhase } from "@/utils/characterCardImageGeneration";
const router = express.Router();
export default router.post("/", validateFields({ card: characterCardInputSchema }), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const card = await saveCharacterCard(u.db, req.body.card, ownerId);
    res.send(success(await hydrateCharacterCard(u.db, card, ownerId, u.oss, getCharacterCardImagePhase), "角色卡已保存"));
  }
  catch (cause) { res.status(400).send(error((cause as Error).message)); }
});
