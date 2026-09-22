import type { Knex } from "knex";
import { hashStoryboardSource } from "./storyboardProgress";
import { mergeStoryboardScene, renderStoryboardScenes, type StoryboardTableProgress } from "@/utils/storyboardScenes";

export type StoryboardTableOutput =
  | { mode: "full"; content: string; scenes: number[] }
  | { mode: "scene"; content: string; scene: number; total: number; taskId: string };

export type StoryboardTableSnapshot = {
  storyboardTable: string;
  storyboardTableProgress?: StoryboardTableProgress;
};

export type StoryboardTableCommit = {
  resultRef: string;
  storyboardTable: string;
  storyboardTableProgress?: StoryboardTableProgress;
  savedScenes: number[];
  missingScenes: number[];
};

function readAttribute(raw: string, name: string): string | undefined {
  const match = raw.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match?.[1] ?? match?.[2];
}

function validateFullTable(content: string): number[] {
  const scenes = [...content.matchAll(/^##\s*场\s*(\d+)\s*[：:]/gm)].map((match) => Number(match[1]));
  if (!scenes.length) throw new Error("完整分镜表缺少“## 场N：”场头");
  if (new Set(scenes).size !== scenes.length) throw new Error("完整分镜表存在重复场次");
  if (scenes.some((scene, index) => scene !== index + 1)) {
    throw new Error("完整分镜表场次必须从 1 开始连续编号");
  }
  return scenes;
}

export function extractStoryboardTable(response: string): StoryboardTableOutput {
  const openings = [...response.matchAll(/<storyboardTable\b([^>]*)>/g)];
  const closings = [...response.matchAll(/<\/storyboardTable\s*>/g)];
  if (openings.length !== 1 || closings.length !== 1) {
    throw new Error("分镜表输出不完整：需要且只能有一份 storyboardTable");
  }
  const open = openings[0];
  const close = closings[0];
  if (open.index === undefined || close.index === undefined || close.index < open.index + open[0].length) {
    throw new Error("分镜表输出不完整：storyboardTable 标签顺序错误");
  }
  const content = response.slice(open.index + open[0].length, close.index).trim();
  if (!content) throw new Error("分镜表内容为空");
  if (/<\/?storyboardTable\b/i.test(content)) throw new Error("分镜表内容包含嵌套 storyboardTable 标签");

  const attrs = open[1] ?? "";
  const sceneRaw = readAttribute(attrs, "scene");
  const totalRaw = readAttribute(attrs, "total");
  const taskRaw = readAttribute(attrs, "task");
  const usesSceneMode = sceneRaw !== undefined || totalRaw !== undefined || taskRaw !== undefined;

  if (!usesSceneMode) {
    if (attrs.trim()) throw new Error("整表模式不允许 storyboardTable 附带未知属性");
    return { mode: "full", content, scenes: validateFullTable(content) };
  }

  if (sceneRaw === undefined || totalRaw === undefined || taskRaw === undefined) {
    throw new Error("逐场分镜必须同时提供 scene、total、task 属性");
  }
  const scene = Number(sceneRaw);
  const total = Number(totalRaw);
  const taskId = taskRaw.trim();
  if (!Number.isSafeInteger(scene) || !Number.isSafeInteger(total) || scene < 1 || total < scene || total > 1000) {
    throw new Error("逐场分镜的 scene 或 total 无效");
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(taskId)) throw new Error("逐场分镜 task 标识无效");

  const known = attrs
    .replace(/\bscene\s*=\s*(?:"[^"]*"|'[^']*')/g, "")
    .replace(/\btotal\s*=\s*(?:"[^"]*"|'[^']*')/g, "")
    .replace(/\btask\s*=\s*(?:"[^"]*"|'[^']*')/g, "")
    .trim();
  if (known) throw new Error("逐场分镜包含未知 storyboardTable 属性");

  return { mode: "scene", content, scene, total, taskId };
}

async function readStoredData(trx: Knex.Transaction, projectId: number, episodesId: number) {
  const script = await trx("o_script").where({ id: episodesId, projectId }).select("id", "content").first();
  if (!script) throw new Error("当前项目不存在该集剧本");
  const scope = { projectId, episodesId, key: "productionAgent" };
  const row = await trx("o_agentWorkData").where(scope).first();
  const data = row?.data
    ? JSON.parse(row.data)
    : { script: script.content ?? "", scriptPlan: "", assets: [], storyboardTable: "", storyboard: [], workbench: { videoList: [] } };
  return { scope, row, data };
}

async function writeStoredData(trx: Knex.Transaction, scope: Record<string, unknown>, row: any, data: any) {
  const payload = JSON.stringify(data);
  if (row) {
    const updated = await trx("o_agentWorkData").where({ id: row.id }).update({ data: payload });
    if (updated !== 1) throw new Error("分镜工作区更新失败");
  } else {
    await trx("o_agentWorkData").insert({ ...scope, data: payload });
  }
  const saved = await trx("o_agentWorkData").where(scope).select("data").first();
  if (!saved || saved.data !== payload) throw new Error("分镜工作区写入后校验失败");
}

export async function readStoryboardTableSnapshot(
  db: Knex,
  projectId: number,
  episodesId: number,
): Promise<StoryboardTableSnapshot> {
  const script = await db("o_script").where({ id: episodesId, projectId }).select("id").first();
  if (!script) throw new Error("当前项目不存在该集剧本");
  const row = await db("o_agentWorkData").where({ projectId, episodesId, key: "productionAgent" }).select("data").first();
  if (!row?.data) return { storyboardTable: "" };
  const data = JSON.parse(row.data);
  return {
    storyboardTable: typeof data.storyboardTable === "string" ? data.storyboardTable : "",
    storyboardTableProgress: data.storyboardTableProgress,
  };
}

export async function commitStoryboardTableOutput(
  db: Knex,
  projectId: number,
  episodesId: number,
  output: StoryboardTableOutput,
  expected?: StoryboardTableSnapshot,
): Promise<StoryboardTableCommit> {
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(episodesId)) throw new Error("分镜表缺少有效项目或剧集 ID");

  return db.transaction(async (trx) => {
    const { scope, row, data } = await readStoredData(trx, projectId, episodesId);
    const currentTable = typeof data.storyboardTable === "string" ? data.storyboardTable : "";
    const currentProgress = data.storyboardTableProgress as StoryboardTableProgress | undefined;

    if (output.mode === "scene") {
      const script = await trx("o_script").where({ id: episodesId, projectId }).select("content").first();
      if (!script) throw new Error("当前项目不存在该集剧本");
      const sourceHash = hashStoryboardSource(script.content ?? "");
      const planHash = hashStoryboardSource(typeof data.scriptPlan === "string" ? data.scriptPlan : "");
      if (currentProgress?.sourceHash && currentProgress.sourceHash !== sourceHash) {
        throw new Error("剧本自分镜任务开始后已修改，不能继续混写旧任务");
      }
      if (currentProgress?.planHash && currentProgress.planHash !== planHash) {
        throw new Error("导演计划自分镜任务开始后已修改，不能继续混写旧任务");
      }
      const merged = mergeStoryboardScene(
        currentTable,
        currentProgress,
        output.taskId,
        output.scene,
        output.total,
        output.content,
      );
      const nextData = {
        ...data,
        storyboardTable: merged.storyboardTable,
        storyboardTableProgress: {
          ...merged.storyboardTableProgress,
          sourceHash: currentProgress?.sourceHash ?? sourceHash,
          planHash: currentProgress?.planHash ?? planHash,
        },
      };
      await writeStoredData(trx, scope, row, nextData);
      return {
        resultRef: `storyboardTable:${projectId}:${episodesId}:scene:${output.scene}`,
        ...merged,
        storyboardTableProgress: nextData.storyboardTableProgress,
      };
    }

    if (currentTable === output.content && !currentProgress) {
      return {
        resultRef: `storyboardTable:${projectId}:${episodesId}:full`,
        storyboardTable: currentTable,
        savedScenes: output.scenes,
        missingScenes: [],
      };
    }

    if (currentProgress) {
      throw new Error("当前存在逐场分镜进度，不能用整表模式静默覆盖");
    }
    if (expected) {
      if (
        currentTable !== expected.storyboardTable ||
        JSON.stringify(currentProgress ?? null) !== JSON.stringify(expected.storyboardTableProgress ?? null)
      ) {
        throw new Error("分镜表在生成期间已被修改，请先查看当前版本再重试");
      }
    } else if (currentTable) {
      throw new Error("工作区已有分镜表，整表写入需要先核对当前版本");
    }

    const nextData = { ...data, storyboardTable: output.content };
    delete nextData.storyboardTableProgress;
    await writeStoredData(trx, scope, row, nextData);
    return {
      resultRef: `storyboardTable:${projectId}:${episodesId}:full`,
      storyboardTable: output.content,
      savedScenes: output.scenes,
      missingScenes: [],
    };
  });
}

export async function reconcileStoryboardTableOutput(
  db: Knex,
  projectId: number,
  episodesId: number,
  response: string | undefined,
): Promise<string | null> {
  if (!response) return null;
  const output = extractStoryboardTable(response);
  const snapshot = await readStoryboardTableSnapshot(db, projectId, episodesId);
  if (output.mode === "full") {
    return snapshot.storyboardTable === output.content
      ? `storyboardTable:${projectId}:${episodesId}:full`
      : null;
  }
  const progress = snapshot.storyboardTableProgress;
  if (
    progress?.taskId === output.taskId &&
    progress.total === output.total &&
    progress.scenes?.[String(output.scene)] === output.content &&
    snapshot.storyboardTable === renderStoryboardScenes(progress.scenes)
  ) {
    return `storyboardTable:${projectId}:${episodesId}:scene:${output.scene}`;
  }
  return null;
}
