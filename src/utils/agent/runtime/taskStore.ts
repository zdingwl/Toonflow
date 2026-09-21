import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { readFile } from "node:fs/promises";

export type RunStatus = "running" | "completed" | "failed" | "reconciling";
export type StepStatus = RunStatus;

export class TaskStore {
  constructor(private readonly db: Knex) {}

  async begin(input: {
    requestId?: string;
    agentType: "scriptAgent" | "productionAgent";
    projectId: number;
    episodesId?: number;
    isolationKey: string;
    content: string;
  }): Promise<{ id: string; status: RunStatus; duplicate: boolean }> {
    const id = input.requestId && /^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId) ? input.requestId : randomUUID();
    if (!Number.isSafeInteger(input.projectId) || (input.episodesId !== undefined && !Number.isSafeInteger(input.episodesId))) {
      throw new Error("任务缺少有效的项目或剧集 ID");
    }
    const expectedIsolationKey = input.agentType === "productionAgent"
      ? `${input.projectId}:productionAgent:${input.episodesId}`
      : `${input.projectId}:scriptAgent`;
    if (input.isolationKey !== expectedIsolationKey || (input.agentType === "productionAgent" && input.episodesId === undefined)) {
      throw new Error("任务的记忆范围与项目或剧集不匹配");
    }
    const inputHash = createHash("sha256").update(input.content).digest("hex");
    return this.db.transaction(async (trx) => {
      const previous = await trx("o_agentRun").where({ id }).first();
      if (previous) {
        if (
          previous.agentType !== input.agentType || Number(previous.projectId) !== input.projectId ||
          (previous.episodesId == null ? undefined : Number(previous.episodesId)) !== input.episodesId ||
          previous.isolationKey !== input.isolationKey || previous.inputHash !== inputHash
        ) throw new Error("相同 requestId 对应不同任务内容，已拒绝重复提交");
        return { id, status: previous.status as RunStatus, duplicate: true };
      }
      const now = Date.now();
      await trx("o_agentRun").insert({
        id, agentType: input.agentType, projectId: input.projectId, episodesId: input.episodesId ?? null,
        isolationKey: input.isolationKey, inputHash, status: "running", createTime: now, updateTime: now,
      });
      return { id, status: "running" as const, duplicate: false };
    });
  }

  async startStep(runId: string, stepKey: string): Promise<void> {
    await this.db.transaction(async (trx) => {
      const run = await trx("o_agentRun").where({ id: runId }).first();
      if (!run || run.status !== "running") throw new Error("任务已停止，不能继续执行步骤");
      const prior = await trx("o_agentStep").where({ runId, stepKey }).first();
      if (prior) throw new Error(`步骤 ${stepKey} 已执行或状态待核对，不能重复调用`);
      const now = Date.now();
      await trx("o_agentStep").insert({ id: randomUUID(), runId, stepKey, status: "running", createTime: now, updateTime: now });
    });
  }

  async finishStep(runId: string, stepKey: string, resultRef: string): Promise<void> {
    const count = await this.db("o_agentStep").where({ runId, stepKey, status: "running" })
      .update({ status: "completed", resultRef, updateTime: Date.now() });
    if (count !== 1) throw new Error(`步骤 ${stepKey} 完成状态未能保存`);
  }

  async failStep(runId: string, stepKey: string, error: string): Promise<void> {
    await this.db("o_agentStep").where({ runId, stepKey, status: "running" })
      .update({ status: "failed", error, updateTime: Date.now() });
  }

  async finish(runId: string, status: "completed" | "failed" | "reconciling", error?: string): Promise<void> {
    await this.db.transaction(async (trx) => {
      if (status !== "completed") {
        await trx("o_agentStep").where({ runId, status: "running" })
          .update({ status: "reconciling", error: error ?? null, updateTime: Date.now() });
      }
      await trx("o_agentRun").where({ id: runId, status: "running" })
        .update({ status, error: error ?? null, updateTime: Date.now() });
    });
  }

  async reconcile(runId: string): Promise<{ status: RunStatus; steps: Array<{ stepKey: string; status: StepStatus; resultRef?: string }> }> {
    const run = await this.db("o_agentRun").where({ id: runId }).first();
    if (!run) throw new Error("任务不存在");
    const steps = await this.db("o_agentStep").where({ runId }).orderBy("createTime", "asc");
    return { status: run.status as RunStatus, steps: steps.map((step) => ({ stepKey: step.stepKey, status: step.status, resultRef: step.resultRef })) };
  }

  async list(agentType: "scriptAgent" | "productionAgent", projectId: number, episodesId?: number) {
    const query = this.db("o_agentRun").where({ agentType, projectId });
    if (episodesId !== undefined) query.where({ episodesId });
    return query.select("id", "status", "error", "createTime", "updateTime").orderBy("createTime", "desc").limit(20);
  }

  async readSkill(runId: string, filePath: string): Promise<string> {
    const prior = await this.db("o_agentSkillSnapshot").where({ runId, filePath }).first();
    if (prior) return prior.content;
    const content = await readFile(filePath, "utf-8");
    const contentHash = createHash("sha256").update(content).digest("hex");
    return this.db.transaction(async (trx) => {
      const existing = await trx("o_agentSkillSnapshot").where({ runId, filePath }).first();
      if (existing) return existing.content;
      await trx("o_agentSkillSnapshot").insert({ runId, filePath, contentHash, content, createTime: Date.now() });
      return content;
    });
  }
}
