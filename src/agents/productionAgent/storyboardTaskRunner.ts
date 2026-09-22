import type { Knex } from "knex";
import { readStoryboardProgress, type StoryboardProgressResult } from "./storyboardProgress";

export type StoryboardRunnerOptions = {
  db: Knex;
  projectId: number;
  episodesId: number;
  abortSignal?: AbortSignal;
  maxAttemptsPerScene?: number;
  generate: (input: { scene: number; taskId: string; total: number; attempt: number }) => Promise<unknown>;
};

/** 只把数据库提交视为完成，不把模型输出或聊天回复视为写入回执。 */
export async function runStoryboardTask(options: StoryboardRunnerOptions): Promise<StoryboardProgressResult> {
  const { db, projectId, episodesId, abortSignal, generate } = options;
  const initial = await readStoryboardProgress(db, projectId, episodesId);
  if (!initial.valid) throw new Error(initial.conflict?.message ?? "分镜任务进度无效");
  if (!initial.exists || initial.mode !== "scene" || !initial.taskId || !initial.total) {
    throw new Error("尚无可恢复的逐场分镜进度；需要先提交第1场并确认任务标识和总场次");
  }
  const taskId = initial.taskId;
  const total = initial.total;
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttemptsPerScene ?? 2));
  for (let iteration = 0; iteration < total; iteration++) {
    if (abortSignal?.aborted) throw new Error("分镜生成已停止，已保存场次保留");
    const progress = await readStoryboardProgress(db, projectId, episodesId);
    if (!progress.valid) throw new Error(progress.conflict?.message ?? "分镜任务发生冲突");
    if (progress.taskId !== taskId || progress.total !== total) throw new Error("任务标识或总场数被修改，停止自动续写");
    if (progress.complete) return progress;
    const scene = progress.nextScene;
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
        if (checked.taskId !== taskId || checked.total !== total) throw new Error("当前任务已切换，停止重试");
        if (checked.savedScenes.includes(scene)) {
          // 某个并发写入已将当前场保存：不尝试覆盖它，只依据真实进度继续。
          lastError = undefined;
          break;
        }
      }
      if (lastError && attempt === maxAttempts) throw new Error(`第${scene}场未能确认写入：${String(lastError)}`);
    }
  }
  const final = await readStoryboardProgress(db, projectId, episodesId);
  if (!final.valid || !final.complete || final.taskId !== taskId) throw new Error("全剧分镜尚未完整保存，不能报告完成");
  return final;
}
