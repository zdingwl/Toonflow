import express from "express";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { writeVideoPromptTemplate } from "@/utils/modelPromptTemplates";

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
      const record = await writeVideoPromptTemplate(u.getPath(["modelPrompt"]), req.body, true);
      res.status(200).send(success(record, "保存成功"));
    } catch (cause) {
      res.status((cause as any).status || 500).send(error(u.error(cause).message));
    }
  },
);
