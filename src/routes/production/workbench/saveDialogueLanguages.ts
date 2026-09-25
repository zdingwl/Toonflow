import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { dialogueLanguagesSchema } from "@/utils/videoLanguages";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
const router = express.Router();
export default router.post("/", validateFields({ projectId: z.number(), scriptId: z.number(), languages: dialogueLanguagesSchema }), async (req, res) => {
  const { projectId, scriptId, languages } = req.body;
  if (!(await db("o_project").where({ id: projectId }).first())) return res.status(404).send(error("项目不存在"));
  await db("o_videoLanguageSelection")
    .insert({ projectId, scriptId, languages: JSON.stringify(languages) })
    .onConflict(["projectId", "scriptId"])
    .merge();
  const saved = await db("o_videoLanguageSelection").where({ projectId, scriptId }).first();
  res.send(success(JSON.parse(saved.languages)));
});
