import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { characterCardOwner } from "@/utils/characterCards";
import { reviewCharacterCardCandidate } from "@/utils/characterCardCandidateReview";
import { buildCharacterCardImagePromptContext } from "@/utils/characterCardImagePromptContext";
import { reviewAssetImage } from "@/utils/assetPromptGeneration";
const router = express.Router();
export default router.post("/", validateFields({ id: z.number().int().positive(), version: z.number().int().positive(),
  attemptId: z.number().int().positive() }), async (req, res) => {
  try {
    const ownerId = characterCardOwner(req as any);
    const attempt = await u.db("o_characterCardImage").where({ id: req.body.attemptId, ownerId }).first();
    if (!attempt || attempt.cardId !== req.body.id || attempt.baseVersion !== req.body.version) return res.status(400).send(error("候选图片与当前角色卡版本不一致"));
    void reviewCharacterCardCandidate({ db: u.db,
      started: ({ attemptId, cardId }) => { res.send(success({ attemptId, cardId }, "已开始复核原图片，不会重新绘图")); },
      review: (card, candidate) => reviewAssetImage({ loadImage: path => u.oss.getImageBase64(path),
        invoke: input => u.Ai.Text("universalAi").invoke(input) }, buildCharacterCardImagePromptContext(card),
        candidate.prompt, candidate.filePath!, { fourViewEvidence: true }),
    }, { attemptId: req.body.attemptId, ownerId }).catch(cause => {
      if (!res.headersSent) res.status(400).send(error((cause as Error).message));
      else console.error("角色卡图片复核状态保存失败", cause);
    });
  } catch (cause) { if (!res.headersSent) res.status(400).send(error((cause as Error).message)); }
});
