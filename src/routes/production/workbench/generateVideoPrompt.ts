import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { dialogueLanguagesSchema } from "@/utils/videoLanguages";
import { generateVideoPromptForTrack } from "@/utils/videoPromptGeneration";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    trackId: z.number(),
    languages: dialogueLanguagesSchema.optional(),
    regenerate: z.boolean().optional(),
    replaceBasePrompt: z.boolean().optional(),
    projectId: z.number(),
    info: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
        reference: z.boolean().optional(),
        slotType: z.string().optional(),
        fileType: z.string().optional(),
        prompt: z.string().optional(),
      }),
    ),
    model: z.string(),
    mode: z.string(),
  }),
  async (req, res) => {
    try { return res.status(200).send(success(await generateVideoPromptForTrack(req.body))); }
    catch (cause: any) { return res.status([404, 409].includes(cause.status) ? cause.status : 400).send(error(cause.message)); }
  },
);
