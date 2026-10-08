import express from "express";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { assertVideoTemplateCompatible, readVideoPromptTemplate } from "@/utils/modelPromptTemplates";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    vendorId: z.string().min(1),
    model: z.string().min(1),
    path: z.string(),
    fileName: z.string(),
  }),
  async (req, res) => {
    try {
      const { vendorId, model, path, fileName } = req.body;
      const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
      const vendor = await u.db("o_vendorConfig").where("id", vendorId).select("id", "enable").first();
      if (!vendor || vendor.enable !== 1) throw invalid("供应商不存在或未启用");
      const selectedModel = (await u.vendor.getModelList(vendorId)).find((candidate: any) => candidate.modelName === model && candidate.type === "video");
      if (!selectedModel) throw invalid("当前供应商不存在这个视频模型");
      if (!path && !fileName) {
        await u.db.transaction(async trx => { await trx("o_modelPrompt").where({ vendorId, model }).delete(); });
        return res.status(200).send(success("已恢复自动规则"));
      }
      if (!path || !fileName) throw invalid("模板路径和名称必须同时填写");
      const record = await readVideoPromptTemplate(u.getPath(["modelPrompt"]), path);
      if (fileName !== record.name) throw invalid("模板名称与文件不一致");
      assertVideoTemplateCompatible(record, model, selectedModel.mode);
      await u.db.transaction(async trx => {
        const current = await trx("o_modelPrompt").where({ vendorId, model }).first();
        if (current) await trx("o_modelPrompt").where({ vendorId, model }).update({ path: record.path, fileName: record.name });
        else await trx("o_modelPrompt").insert({ vendorId, model, path: record.path, fileName: record.name });
      });
      res.status(200).send(success("绑定成功"));
    } catch (cause) {
      res.status((cause as any).status || 500).send(error(u.error(cause).message));
    }
  },
);
