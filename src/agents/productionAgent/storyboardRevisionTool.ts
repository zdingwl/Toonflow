import { tool, jsonSchema } from "ai";
import { z } from "zod";
import type { Knex } from "knex";
import { readStoryboardProgress } from "./storyboardProgress";
import { readStoryboardTableSnapshot, extractStoryboardTable } from "./storyboardTable";
import { reviseStoryboardScene, storyboardSceneHash } from "./storyboardRevision";
import { extractSourceScene } from "./storyboardValidator";

export type StoryboardRevisionGenerateInput = {
  instruction: string;
  scene: number;
  total: number;
  taskId: string;
  original: string;
  sourceScene?: string;
};

/** Revision is NOT a missing-scene generation. It must replace an existing, version-pinned scene. */
export function createStoryboardRevisionTool(options: {
  db: Knex;
  projectId: number;
  episodesId: number;
  abortSignal?: AbortSignal;
  generate: (input: StoryboardRevisionGenerateInput) => Promise<string>;
  notify: (payload: { episodesId: number; storyboardTable: string; storyboardTableProgress: unknown }) => void;
}) {
  return tool({
    description: "执行导演修订已保存的指定分镜场次（非重新审核、非补缺场）；锁定数据库版本，生成新稿，事务提交并读回。每次只修订一场；确认已实际变更后才能复审。",
    inputSchema: jsonSchema<{ scene: number; instruction: string }>(
      z.object({
        scene: z.number().int().min(1).max(1000).describe("要修订的已保存场次编号；根据监制报告选择具体场次"),
        instruction: z.string().min(1).max(2000).describe("本场要解决的已确认审核问题与用户最新约束；不能仅写再次审核"),
      }).toJSONSchema(),
    ),
    execute: async ({ scene, instruction }) => {
      const { db, projectId, episodesId, abortSignal } = options;
      if (abortSignal?.aborted) throw new Error("用户已停止分镜修订");
      const before = await readStoryboardProgress(db, projectId, episodesId);
      if (!before.valid || before.mode !== "scene" || !before.taskId || !before.total) {
        throw new Error(before.conflict?.message ?? "当前分镜不是可安全修订的逐场任务，请先核对进度");
      }
      if (!before.savedScenes.includes(scene)) throw new Error(`第${scene}场未保存；请先补缺场而不是调用修订工具`);
      const snapshot = await readStoryboardTableSnapshot(db, projectId, episodesId);
      if (snapshot.storyboardTableProgress?.taskId !== before.taskId ||
          snapshot.storyboardTableProgress?.revision !== before.revision) {
        throw new Error("修订开始前工作区发生变化，请重新读取进度");
      }
      const original = snapshot.storyboardTableProgress.scenes[String(scene)];
      if (typeof original !== "string" || !original.trim()) throw new Error(`第${scene}场缺少原稿`);
      const script = await db("o_script").where({ id: episodesId, projectId }).select("content").first();
      if (!script) throw new Error("当前项目不存在该集剧本");
      const sourceScene = extractSourceScene(String(script.content ?? ""), scene);
      const text = await options.generate({
        instruction, scene, total: before.total, taskId: before.taskId, original, sourceScene,
      });
      if (abortSignal?.aborted) throw new Error("用户已停止分镜修订，未提交生成结果");
      const parsed = extractStoryboardTable(text);
      if (parsed.mode !== "scene" || parsed.scene !== scene || parsed.total !== before.total || parsed.taskId !== before.taskId) {
        throw new Error(`修订输出不符合固定场次/task/total 协议；第${scene}场旧稿保持不变`);
      }
      const committed = await reviseStoryboardScene(db, {
        projectId, episodesId, scene, taskId: before.taskId,
        expectedRevision: before.revision,
        expectedSceneHash: storyboardSceneHash(original),
        revisedScene: parsed.content,
        reason: instruction,
      });
      if (!committed.changed) throw new Error(`第${scene}场输出与数据库旧稿完全相同；没有完成实际修订`);
      const after = await readStoryboardProgress(db, projectId, episodesId);
      const readback = await readStoryboardTableSnapshot(db, projectId, episodesId);
      if (!after.valid || after.taskId !== before.taskId || after.revision !== committed.revision ||
          storyboardSceneHash(readback.storyboardTableProgress?.scenes[String(scene)] ?? "") !== storyboardSceneHash(parsed.content)) {
        throw new Error(`第${scene}场修订已提交，但读回状态异常；先核对数据库，禁止重复覆盖`);
      }
      options.notify({
        episodesId, storyboardTable: committed.storyboardTable,
        storyboardTableProgress: committed.storyboardTableProgress,
      });
      return {
        changed: true, scene, revision: committed.revision, taskId: before.taskId,
        oldHash: storyboardSceneHash(original), newHash: storyboardSceneHash(parsed.content),
        savedScenes: after.savedScenes, missingScenes: after.missingScenes,
        coverageVerified: committed.coverageVerified, warnings: committed.warnings,
        message: `第${scene}场已修订并从数据库读回；尚须针对本次审核问题复核，不能直接宣称整集通过。`,
      };
    },
  });
}
