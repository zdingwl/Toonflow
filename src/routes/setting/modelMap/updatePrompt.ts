import express from "express";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import path from "path";
import { assertVideoTemplateCompatible, parseVideoPromptTemplate, writeVideoPromptTemplate } from "@/utils/modelPromptTemplates";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string().min(1),
    data: z.string(),
    type: z.literal("video"),
  }),
  async (req, res) => {
    try {
      const root = u.getPath(["modelPrompt"]);
      const record = parseVideoPromptTemplate(req.body.name, req.body.data);
      const normalize = (value: string) => process.platform === "win32" ? path.resolve(root, value).toLowerCase() : path.resolve(root, value);
      const bindings = await u.db("o_modelPrompt").select("path", "model");
      for (const binding of bindings) {
        if (typeof binding.path === "string" && normalize(binding.path) === normalize(record.path)) assertVideoTemplateCompatible(record, binding.model!);
      }
      const saved = await writeVideoPromptTemplate(root, req.body, false);
      res.status(200).send(success(saved, "更新成功"));
    } catch (cause) {
      res.status((cause as any).status || 500).send(error(u.error(cause).message));
    }
  },
);
