#!/usr/bin/env python3
"""Apply a guarded, targeted patch. Never rewrite unrelated socket or agent code."""
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    occurrences = text.count(old)
    if occurrences != 1:
        raise RuntimeError(f"Expected one anchor in {path}, saw {occurrences}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


index = "src/agents/productionAgent/index.ts"
replace_once(index,
'''      } else if (isStoryboardTable) {
        try {
          const parsed = extractStoryboardTable(fullResponse);''',
'''      } else if (isStoryboardTable) {
        try {
          // An interrupted old model response must never be committed after task replacement.
          if (abortSignal?.aborted) throw new Error("分镜任务已中断，旧模型输出未提交");
          const parsed = extractStoryboardTable(fullResponse);''')

replace_once(index,
'''async function createArtSkills(artName: string, storyName: string, readSkill: (filePath: string) => Promise<string>) {''',
'''/** Invoke the established backend-controlled scene runner directly, without asking the
 * decision model to choose whether to call the generation tool after a rebuild. */
export async function generateRebuiltStoryboard(ctx: AgentContext, total: number, expectedTaskId: string) {
  if (ctx.abortSignal?.aborted) throw new Error("分镜重建已停止，已提交场次保留");
  const projectId = Number(ctx.resTool.data.projectId);
  const episodesId = Number(ctx.resTool.data.scriptId);
  const current = await readStoryboardProgress(u.db, projectId, episodesId);
  if (!current.valid || current.taskId !== expectedTaskId || current.total !== total) {
    throw new Error("新分镜任务的数据库状态与重建回执不一致，停止生成以保护已有数据");
  }
  const subAgents = await createSubAgent(ctx);
  const execute = subAgents.run_sub_agent_storyboard_table.execute;
  if (typeof execute !== "function") throw new Error("分镜逐场生成工具尚未注册，未执行重建生成");
  const result = await (execute as (...args: any[]) => Promise<any>)(
    { prompt: "按最新导演计划生成全部分镜，遵守本集现有制作要求", total, scope: "full" },
    { toolCallId: `backend-rebuild-${ctx.runId ?? expectedTaskId}`, messages: [], abortSignal: ctx.abortSignal },
  );
  const verified = await readStoryboardProgress(u.db, projectId, episodesId);
  if (!verified.valid || verified.taskId !== expectedTaskId || verified.total !== total ||
      !verified.complete || verified.savedScenes.length !== total || result?.complete !== true) {
    throw new Error(`重建生成尚未完成，当前保存场次：${verified.savedScenes.join(",") || "无"}；不能报告整集完成`);
  }
  return verified;
}

async function createArtSkills(artName: string, storyName: string, readSkill: (filePath: string) => Promise<string>) {''')

socket = "src/socket/routes/productionAgent.ts"
replace_once(socket,
'''import { getOperationReceipt } from "@/utils/agent/runtime/operationReceipt";''',
'''import { getOperationReceipt } from "@/utils/agent/runtime/operationReceipt";
import { isExplicitStoryboardRebuildRequest, prepareAuthorizedStoryboardRebuild } from "@/agents/productionAgent/storyboardRebuildDispatch";
import { readStoryboardTableSnapshot } from "@/agents/productionAgent/storyboardTable";''')

replace_once(socket,
'''        await agent.runDecisionAI(ctx);
        await taskStore.finish(runId, controller.signal.aborted ? "reconciling" : "completed");''',
'''        if (isExplicitStoryboardRebuildRequest(content)) {
          // User authorization is handled deterministically here, not via the decision model.
          // The database service verifies the old task and atomically archives it before reset.
          const projectId = Number(resTool.data.projectId);
          const episodesId = Number(resTool.data.scriptId);
          const prepared = await prepareAuthorizedStoryboardRebuild(
            u.db, projectId, episodesId, content, controller.signal,
          );
          const snapshot = await readStoryboardTableSnapshot(u.db, projectId, episodesId);
          if (snapshot.storyboardTableProgress?.taskId !== prepared.taskId) {
            throw new Error("重建初始化回执与数据库任务不一致，停止逐场生成");
          }
          socket.emit("storyboardTable:committed", {
            episodesId, storyboardTable: snapshot.storyboardTable,
            storyboardTableProgress: snapshot.storyboardTableProgress,
            savedScenes: Object.keys(snapshot.storyboardTableProgress.scenes).map(Number).sort((a, b) => a - b),
            missingScenes: Array.from({ length: prepared.total }, (_, i) => i + 1)
              .filter((n) => !snapshot.storyboardTableProgress?.scenes[String(n)]),
          });
          const initMessage = resTool.newMessage("assistant", "视频策划");
          initMessage.text(`旧任务实际保存${prepared.archivedSceneCount}场，已归档（归档ID：${prepared.archiveId ?? "既有归档"}）。` +
            `新任务ID：${prepared.taskId}；${prepared.newlyInitialized ? "初始化完成" : "恢复已有新任务"}，现在由后端直接开始逐场生成。`).complete();
          initMessage.complete();
          const verified = await agent.generateRebuiltStoryboard(ctx, prepared.total, prepared.taskId);
          const done = resTool.newMessage("assistant", "视频策划");
          done.text(`新任务${verified.taskId}已从数据库核对保存${verified.savedScenes.length}/${verified.total}场。` +
            "结构化分镜已生成；内容覆盖、节奏和制作质量仍须监制复核。").complete();
          done.complete();
        } else {
          await agent.runDecisionAI(ctx);
        }
        await taskStore.finish(runId, controller.signal.aborted ? "reconciling" : "completed");''')

print("Applied guarded direct rebuild dispatch, abort guard and backend generation entrypoint")
