import express from "express";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import path from "path";
import { assertVideoTemplateCompatible, listVideoPromptTemplates } from "@/utils/modelPromptTemplates";
const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const root = u.getPath(["modelPrompt"]);
    const model = typeof req.query.model === "string" ? req.query.model : undefined;
    const bindings = await u.db("o_modelPrompt").select("path");
    const normalize = (value: string) => process.platform === "win32" ? path.resolve(root, value).toLowerCase() : path.resolve(root, value);
    const templates = (await listVideoPromptTemplates(root)).filter(record => {
      if (!model) return true;
      try { assertVideoTemplateCompatible(record, model); return true; } catch { return false; }
    }).map(record => ({ ...record, deletable: record.deletable && !bindings.some(binding => typeof binding.path === "string" && normalize(binding.path) === normalize(record.path)) }));
    res.status(200).send(success(templates));
  } catch (cause) {
    res.status((cause as any).status || 500).send(error(u.error(cause).message));
  }
});
