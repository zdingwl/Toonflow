import express from "express";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

const KEYS = [
  "messagesPerSummary",
  "shortTermLimit",
  "summaryMaxLength",
  "summaryLimit",
  "ragLimit",
  "deepRetrieveSummaryLimit",
  "modelOnnxFile",
  "modelDtype",
  "embeddingBackend",
  "ollamaEmbeddingModel",
  "memoryHybridRetrieval",
  "memoryRerankerEnabled",
  "memoryRerankerUrl",
  "memoryRerankerModel",
  "memoryRerankerCandidates",
  "memoryContextTokenBudget",
  "memoryVectorScanPageSize",
] as const;

const NUMBER_KEYS = new Set([
  "messagesPerSummary",
  "shortTermLimit",
  "summaryMaxLength",
  "summaryLimit",
  "ragLimit",
  "deepRetrieveSummaryLimit",
  "memoryRerankerCandidates",
  "memoryContextTokenBudget",
  "memoryVectorScanPageSize",
]);

const BOOLEAN_KEYS = new Set(["memoryHybridRetrieval", "memoryRerankerEnabled"]);

export default router.get("/", async (_req, res) => {
  try {
    const settingData = await u.db("o_setting").whereIn("key", [...KEYS]).select("key", "value");
    const memoryObj: Record<string, number | string | string[] | boolean> = {};

    for (const item of settingData) {
      if (!item.key || item.value == null) continue;
      if (item.key === "modelOnnxFile") {
        memoryObj[item.key] = JSON.parse(item.value);
      } else if (BOOLEAN_KEYS.has(item.key)) {
        memoryObj[item.key] = item.value === "1";
      } else if (NUMBER_KEYS.has(item.key)) {
        const value = Number(item.value);
        if (Number.isFinite(value)) memoryObj[item.key] = value;
      } else {
        memoryObj[item.key] = item.value;
      }
    }

    res.status(200).send(success(memoryObj));
  } catch (reason) {
    console.error("[memoryConfig/getMemory]", reason);
    res.status(400).send(error("获取记忆配置失败"));
  }
});
