import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { hashStoryboardSource, inspectStoryboardProgress, readStoryboardProgress } from "./storyboardProgress";
import type { StoryboardTableProgress } from "@/utils/storyboardScenes";

export type StoryboardRebuildRequest = {
  projectId: number;
  episodesId: number;
  expectedTaskId: string;
  expectedRevision: number;
  expectedPlanHash: string;
  total: number;
  reason: string;
};

/**
 * Supersede a coherent old scene task only when the user expressly requests a rebuild.
 * PLAN_CHANGED is not an empty task. Archive the exact old text and progress before
 * establishing the new task on the latest plan. All changes share one transaction.
 */
export async function rebuildStoryboardTask(db: Knex, request: StoryboardRebuildRequest) {
  const { projectId, episodesId, expectedTaskId, expectedRevision, expectedPlanHash, total, reason } = request;
  if (![projectId, episodesId, total].every((n) => Number.isSafeInteger(n) && n > 0) || total > 1000 ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(expectedTaskId) || !/^[a-f0-9]{64}$/.test(expectedPlanHash) ||
      typeof reason !== "string" || !reason.trim() || reason.length > 2000) {
    throw new Error("重建参数无效：必须明确旧任务标识、旧版本、最新导演计划哈希和总场数");
  }
  return db.transaction(async (trx) => {
    const script = await trx("o_script").where({ id: episodesId, projectId }).select("content").first();
    if (!script) throw new Error("当前项目不存在该集剧本");
    const scope = { projectId, episodesId, key: "productionAgent" };
    const row = await trx("o_agentWorkData").where(scope).select("id", "data").first();
    if (!row?.data) throw new Error("工作区没有可重建的逐场任务");
    const data = JSON.parse(row.data);
    const table = typeof data.storyboardTable === "string" ? data.storyboardTable : "";
    const previous = data.storyboardTableProgress as StoryboardTableProgress | undefined;
    // The old source/plan may have changed; validate its saved table and progress
    // without comparing them to the current plan, but never ignore content mismatch.
    const coherent = inspectStoryboardProgress(table, previous);
    if (!coherent.valid || coherent.mode !== "scene" || !previous) {
      throw new Error(`旧任务正文与进度不一致，不能自动重建：${coherent.conflict?.message ?? "旧任务进度不可核验"}`);
    }
    if (previous.taskId !== expectedTaskId || previous.revision !== expectedRevision) {
      throw new Error("旧任务或版本已变化，请重新读取进度后再重建");
    }
    const currentPlan = typeof data.scriptPlan === "string" ? data.scriptPlan : "";
    const planHash = hashStoryboardSource(currentPlan);
    if (!currentPlan.trim() || planHash !== expectedPlanHash) {
      throw new Error("最新导演计划为空或已再次修改，请重新读取导演计划");
    }
    const declared = currentPlan.match(/共规划\s*(\d+)\s*个?场/);
    if (declared && Number(declared[1]) !== total) throw new Error("重建场数与最新导演计划不一致");
    const sourceHash = hashStoryboardSource(String(script.content ?? ""));
    const savedScenes = coherent.savedScenes;
    const archiveId = `storyboard_archive_${randomUUID().replace(/-/g, "")}`;
    const newTaskId = `storyboard_${randomUUID().replace(/-/g, "")}`;
    const archivedAt = Date.now();
    const archive = {
      archiveId, status: "superseded", reason: reason.trim(), archivedAt,
      previousTaskId: previous.taskId, previousRevision: previous.revision,
      previousSavedScenes: savedScenes, previousTable: table,
      previousProgress: previous, previousTableHash: hashStoryboardSource(table),
      replacementTaskId: newTaskId, replacementPlanHash: planHash,
    };
    const nextProgress: StoryboardTableProgress = {
      taskId: newTaskId, total, revision: 0, scenes: {}, complete: false,
      sourceHash, planHash, updatedAt: archivedAt,
    };
    const nextData = {
      ...data,
      storyboardTable: "",
      storyboardTableProgress: nextProgress,
      storyboardTaskArchives: [...(Array.isArray(data.storyboardTaskArchives) ? data.storyboardTaskArchives : []), archive],
    };
    // Keep an independent archive record: future browser snapshots or manual
    // workspace edits cannot delete the only copy of the old draft.
    const archiveKey = `storyboardTaskArchive:${archiveId}`;
    await trx("o_agentWorkData").insert({
      projectId, episodesId, key: archiveKey, data: JSON.stringify(archive),
    });
    // CAS: concurrent Agent commits or manual edits invalidate the rebuild.
    const payload = JSON.stringify(nextData);
    const affected = await trx("o_agentWorkData").where({ id: row.id, data: row.data }).update({ data: payload });
    if (affected !== 1) throw new Error("重建时工作区发生变化，旧任务未作废");
    const saved = await trx("o_agentWorkData").where({ id: row.id }).select("data").first();
    const savedArchive = await trx("o_agentWorkData")
      .where({ projectId, episodesId, key: archiveKey }).select("data").first();
    if (!saved || saved.data !== payload || savedArchive?.data !== JSON.stringify(archive)) {
      throw new Error("旧稿归档或新分镜任务写入后读回校验失败");
    }
    return {
      archiveId, archivedTaskId: previous.taskId, archivedRevision: previous.revision,
      archivedSavedScenes: savedScenes, archivedSceneCount: savedScenes.length,
      taskId: newTaskId, total, revision: 0, savedScenes: [] as number[],
      missingScenes: Array.from({ length: total }, (_, i) => i + 1), nextScene: 1,
      storyboardTable: "", storyboardTableProgress: nextProgress,
      note: "旧任务及全部已保存场次已独立归档；新任务使用最新导演计划，从第1场开始。",
    };
  });
}

/** Resolve the real scene count even when a mismatched plan marks a task invalid. */
export async function getStoryboardRebuildContext(db: Knex, projectId: number, episodesId: number) {
  const progress = await readStoryboardProgress(db, projectId, episodesId);
  const row = await db("o_agentWorkData")
    .where({ projectId, episodesId, key: "productionAgent" }).select("data").first();
  const data = row?.data ? JSON.parse(row.data) : {};
  const table = typeof data.storyboardTable === "string" ? data.storyboardTable : "";
  const coherent = inspectStoryboardProgress(table, data.storyboardTableProgress);
  return {
    ...progress,
    actualSavedScenes: coherent.valid ? coherent.savedScenes : null,
    actualSceneCount: coherent.valid ? coherent.savedScenes.length : null,
    tableExists: Boolean(table.trim()),
    currentPlanHash: hashStoryboardSource(typeof data.scriptPlan === "string" ? data.scriptPlan : ""),
    archiveCount: Array.isArray(data.storyboardTaskArchives) ? data.storyboardTaskArchives.length : 0,
  };
}
