import type { Knex } from "knex";
import { extractSingleXmlResult } from "@/utils/agent/runtime/resultValidator";

type ScriptWorkspace = {
  storySkeleton: string;
  adaptationStrategy: string;
  script: Array<{ id?: number; name: string; content: string }>;
};

const emptyWorkspace = (): ScriptWorkspace => ({ storySkeleton: "", adaptationStrategy: "", script: [] });

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function extractScriptWorkspaceField(response: string, field: "storySkeleton" | "adaptationStrategy"): string {
  try {
    return extractSingleXmlResult(response, field);
  } catch (error) {
    throw new Error(`${field === "storySkeleton" ? "故事骨架" : "改编策略"}${error instanceof Error ? error.message : String(error)}`);
  }
}

export function extractScriptItem(response: string): { name: string; content: string } {
  const openings = [...response.matchAll(/<scriptItem\b([^>]*)>/g)];
  const closings = [...response.matchAll(/<\/scriptItem\s*>/g)];
  if (openings.length !== 1 || closings.length !== 1) throw new Error("剧本输出不完整：需要且只能有一份 scriptItem");
  const open = openings[0];
  const close = closings[0];
  if (open.index === undefined || close.index === undefined || close.index < open.index + open[0].length) {
    throw new Error("剧本输出不完整：scriptItem 标签顺序错误");
  }
  const attrs = open[1] ?? "";
  const nameMatch = attrs.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/);
  const name = decodeXmlAttribute((nameMatch?.[1] ?? nameMatch?.[2] ?? "").trim());
  if (!name) throw new Error("剧本输出缺少 scriptItem name");
  const content = response.slice(open.index + open[0].length, close.index).trim();
  if (!content) throw new Error("剧本输出正文为空");
  return { name, content };
}

async function loadWorkspace(trx: Knex.Transaction, projectId: number): Promise<{ row: any; data: ScriptWorkspace }> {
  const project = await trx("o_project").where({ id: projectId }).select("id").first();
  if (!project) throw new Error("当前项目不存在");
  const row = await trx("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
  const parsed = row?.data ? JSON.parse(row.data) : emptyWorkspace();
  return {
    row,
    data: {
      storySkeleton: typeof parsed.storySkeleton === "string" ? parsed.storySkeleton : "",
      adaptationStrategy: typeof parsed.adaptationStrategy === "string" ? parsed.adaptationStrategy : "",
      script: Array.isArray(parsed.script) ? parsed.script : [],
    },
  };
}

export async function readScriptWorkspaceField(
  db: Knex,
  projectId: number,
  field: "storySkeleton" | "adaptationStrategy",
): Promise<string> {
  const row = await db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).select("data").first();
  if (!row?.data) return "";
  const data = JSON.parse(row.data);
  return typeof data[field] === "string" ? data[field] : "";
}

export async function saveScriptWorkspaceField(
  db: Knex,
  projectId: number,
  field: "storySkeleton" | "adaptationStrategy",
  value: string,
  expectedValue: string,
): Promise<void> {
  if (!Number.isSafeInteger(projectId) || !value.trim()) throw new Error("剧本工作区缺少有效项目或内容");
  await db.transaction(async (trx) => {
    const { row, data } = await loadWorkspace(trx, projectId);
    if (data[field] !== expectedValue) throw new Error(`${field === "storySkeleton" ? "故事骨架" : "改编策略"}在生成期间已被修改，请先查看当前版本再重试`);
    const payload = JSON.stringify({ ...data, [field]: value });
    if (row) {
      const updated = await trx("o_agentWorkData").where({ id: row.id }).update({ data: payload });
      if (updated !== 1) throw new Error("剧本工作区更新失败");
    } else {
      await trx("o_agentWorkData").insert({ projectId, key: "scriptAgent", data: payload });
    }
    const saved = await trx("o_agentWorkData").where({ projectId, key: "scriptAgent" }).select("data").first();
    if (!saved || JSON.parse(saved.data ?? "{}")[field] !== value) throw new Error("剧本工作区写入后校验失败");
  });
}

export async function snapshotProjectScripts(db: Knex, projectId: number): Promise<Map<string, string>> {
  const rows = await db("o_script").where({ projectId }).select("name", "content");
  return new Map(rows.map((row) => [String(row.name ?? ""), String(row.content ?? "")]));
}

export async function saveScriptItem(
  db: Knex,
  projectId: number,
  item: { name: string; content: string },
  expectedContent: string | null,
): Promise<number> {
  if (!Number.isSafeInteger(projectId) || !item.name.trim() || !item.content.trim()) throw new Error("剧本缺少有效项目、名称或正文");
  return db.transaction(async (trx) => {
    const project = await trx("o_project").where({ id: projectId }).select("id").first();
    if (!project) throw new Error("当前项目不存在");
    const current = await trx("o_script").where({ projectId, name: item.name }).first();
    if (expectedContent === null) {
      if (current) throw new Error(`剧本“${item.name}”在生成期间已被创建，请先查看当前版本再重试`);
      const [id] = await trx("o_script").insert({ projectId, name: item.name, content: item.content });
      const saved = await trx("o_script").where({ id, projectId }).first();
      if (!saved || saved.content !== item.content) throw new Error("剧本正文写入后校验失败");
      return Number(id);
    }
    if (!current || String(current.content ?? "") !== expectedContent) {
      throw new Error(`剧本“${item.name}”在生成期间已被修改，请先查看当前版本再重试`);
    }
    const updated = await trx("o_script").where({ id: current.id, projectId }).update({ content: item.content });
    if (updated !== 1) throw new Error("剧本正文更新失败");
    const saved = await trx("o_script").where({ id: current.id, projectId }).first();
    if (!saved || saved.content !== item.content) throw new Error("剧本正文写入后校验失败");
    return Number(current.id);
  });
}


/**
 * 仅核对已经持久化的结果，不主动覆盖当前业务数据。
 * 返回 resultRef 表示可以安全把 reconciling 步骤标记为 completed。
 */
export async function reconcileScriptStepOutput(
  db: Knex,
  projectId: number,
  stepKey: string,
  output: string | undefined,
): Promise<string | null> {
  if (!output) return null;
  if (stepKey.startsWith("scriptAgent:storySkeletonAgent:")) {
    const value = extractScriptWorkspaceField(output, "storySkeleton");
    return (await readScriptWorkspaceField(db, projectId, "storySkeleton")) === value ? `storySkeleton:${projectId}` : null;
  }
  if (stepKey.startsWith("scriptAgent:adaptationStrategyAgent:")) {
    const value = extractScriptWorkspaceField(output, "adaptationStrategy");
    return (await readScriptWorkspaceField(db, projectId, "adaptationStrategy")) === value ? `adaptationStrategy:${projectId}` : null;
  }
  if (stepKey.startsWith("scriptAgent:scriptAgent:")) {
    const item = extractScriptItem(output);
    const row = await db("o_script").where({ projectId, name: item.name }).select("id", "content").first();
    return row && String(row.content ?? "") === item.content ? `script:${projectId}:${row.id}` : null;
  }
  // 监督 Agent 没有业务写入；只要完整输出已保存，就可以安全复用。
  if (stepKey.startsWith("scriptAgent:supervisionAgent:")) {
    return output.trim() ? `recovered:${stepKey}` : null;
  }
  return null;
}
