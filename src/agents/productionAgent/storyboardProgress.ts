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

/** XML attributes never belong in the rendered Markdown. Use persisted progress. */
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
  const conflict = (code: string, message: string, value?: Partial<StoryboardTableProgress>, savedScenes: number[] = []): StoryboardProgressResult => {
    const total = Number.isSafeInteger(value?.total) && Number(value?.total) > 0 && Number(value?.total) <= 1000 ? Number(value?.total) : null;
    const missingScenes = total === null ? [] : Array.from({ length: total }, (_, i) => i + 1).filter((n) => !savedScenes.includes(n));
    return {
      ...empty, exists: Boolean(table.trim() || raw), mode: "conflict", valid: false,
      taskId: typeof value?.taskId === "string" ? value.taskId : null,
      total, revision: Number.isSafeInteger(value?.revision) ? Number(value?.revision) : 0,
      savedScenes, missingScenes, nextScene: missingScenes[0] ?? null,
      sourceHash: value?.sourceHash, planHash: value?.planHash,
      conflict: { code, message },
    };
  };
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
  const savedScenes = keys.map(Number).sort((a, b) => a - b);
  if (table !== renderStoryboardScenes(progress.scenes)) {
    // Even on mismatch do not report zero saved scenes when progress contains drafts.
    return conflict("TABLE_PROGRESS_MISMATCH", "分镜正文与进度记录不一致，可能被人工修改；已停止自动续写", progress, savedScenes);
  }
  const missingScenes = Array.from({ length: progress.total }, (_, i) => i + 1).filter((n) => !progress.scenes[String(n)]);
  if (progress.complete !== (missingScenes.length === 0)) {
    return conflict("COMPLETE_FLAG_MISMATCH", "完成标记与已保存场次数不一致", progress, savedScenes);
  }
  if (progress.sourceHash && currentSourceHash && progress.sourceHash !== currentSourceHash) {
    return conflict("SOURCE_CHANGED", `剧本版本已变化；旧任务实际上保存${savedScenes.length}场，请先归档旧稿，再按新剧本重建`, progress, savedScenes);
  }
  if (progress.planHash && currentPlanHash && progress.planHash !== currentPlanHash) {
    return conflict("PLAN_CHANGED", `导演计划版本已变化；旧任务实际上保存${savedScenes.length}场，不得视为零场或直接覆盖`, progress, savedScenes);
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
