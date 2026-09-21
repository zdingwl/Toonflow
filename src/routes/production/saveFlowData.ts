import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { mergeStoryboardScene, type StoryboardTableProgress } from "@/utils/storyboardScenes";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    data: z.any().optional(),
    scene: z.object({
      taskId: z.string().min(8).max(128),
      index: z.number().int().min(1),
      total: z.number().int().min(1).max(1000),
      content: z.string().min(1).max(60000),
    }).optional(),
    writeFields: z.array(z.enum(["scriptPlan", "storyboardTable"])).max(2).optional(),
  }),
  async (req, res) => {
    const { data, projectId, episodesId, scene, writeFields = [] } = req.body;
    if (scene && data !== undefined) return res.status(400).send({ code: 400, message: "单场保存与整份工作区保存不能同时提交", data: null });
    const serialized = scene ? undefined : JSON.stringify(data);
    if (!scene && (serialized === undefined || !data || typeof data !== "object" || Array.isArray(data))) {
      return res.status(400).send({ code: 400, message: "工作区数据格式错误", data: null });
    }

    try {
      const result = await u.db.transaction(async (trx) => {
        const scope = { projectId, episodesId, key: "productionAgent" };
        const script = await trx("o_script").where({ id: episodesId, projectId }).first();
        if (!script) throw new Error("当前项目不存在该集剧本");
        const existing = await trx("o_agentWorkData").where(scope).first();
        const storedData = existing ? JSON.parse(existing.data || "{}") : {
          script: script.content ?? "", scriptPlan: "", assets: [], storyboardTable: "", storyboard: [], workbench: { videoList: [] },
        };
        let nextData: any;
        let sceneResult: ReturnType<typeof mergeStoryboardScene> | undefined;

        if (scene) {
          // 单场与其进度写入同一事务；在没有对应 XML 闭合回执前，调用方不能提交单场。
          sceneResult = mergeStoryboardScene(
            storedData.storyboardTable ?? "",
            storedData.storyboardTableProgress as StoryboardTableProgress | undefined,
            scene.taskId, scene.index, scene.total, scene.content,
          );
          nextData = { ...storedData, storyboardTable: sceneResult.storyboardTable, storyboardTableProgress: sceneResult.storyboardTableProgress };
        } else {
          const explicitWrites = new Set<string>(writeFields);
          const explicitStoryboardTable = explicitWrites.has("storyboardTable") || data.resetStoryboardTable === true;
          nextData = { ...storedData, ...data };

          // script 始终以 o_script 为准，浏览器快照不能覆盖后端剧本正文。
          nextData.script = script.content ?? "";

          // 导演计划由后端 Agent 提交；普通自动保存不得用过期浏览器快照覆盖。
          if (!explicitWrites.has("scriptPlan")) {
            nextData.scriptPlan = storedData.scriptPlan ?? "";
          }

          const previous = storedData.storyboardTableProgress as StoryboardTableProgress | undefined;
          const incoming = nextData.storyboardTableProgress as StoryboardTableProgress | undefined;
          if (!explicitStoryboardTable) {
            nextData.storyboardTable = storedData.storyboardTable ?? "";
            if (previous) nextData.storyboardTableProgress = previous;
            else delete nextData.storyboardTableProgress;
          } else if (previous) {
            if (nextData.resetStoryboardTable === true && incoming?.revision !== previous.revision) {
              // 旧版整表的延迟保存可能晚于新场次提交；绝不允许旧快照自动清空较新的进度。
              throw new Error("已有逐场分镜进度，整表覆盖前请先显式清空或完成当前任务");
            }
            if (incoming?.revision !== previous.revision || incoming?.taskId !== previous.taskId) {
              nextData.storyboardTable = storedData.storyboardTable;
              nextData.storyboardTableProgress = previous;
            } else if (nextData.storyboardTable !== storedData.storyboardTable) {
              // 当前版本的人工编辑可以保存，但随即停止自动合并，保护手动调整的内容。
              delete nextData.storyboardTableProgress;
            }
          } else if (incoming) {
            // 旧客户端快照不能恢复一个已经被清空或人工修改的旧任务进度。
            nextData.storyboardTable = storedData.storyboardTable;
            delete nextData.storyboardTableProgress;
          }
          delete nextData.resetStoryboardTable;
          // 保留旧有排序行为，但写入前校验每个 ID 的项目和剧本归属。
          if (Array.isArray(data.storyboard) && data.storyboard.length && data.storyboard.every((item: any) => item.id)) {
            for (const [index, item] of data.storyboard.entries()) {
              const updated = await trx("o_storyboard")
                .where({ id: item.id, projectId, scriptId: episodesId })
                .update({ index });
              if (updated !== 1) throw new Error(`分镜 ${item.id} 不属于当前项目和剧本，工作区未保存`);
            }
          }
        }
        const payload = JSON.stringify(nextData);
        if (existing) {
          const updated = await trx("o_agentWorkData").where(scope).update({ data: payload });
          if (updated !== 1) throw new Error("工作区记录更新失败");
        } else {
          await trx("o_agentWorkData").insert({ ...scope, data: payload });
        }
        const saved = await trx("o_agentWorkData").where(scope).select("data").first();
        if (!saved || saved.data !== payload) throw new Error("工作区数据写入校验失败");
        return sceneResult;
      });
      return res.status(200).send(success(result ?? null));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "工作区保存失败";
      console.error("[production/saveFlowData]", reason);
      return res.status(400).send({ code: 400, message, data: null });
    }
  },
);
