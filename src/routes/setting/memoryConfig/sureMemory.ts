import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { disposeEmbedding } from "@/utils/agent/embedding";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    messagesPerSummary: z.number().int().min(1).max(200),
    shortTermLimit: z.number().int().min(1).max(100),
    summaryMaxLength: z.number().int().min(0).max(4000),
    summaryLimit: z.number().int().min(0).max(100),
    ragLimit: z.number().int().min(0).max(50),
    deepRetrieveSummaryLimit: z.number().int().min(0).max(100),
    modelOnnxFile: z.array(z.string().min(1)).length(3),
    modelDtype: z.enum(["auto", "fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16"]),
    embeddingBackend: z.enum(["onnx", "ollama"]).optional(),
    ollamaEmbeddingModel: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).optional(),
    memoryHybridRetrieval: z.boolean().optional(),
    memoryRerankerEnabled: z.boolean().optional(),
    memoryRerankerUrl: z.string().url().max(256).optional(),
    memoryRerankerModel: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).optional(),
    memoryRerankerCandidates: z.number().int().min(8).max(100).optional(),
    memoryContextTokenBudget: z.number().int().min(400).max(32768).optional(),
    memoryVectorScanPageSize: z.number().int().min(64).max(2000).optional(),
  }),
  async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const settings: Record<string, string> = {
      messagesPerSummary: String(body.messagesPerSummary),
      shortTermLimit: String(body.shortTermLimit),
      summaryMaxLength: String(body.summaryMaxLength),
      summaryLimit: String(body.summaryLimit),
      ragLimit: String(body.ragLimit),
      deepRetrieveSummaryLimit: String(body.deepRetrieveSummaryLimit),
      modelOnnxFile: JSON.stringify(body.modelOnnxFile),
      modelDtype: String(body.modelDtype),
    };

    const optionalStringKeys = [
      "embeddingBackend",
      "ollamaEmbeddingModel",
      "memoryRerankerUrl",
      "memoryRerankerModel",
    ];
    const optionalNumberKeys = [
      "memoryRerankerCandidates",
      "memoryContextTokenBudget",
      "memoryVectorScanPageSize",
    ];
    const optionalBooleanKeys = ["memoryHybridRetrieval", "memoryRerankerEnabled"];

    for (const key of optionalStringKeys) {
      if (body[key] !== undefined) settings[key] = String(body[key]);
    }
    for (const key of optionalNumberKeys) {
      if (body[key] !== undefined) settings[key] = String(body[key]);
    }
    for (const key of optionalBooleanKeys) {
      if (body[key] !== undefined) settings[key] = body[key] ? "1" : "0";
    }

    await u.db.transaction(async (trx) => {
      for (const [key, value] of Object.entries(settings)) {
        const exists = await trx("o_setting").where({ key }).first();
        if (exists) await trx("o_setting").where({ key }).update({ value });
        else await trx("o_setting").insert({ key, value });
      }
    });

    // Embedding 实例会缓存已加载模型；保存配置后立即释放，下一次检索按新配置重新加载。
    await disposeEmbedding();
    res.status(200).send(success("保存设置成功"));
  },
);
