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
          // 兼容旧版逐场入口；Agent 生成 XML 只允许走后端权威提交。
          sceneResult = mergeStoryboardScene(
            storedData.storyboardTable ?? "",
            storedData.storyboardTableProgress as StoryboardTableProgress | undefined,
            scene.taskId, scene.index, scene.total, scene.content,
          );
          nextData = { ...storedData, storyboardTable: sceneResult.storyboardTable, storyboardTableProgress: sceneResult.storyboardTableProgress };
        } else {
          const explicitWrites = new Set<string>(writeFields);
          const explicitStoryboardTable = explicitWrites.has("storyboardTable") || data.resetStoryboardTable === true;
          // 工作区浏览器快照绝不具备修改后端修订历史/审批元数据的权限。
          // 不能先合并客户端再依赖其携带的旧 history，否则会覆盖刚刚完成的 Agent 修订。
          const clientData = { ...data };
          delete clientData.storyboardRevisionHistory;
          delete clientData.storyboardAuditHistory;
          delete clientData.storyboardApproval;
          delete clientData.storyboardSceneAudits;
          nextData = { ...storedData, ...clientData };
          nextData.script = script.content ?? "";
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
              throw new Error("已有逐场分镜进度，整表覆盖前请先显式清空或完成当前任务");
            }
            if (incoming?.revision !== previous.revision || incoming?.taskId !== previous.taskId) {
              nextData.storyboardTable = storedData.storyboardTable;
              nextData.storyboardTableProgress = previous;
            } else if (nextData.storyboardTable !== storedData.storyboardTable) {
              // 人工整表编辑不经逐场修订事务，必须取消旧进度，避免假装逐场快照仍有效。
              delete nextData.storyboardTableProgress;
            }
          } else if (incoming) {
            nextData.storyboardTable = storedData.storyboardTable;
            delete nextData.storyboardTableProgress;
          }
          delete nextData.resetStoryboardTable;
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
          // 使用原始数据库快照作 CAS；与 Agent 修订事务竞争时拒绝旧快照覆盖。
          const updated = await trx("o_agentWorkData")
            .where({ id: existing.id, data: existing.data }).update({ data: payload });
          if (updated !== 1) throw new Error("保存期间工作区版本已变化，请重新加载后重试");
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
