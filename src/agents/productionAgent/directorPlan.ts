import type { Knex } from "knex";
import { extractSingleXmlResult } from "@/utils/agent/runtime/resultValidator";

export function extractDirectorPlan(response: string): string {
  try {
    return extractSingleXmlResult(response, "scriptPlan");
  } catch (error) {
    throw new Error(`导演计划${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveDirectorPlan(db: Knex, projectId: number, episodesId: number, plan: string, expectedPlan: string): Promise<void> {
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(episodesId) || !plan.trim()) {
    throw new Error("导演计划缺少有效的项目、剧集或内容");
  }
  await db.transaction(async (trx) => {
    const script = await trx("o_script").where({ id: episodesId, projectId }).select("content").first();
    if (!script) throw new Error("当前项目不存在该集剧本");
    const scope = { projectId, episodesId, key: "productionAgent" };
    const existing = await trx("o_agentWorkData").where(scope).first();
    const current = existing ? JSON.parse(existing.data || "{}") : {
      script: script.content ?? "", scriptPlan: "", assets: [], storyboardTable: "", storyboard: [], workbench: { videoList: [] },
    };
    if ((current.scriptPlan ?? "") !== expectedPlan) throw new Error("导演计划在生成期间已被修改，请先查看当前版本再重试");
    const serialized = JSON.stringify({ ...current, scriptPlan: plan });
    if (existing) {
      await trx("o_agentWorkData").where({ id: existing.id }).update({ data: serialized, updateTime: Date.now() });
    } else {
      await trx("o_agentWorkData").insert({ ...scope, data: serialized, createTime: Date.now(), updateTime: Date.now() });
    }
    const saved = await trx("o_agentWorkData").where(scope).select("data").first();
    if (!saved || JSON.parse(saved.data ?? "{}").scriptPlan !== plan) throw new Error("导演计划写入后校验失败");
  });
}


/** 只核对数据库是否已经存在模型输出，不在恢复阶段自动覆盖用户后来修改的计划。 */
export async function reconcileDirectorPlanOutput(
  db: Knex,
  projectId: number,
  episodesId: number,
  output: string | undefined,
): Promise<string | null> {
  if (!output) return null;
  const plan = extractDirectorPlan(output);
  const row = await db("o_agentWorkData").where({ projectId, episodesId, key: "productionAgent" }).select("data").first();
  if (!row?.data) return null;
  const current = JSON.parse(row.data);
  return current.scriptPlan === plan ? `directorPlan:${projectId}:${episodesId}` : null;
}
