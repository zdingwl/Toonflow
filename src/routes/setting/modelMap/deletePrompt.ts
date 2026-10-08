import express from "express";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import path from "path";
import { deleteVideoPromptTemplate, readVideoPromptTemplate } from "@/utils/modelPromptTemplates";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    path: z.string(),
  }),
  async (req, res) => {
    try {
      const root = u.getPath(["modelPrompt"]);
      const record = await readVideoPromptTemplate(root, req.body.path);
      const normalize = (value: string) => process.platform === "win32" ? path.resolve(root, value).toLowerCase() : path.resolve(root, value);
      const bindings = await u.db("o_modelPrompt").select("path");
      if (bindings.some(binding => typeof binding.path === "string" && normalize(binding.path) === normalize(record.path))) {
        return res.status(400).send(error("这个模板仍被模型使用，请先取消相关绑定"));
      }
      await deleteVideoPromptTemplate(root, record.path);
      res.status(200).send(success("删除成功"));
    } catch (cause) {
      res.status((cause as any).status || 500).send(error(u.error(cause).message));
    }
  },
);
