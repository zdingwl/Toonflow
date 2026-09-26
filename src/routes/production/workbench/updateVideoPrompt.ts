import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { db as languageDb } from "@/utils/db";
import { dialogueLanguageSchema } from "@/utils/videoLanguages";
import { copyH3ReferencePlan } from "@/utils/h3ReferencePlan";
const router = express.Router();
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    language: dialogueLanguageSchema.optional(),
    prompt: z.string().optional(),
  }),
  async (req, res) => {
    const { id, prompt } = req.body;
    const track = await u.db("o_videoTrack").where({ id }).first();
    if (!track) return res.status(404).send(error("视频段不存在"));
    const preservePlan = async (source: string) => {
      if (typeof prompt === "string" && prompt.trim()) await copyH3ReferencePlan(languageDb, id, source || "", prompt, false);
    };
    if (req.body.language) {
      if (!(await u.db("o_videoTrack").where({ id }).first())) return res.status(404).send(error("视频段不存在"));
      const variant = await languageDb("o_videoPromptVariant").where({ trackId: id, language: req.body.language }).first();
      if (variant?.state === "生成中") return res.status(409).send(error("该语言提示词正在生成，请完成后再编辑"));
      try { await preservePlan(variant?.prompt || ""); }
      catch (cause: any) { return res.status(409).send(error(cause.message)); }
      await languageDb("o_videoPromptVariant")
        .insert({ trackId: id, language: req.body.language, prompt: prompt || "", state: prompt?.trim() ? "已完成" : "未生成", reason: null })
        .onConflict(["trackId", "language"])
        .merge();
      return res.status(200).send(success("更新成功"));
    }
    if (track.state === "生成中") return res.status(409).send(error("提示词正在生成，请完成后再编辑"));
    try { await preservePlan(track.prompt || ""); }
    catch (cause: any) { return res.status(409).send(error(cause.message)); }
    await u.db("o_videoTrack").where("id", id).update({
      prompt,
    });
    res.status(200).send(success("更新成功"));
  },
);
