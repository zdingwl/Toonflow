import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readStoryboardProgress } from "@/agents/productionAgent/storyboardProgress";
import { readStoryboardTableSnapshot } from "@/agents/productionAgent/storyboardTable";
import { storyboardSceneHash } from "@/agents/productionAgent/storyboardRevision";

const router = express.Router();

/** Read the actual SQLite snapshot; clients must not invent task IDs or revision tokens. */
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    episodesId: z.number().int().positive(),
  }),
  async (req, res) => {
    try {
      const { projectId, episodesId } = req.body;
      const progress = await readStoryboardProgress(u.db, projectId, episodesId);
      if (!progress.valid || progress.mode !== "scene") {
        throw new Error(progress.conflict?.message ?? "当前工作区没有可修订的逐场分镜进度");
      }
      const snapshot = await readStoryboardTableSnapshot(u.db, projectId, episodesId);
      const scenes = snapshot.storyboardTableProgress?.scenes ?? {};
      if (snapshot.storyboardTableProgress?.taskId !== progress.taskId ||
          snapshot.storyboardTableProgress?.revision !== progress.revision) {
        throw new Error("读取期间分镜进度发生变化，请重新获取修订上下文");
      }
      return res.status(200).send(success({
        taskId: progress.taskId,
        total: progress.total,
        revision: progress.revision,
        savedScenes: progress.savedScenes,
        missingScenes: progress.missingScenes,
        scenes: Object.fromEntries(Object.entries(scenes).map(([scene, text]) => [scene, {
          content: text,
          hash: storyboardSceneHash(text),
        }])),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取分镜修订上下文";
      return res.status(409).send({ code: 409, message, data: null });
    }
  },
);
