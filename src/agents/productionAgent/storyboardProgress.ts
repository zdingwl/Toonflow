import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { renderStoryboardScenes, type StoryboardTableProgress } from "@/utils/storyboardScenes";

export type StoryboardProgressResult = {
  exists: boolean;
  mode: "empty" | "scene" | "legacy" | "conflict";
  taskId: string | null;
  total: number | null;
  revision: number;
  savedScenes: number[];
  missingScenes: number[];
  nextScene: number | null;
  complete: boolean;
  valid: boolean;
  sourceHash?: string;
  planHash?: string;
  conflict?: { code: string; message: string };
};

export const hashStoryboardSource = (text: string) => createHash("sha256").update(text).digest("hex");

/** XML 属性不保存在 Markdown 中。taskId / total 必须读取独立进度记录。 */
export function inspectStoryboardProgress(
  table: string,
  raw: unknown,
  currentSourceHash?: string,
  currentPlanHash?: string,
): StoryboardProgressResult {
  const empty: StoryboardProgressResult = {
    exists: false, mode: "empty", taskId: null, total: null, revision: 0,
    savedScenes: [], missingScenes: [], nextScene: null, complete: false, valid: true,
  };
  const conflict = (code: string, message: string, value?: Partial<StoryboardTableProgress>): StoryboardProgressResult => ({
    ...empty, exists: Boolean(table.trim() || raw), mode: "conflict", valid: false,
    taskId: typeof value?.taskId === "string" ? value.taskId : null,
    total: Number.isSafeInteger(value?.total) ? value!.total! : null,
    revision: Number.isSafeInteger(value?.revision) ? value!.revision! : 0,
    conflict: { code, message },
  });
  if (!raw) {
    if (!table.trim()) return empty;
    return { ...conflict("LEGACY_NO_PROGRESS", "已有旧版分镜正文，但无逐场任务进度；需要核对，不能自动覆盖"), mode: "legacy" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return conflict("PROGRESS_INVALID", "分镜进度数据类型无效");
  const progress = raw as StoryboardTableProgress;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(progress.taskId ?? "") ||
      !Number.isSafeInteger(progress.total) || progress.total < 1 || progress.total > 1000 ||
      !Number.isSafeInteger(progress.revision) || progress.revision < 0 ||
      !progress.scenes || typeof progress.scenes !== "object" || Array.isArray(progress.scenes)) {
    return conflict("PROGRESS_INVALID", "分镜任务标识、总场次或进度结构无效", progress);
  }
  const keys = Object.keys(progress.scenes);
  for (const key of keys) {
    const value = progress.scenes[key];
    if (!/^[1-9]\d*$/.test(key) || Number(key) > progress.total || typeof value !== "string" || !value.trim() ||
        !(value.startsWith(`## 场${Number(key)}：`) || value.startsWith(`## 场${Number(key)}:`))) {
      return conflict("PROGRESS_INVALID", "分镜进度中的场次编号或内容无效", progress);
    }
  }
  if (table !== renderStoryboardScenes(progress.scenes)) {
    return conflict("TABLE_PROGRESS_MISMATCH", "分镜正文与进度记录不一致，可能被人工修改；已停止自动续写", progress);
  }
  if (progress.sourceHash && currentSourceHash && progress.sourceHash !== currentSourceHash) {
    return conflict("SOURCE_CHANGED", "分镜任务开始后剧本发生变化；请核对旧任务版本", progress);
  }
  if (progress.planHash && currentPlanHash && progress.planHash !== currentPlanHash) {
    return conflict("PLAN_CHANGED", "分镜任务开始后导演计划发生变化；请核对旧任务版本", progress);
  }
  const savedScenes = keys.map(Number).sort((a, b) => a - b);
  const missingScenes = Array.from({ length: progress.total }, (_, i) => i + 1).filter((n) => !progress.scenes[String(n)]);
  if (progress.complete !== (missingScenes.length === 0)) {
    return conflict("COMPLETE_FLAG_MISMATCH", "完成标记与已保存场次数不一致", progress);
  }
  return {
    exists: true, mode: "scene", taskId: progress.taskId, total: progress.total, revision: progress.revision,
    savedScenes, missingScenes, nextScene: missingScenes[0] ?? null, complete: missingScenes.length === 0,
    valid: true, sourceHash: progress.sourceHash, planHash: progress.planHash,
  };
}

export async function readStoryboardProgress(db: Knex, projectId: number, episodesId: number) {
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(episodesId)) throw new Error("项目或剧集 ID 无效");
  const script = await db("o_script").where({ id: episodesId, projectId }).select("content").first();
  if (!script) throw new Error("当前项目不存在该集剧本");
  const record = await db("o_agentWorkData")
    .where({ projectId, episodesId, key: "productionAgent" }).select("data").first();
  const data = record?.data ? JSON.parse(record.data) : {};
  return inspectStoryboardProgress(
    typeof data.storyboardTable === "string" ? data.storyboardTable : "",
    data.storyboardTableProgress,
    hashStoryboardSource(script.content ?? ""),
    hashStoryboardSource(typeof data.scriptPlan === "string" ? data.scriptPlan : ""),
  );
}
