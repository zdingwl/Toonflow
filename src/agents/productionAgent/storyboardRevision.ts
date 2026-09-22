import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { renderStoryboardScenes, type StoryboardTableProgress } from "@/utils/storyboardScenes";
import { inspectStoryboardProgress, hashStoryboardSource } from "./storyboardProgress";
import { extractSourceScene, validateStoryboardScene } from "./storyboardValidator";

export type StoryboardRevisionRequest = {
  projectId: number;
  episodesId: number;
  taskId: string;
  scene: number;
  expectedRevision: number;
  expectedSceneHash: string;
  revisedScene: string;
  reason: string;
};

export const storyboardSceneHash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Revising an existing scene is deliberately separate from generating a missing one.
 * No change is made unless the caller has read the exact persisted scene and revision.
 * The original draft is retained in storyboardRevisionHistory for review/rollback.
 */
export async function reviseStoryboardScene(db: Knex, request: StoryboardRevisionRequest) {
  const { projectId, episodesId, taskId, scene, expectedRevision, expectedSceneHash, revisedScene, reason } = request;
  if (![projectId, episodesId, scene, expectedRevision].every(Number.isSafeInteger) ||
      projectId < 1 || episodesId < 1 || scene < 1 || expectedRevision < 0 ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(expectedSceneHash) ||
      !reason.trim() || reason.length > 2000) {
    throw new Error("分镜修订缺少有效的场次、任务、原版本、原正文哈希或修订原因");
  }
  const revised = revisedScene.trim();
  if (!revised || revised.length > 60000 || /<\/?storyboardTable\b/i.test(revised)) {
    throw new Error("修订正文为空、过长或包含 XML 标签");
  }
  return db.transaction(async (trx) => {
    const script = await trx("o_script").where({ id: episodesId, projectId }).select("content").first();
    if (!script) throw new Error("当前项目不存在该集剧本");
    const scope = { projectId, episodesId, key: "productionAgent" };
    const row = await trx("o_agentWorkData").where(scope).select("id", "data").first();
    if (!row?.data) throw new Error("当前剧集尚无可修订的分镜表");
    const data = JSON.parse(row.data);
    const progress = data.storyboardTableProgress as StoryboardTableProgress | undefined;
    const checked = inspectStoryboardProgress(
      typeof data.storyboardTable === "string" ? data.storyboardTable : "",
      progress,
      hashStoryboardSource(script.content ?? ""),
      hashStoryboardSource(typeof data.scriptPlan === "string" ? data.scriptPlan : ""),
    );
    if (!checked.valid || !progress || checked.mode !== "scene") {
      throw new Error(checked.conflict?.message ?? "当前分镜不是可安全修订的逐场任务");
    }
    if (progress.taskId !== taskId || progress.revision !== expectedRevision || scene > progress.total) {
      throw new Error("分镜任务或修订版本已经变化，请重新读取当前工作区");
    }
    const original = progress.scenes[String(scene)];
    if (!original || storyboardSceneHash(original) !== expectedSceneHash) {
      throw new Error("原场次已变化或不存在，禁止覆盖；请重新读取分镜");
    }
    const validation = validateStoryboardScene(scene, revised, extractSourceScene(script.content ?? "", scene));
    if (!validation.valid) throw new Error(`第${scene}场修订未通过校验：${validation.errors.join("；")}`);
    if (revised === original) {
      return { changed: false, revision: progress.revision, scene, taskId,
        storyboardTable: data.storyboardTable as string, storyboardTableProgress: progress,
        coverageVerified: validation.coverageVerified, warnings: validation.warnings };
    }
    const scenes = { ...progress.scenes, [String(scene)]: revised };
    const nextProgress: StoryboardTableProgress = {
      ...progress, scenes, revision: progress.revision + 1, updatedAt: Date.now(),
      // A previously approved scene is no longer approved after its contents change.
      lastValidatedScene: undefined,
    };
    const history = Array.isArray(data.storyboardRevisionHistory) ? data.storyboardRevisionHistory : [];
    const nextData = {
      ...data,
      storyboardTable: renderStoryboardScenes(scenes),
      storyboardTableProgress: nextProgress,
      storyboardRevisionHistory: [...history, {
        taskId, scene, fromRevision: progress.revision, toRevision: nextProgress.revision,
        original, originalHash: expectedSceneHash, revisedHash: storyboardSceneHash(revised),
        reason, createTime: Date.now(),
      }],
    };
    // Compare-and-swap the exact workspace snapshot; never replace a concurrent user edit.
    const affected = await trx("o_agentWorkData")
      .where({ id: row.id, data: row.data }).update({ data: JSON.stringify(nextData) });
    if (affected !== 1) throw new Error("修订期间工作区已被其他请求修改，事务未提交");
    const saved = await trx("o_agentWorkData").where({ id: row.id }).select("data").first();
    if (!saved || saved.data !== JSON.stringify(nextData)) throw new Error("修订写入后读回校验失败");
    return { changed: true, revision: nextProgress.revision, scene, taskId,
      storyboardTable: nextData.storyboardTable, storyboardTableProgress: nextProgress,
      coverageVerified: validation.coverageVerified, warnings: validation.warnings };
  });
}
