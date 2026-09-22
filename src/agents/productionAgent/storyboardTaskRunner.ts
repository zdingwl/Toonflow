import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { readStoryboardProgress, type StoryboardProgressResult } from "./storyboardProgress";

export type StoryboardRunnerOptions = {
  db: Knex;
  projectId: number;
  episodesId: number;
  total?: number;
  maxScenes?: number;
  abortSignal?: AbortSignal;
  maxAttemptsPerScene?: number;
  generate: (input: { scene: number; taskId: string; total: number; attempt: number }) => Promise<unknown>;
};

/** 每次只依据后端已提交的数据库进度决定下一场；不允许模型自行选择 task / scene / total。 */
export async function runStoryboardTask(options: StoryboardRunnerOptions): Promise<StoryboardProgressResult> {
  const { db, projectId, episodesId, abortSignal, generate } = options;
  const initial = await readStoryboardProgress(db, projectId, episodesId);
  if (!initial.valid) throw new Error(initial.conflict?.message ?? "分镜任务进度无效");
  if (initial.mode !== "scene" && initial.mode !== "empty") {
    throw new Error("已有非逐场分镜，请先核对历史数据；不得自动覆盖");
  }
  const total = initial.total ?? options.total;
  if (!Number.isSafeInteger(total) || !total || total < 1 || total > 1000) throw new Error("无法确定分镜总场数，请先核对导演计划");
  if (options.total !== undefined && options.total !== total) throw new Error("本次总场数与已保存任务不一致");
  const taskId = initial.taskId ?? `storyboard_${randomUUID().replace(/-/g, "")}`;
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttemptsPerScene ?? 2));
  const maxScenes = Math.max(1, Math.min(total, options.maxScenes ?? total));

  for (let iteration = 0; iteration < maxScenes; iteration++) {
    if (abortSignal?.aborted) throw new Error("分镜生成已停止，已保存场次保留");
    const progress = await readStoryboardProgress(db, projectId, episodesId);
    if (!progress.valid) throw new Error(progress.conflict?.message ?? "分镜任务发生冲突");
    if (progress.exists && (progress.taskId !== taskId || progress.total !== total)) {
      throw new Error("任务标识或总场数被修改，停止自动续写");
    }
    if (progress.complete) return progress;
    const scene = progress.exists ? progress.nextScene : 1;
    if (!scene) throw new Error("分镜尚未完成却找不到缺失场次");
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (abortSignal?.aborted) throw new Error("分镜生成已停止，已保存场次保留");
      try {
        await generate({ scene, taskId, total, attempt });
        const checked = await readStoryboardProgress(db, projectId, episodesId);
        if (!checked.valid) throw new Error(checked.conflict?.message ?? "保存后的进度校验失败");
        if (checked.taskId !== taskId || checked.total !== total) throw new Error("当前任务已被替换");
        if (checked.savedScenes.includes(scene)) { lastError = undefined; break; }
        lastError = new Error(`第${scene}场没有数据库提交回执`);
      } catch (error) {
        lastError = error;
        const checked = await readStoryboardProgress(db, projectId, episodesId);
        if (!checked.valid) throw new Error(checked.conflict?.message ?? "数据库冲突，停止重试");
        if (checked.exists && (checked.taskId !== taskId || checked.total !== total)) throw new Error("当前任务已切换，停止重试");
        if (checked.savedScenes.includes(scene)) { lastError = undefined; break; }
        // 只重试尚未提交的场次；已写入且内容不同的场次绝不覆盖。
      }
      if (lastError && attempt === maxAttempts) {
        throw new Error(`第${scene}场未能确认写入：${lastError instanceof Error ? lastError.message : String(lastError)}`);
      }
    }
  }
  const final = await readStoryboardProgress(db, projectId, episodesId);
  if (!final.valid || final.taskId !== taskId || final.total !== total) throw new Error("结束前的分镜任务进度校验失败");
  if (maxScenes >= total && !final.complete) throw new Error("全剧分镜尚未完整保存，不能报告完成");
  return final;
}
