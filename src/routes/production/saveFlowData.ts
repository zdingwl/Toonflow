import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { flowDataSchema } from "@/agents/productionAgent/tools";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    data: z.any(),
  }),
  async (req, res) => {
    const { data, projectId, episodesId }: {
      data: z.infer<typeof flowDataSchema>;
      projectId: number;
      episodesId: number;
    } = req.body;
    const serialized = JSON.stringify(data);
    if (serialized === undefined || !data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).send({ code: 400, message: "工作区数据格式错误", data: null });
    }

    try {
      await u.db.transaction(async (trx) => {
        // 仅在所有分镜已有真实 ID 时更新排序；临时分镜仍沿用原有保存路径。
        if (Array.isArray(data.storyboard) && data.storyboard.length && data.storyboard.every((item) => item.id)) {
          for (const [index, item] of data.storyboard.entries()) {
            const updated = await trx("o_storyboard")
              .where({ id: item.id, projectId, scriptId: episodesId })
              .update({ index });
            if (updated !== 1) {
              throw new Error(`分镜 ${item.id} 不属于当前项目和剧本，工作区未保存`);
            }
          }
        }

        const scope = { projectId, episodesId, key: "productionAgent" };
        const existing = await trx("o_agentWorkData").where(scope).first();
        if (existing) {
          const updated = await trx("o_agentWorkData").where(scope).update({ data: serialized });
          if (updated !== 1) throw new Error("工作区记录更新失败");
        } else {
          await trx("o_agentWorkData").insert({ ...scope, data: serialized });
        }
        const saved = await trx("o_agentWorkData").where(scope).select("data").first();
        if (!saved || saved.data !== serialized) throw new Error("工作区数据写入校验失败");
      });
      return res.status(200).send(success());
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "工作区保存失败";
      console.error("[production/saveFlowData]", reason);
      return res.status(400).send({ code: 400, message, data: null });
    }
  },
);
