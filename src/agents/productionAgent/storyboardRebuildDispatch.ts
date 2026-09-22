import type { Knex } from "knex";
import { hashStoryboardSource, readStoryboardProgress } from "./storyboardProgress";
import { getStoryboardRebuildContext, rebuildStoryboardTask } from "./storyboardRebuild";

/** Only an explicit user command may supersede existing storyboard scenes. */
export function isExplicitStoryboardRebuildRequest(input: string): boolean {
  const text = input.trim().replace(/[\s，。！!？?、]/g, "");
  if (/^(重新构建|重新生成分镜(?:表)?|重新构建分镜(?:表)?|重建分镜(?:表)?|重新制作分镜(?:表)?)$/.test(text)) return true;
  return /^(?:请)?(?:以|按)(?:当前|最新)导演(?:计划|规划)(?:为准)?(?:重新构建|重新生成|重建)(?:全部|整集|所有|[一二三四五六七八九十百\d]+场|全部[一二三四五六七八九十百\d]+场)?分镜(?:表)?$/.test(text);
}

/** Never infer total or saved-scene count from a model's prose or an invalid progress fallback. */
export function storyboardPlanSceneCount(plan: string): number {
  const declared = plan.match(/共规划\s*(\d+)\s*个?场/);
  const headings = [...plan.matchAll(/^\s*(?:\d+[.、]\s*)?场\s*(\d+)\s*[：:]/gm)].map((match) => Number(match[1]));
  const ordered = headings.length > 0 && headings.every((n, index) => n === index + 1);
  if (headings.length && !ordered) throw new Error("最新导演计划场次编号不连续，不能自动重建");
  const count = declared ? Number(declared[1]) : ordered ? headings.length : 0;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000 || (headings.length && headings.length !== count)) {
    throw new Error("无法核对最新导演计划的完整场次数，未修改旧任务");
  }
  return count;
}

export type PreparedStoryboardRebuild = {
  taskId: string;
  total: number;
  archivedSceneCount: number;
  archivedSavedScenes: number[];
  archiveId: string | null;
  newlyInitialized: boolean;
};

/**
 * This is called by the socket dispatcher BEFORE invoking the decision model.
 * Rebuild itself is a CAS-guarded transaction and permanently archives the old draft.
 * A repeated confirmation after successful initialization resumes that same new task.
 */
export async function prepareAuthorizedStoryboardRebuild(
  db: Knex,
  projectId: number,
  episodesId: number,
  instruction: string,
  abortSignal?: AbortSignal,
): Promise<PreparedStoryboardRebuild> {
  if (!isExplicitStoryboardRebuildRequest(instruction)) throw new Error("没有收到明确的整集分镜重建指令，旧稿保持不变");
  if (abortSignal?.aborted) throw new Error("分镜重建已取消，未修改旧任务");
  const scope = { projectId, episodesId, key: "productionAgent" };
  const workspace = await db("o_agentWorkData").where(scope).select("data").first();
  if (!workspace?.data) throw new Error("当前项目尚无分镜任务，不能清空或重建；请走首次构建流程");
  const data = JSON.parse(workspace.data);
  const plan = typeof data.scriptPlan === "string" ? data.scriptPlan : "";
  const total = storyboardPlanSceneCount(plan);
  const currentPlanHash = hashStoryboardSource(plan);
  const context = await getStoryboardRebuildContext(db, projectId, episodesId);
  if (!context.taskId || context.actualSavedScenes === null) {
    throw new Error("旧任务正文和进度未通过一致性核验，未修改旧稿；需要先核对数据库");
  }
  // An interrupted or repeated confirmation must not erase the new task's progress.
  const archives = Array.isArray(data.storyboardTaskArchives) ? data.storyboardTaskArchives : [];
  const lastArchive = archives.length ? archives[archives.length - 1] : null;
  const current = await readStoryboardProgress(db, projectId, episodesId);
  if (current.valid && current.mode === "scene" && current.total === total &&
      current.planHash === currentPlanHash && lastArchive?.replacementTaskId === current.taskId) {
    return {
      taskId: current.taskId!, total, archivedSceneCount: Number(lastArchive.previousSavedScenes?.length ?? 0),
      archivedSavedScenes: Array.isArray(lastArchive.previousSavedScenes) ? lastArchive.previousSavedScenes : [],
      archiveId: typeof lastArchive.archiveId === "string" ? lastArchive.archiveId : null,
      newlyInitialized: false,
    };
  }
  if (abortSignal?.aborted) throw new Error("分镜重建已取消，未修改旧任务");
  const rebuilt = await rebuildStoryboardTask(db, {
    projectId, episodesId,
    expectedTaskId: context.taskId, expectedRevision: context.revision,
    expectedPlanHash: currentPlanHash, total, reason: instruction,
  });
  const checked = await readStoryboardProgress(db, projectId, episodesId);
  if (!checked.valid || checked.taskId !== rebuilt.taskId || checked.total !== total ||
      checked.revision !== 0 || checked.savedScenes.length !== 0 || checked.nextScene !== 1) {
    throw new Error("新分镜任务已初始化，但数据库读回异常；停止生成，请先核对数据库");
  }
  return {
    taskId: rebuilt.taskId, total, archivedSceneCount: rebuilt.archivedSceneCount,
    archivedSavedScenes: rebuilt.archivedSavedScenes, archiveId: rebuilt.archiveId,
    newlyInitialized: true,
  };
}
