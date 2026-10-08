import express from "express";
import { readManagedPrompt } from "@/utils/managedPromptDefaults";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { tool, jsonSchema, stepCountIs } from "ai";
const router = express.Router();

// 获取资产
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    assetsIds: z.array(z.number()),
    concurrentCount: z.number().min(1).optional(),
  }),
  async (req, res) => {
    const { projectId, assetsIds, concurrentCount } = req.body;
    const assetsData = await u.db("o_assets").whereIn("id", assetsIds).andWhere("projectId", projectId).select("id", "name", "describe", "type");

    const audioData = await u
      .db("o_assets")
      .where("type", "audio")
      .whereNull("assetsId")
      .andWhere("projectId", projectId)
      .select("id", "name", "describe");

    if (!audioData.length) return res.status(400).send(error("暂无设置音频，请先前往资产中心上传音频"));

    const batchSize = concurrentCount ?? 1;

    async function processAsset(asset: (typeof assetsData)[number]) {
      try {
        // Collect the complete model response before touching an existing binding.
        const submissions: unknown[] = [];
        const resultTool = tool({
          description: "必须且只能调用一次提交匹配结果；无合适候选提交 audioId: null，保留已有绑定",
          inputSchema: jsonSchema<{ audioId: number | null }>({
            type: "object",
            properties: {
              audioId: {
                anyOf: [{ type: "integer", enum: audioData.map((i) => i.id) }, { type: "null" }],
                description: "候选列表中的单个数字音色ID；无合适匹配则为null，不是数组",
              },
            },
            required: ["audioId"],
            additionalProperties: false,
          }),
          execute: async (result) => {
            submissions.push(result);
            return "匹配结果已收集，请结束本轮，不要再次调用工具";
          },
        });

        const promptData = await u.db("o_prompt").where("type", "audioBindPrompt").first();
        const audioBindPrompt = promptData?.useData || promptData?.data
          || readManagedPrompt("audioBindPrompt");
        const response = await u.Ai.Text("universalAi").invoke({
          system: audioBindPrompt,
          messages: [
            {
              role: "user",
              content: JSON.stringify({ candidates: audioData, targetAsset: asset }),
            },
          ],
          tools: { resultTool },
          toolChoice: { type: "tool", toolName: "resultTool" },
          stopWhen: stepCountIs(1),
        });
        const toolCalls = response.steps.flatMap((step) => step.toolCalls);
        if (toolCalls.length !== 1 || toolCalls[0].toolName !== "resultTool" || submissions.length !== 1) {
          throw new Error("音色匹配必须提交一次有效结果，缺少或重复提交；保留已有绑定");
        }
        const result = z.object({ audioId: z.number().int().nullable() }).strict().parse(submissions[0]);
        if (result.audioId === null) throw new Error("没有合适的候选音色；保留已有绑定");
        if (!audioData.some((i) => i.id === result.audioId)) throw new Error("音色ID不在当前项目候选列表中；保留已有绑定");
        if (asset.type !== "role") throw new Error("仅角色资产可以绑定音色；保留已有绑定");
        await u.db.transaction(async (trx) => {
          await trx("o_assetsRole2Audio").where("assetsRoleId", asset.id).delete();
          await trx("o_assetsRole2Audio").insert({ assetsRoleId: asset.id, assetsAudioId: result.audioId });
          await trx("o_assets").where("id", asset.id).update("audioBindState", "已完成");
        });
      } catch (e) {
        await u.db("o_assets").where("id", asset.id).update("audioBindState", "生成失败");
        console.error(`[bindAudio] 资产 ${asset.id} 处理失败:`, e);
      }
    }

    async function runWithConcurrency() {
      for (let i = 0; i < assetsData.length; i += batchSize) {
        const batch = assetsData.slice(i, i + batchSize);

        await Promise.all(batch.map((asset) => processAsset(asset)));
      }
    }
    await u
      .db("o_assets")
      .whereIn(
        "id",
        assetsData.map((i) => i.id),
      )
      .update("audioBindState", "生成中");
    runWithConcurrency();
    res.status(200).send(success());
  },
);
