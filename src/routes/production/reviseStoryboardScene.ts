import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { reviseStoryboardScene } from "@/agents/productionAgent/storyboardRevision";

const router = express.Router();

/** Explicit revisions only. Automatic workspace snapshots must never overwrite Agent scene progress. */
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    episodesId: z.number().int().positive(),
    taskId: z.string().min(8).max(128),
    scene: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    expectedSceneHash: z.string().regex(/^[a-f0-9]{64}$/),
    revisedScene: z.string().min(1).max(60000),
    reason: z.string().min(1).max(2000),
  }),
  async (req, res) => {
    try {
      const result = await reviseStoryboardScene(u.db, req.body);
      return res.status(200).send(success(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : "分镜修订失败";
      console.error("[production/reviseStoryboardScene]", error);
      return res.status(409).send({ code: 409, message, data: null });
    }
  },
);
