import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { readFile } from "node:fs/promises";

export type RunStatus = "running" | "completed" | "failed" | "reconciling";
export type StepStatus = RunStatus | "retryable";
export type ToolCallStatus = "running" | "completed" | "failed" | "reconciling" | "retryable";

export type RunScope = {
  agentType: "scriptAgent" | "productionAgent";
  projectId: number;
  episodesId?: number;
  isolationKey: string;
};

export type StepState = {
  stepKey: string;
  status: StepStatus;
  resultRef?: string;
  output?: string;
  error?: string;
};

export type ToolCallState = {
  id: string;
  stepKey?: string;
  toolName: string;
  status: ToolCallStatus;
  sideEffect: boolean;
  input?: unknown;
  output?: unknown;
  error?: string;
};

function parseJson(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class TaskStore {
  constructor(private readonly db: Knex) {}

  static makeStepKey(key: string, input: string): string {
    const digest = createHash("sha256").update(`${key}\n${input}`).digest("hex").slice(0, 20);
    return `${key}:${digest}`;
  }

  private validateScope(input: RunScope) {
    if (!Number.isSafeInteger(input.projectId) || (input.episodesId !== undefined && !Number.isSafeInteger(input.episodesId))) {
      throw new Error("任务缺少有效的项目或剧集 ID");
    }
    const expectedIsolationKey = input.agentType === "productionAgent"
      ? `${input.projectId}:productionAgent:${input.episodesId}`
      : `${input.projectId}:scriptAgent`;
    if (input.isolationKey !== expectedIsolationKey || (input.agentType === "productionAgent" && input.episodesId === undefined)) {
      throw new Error("任务的记忆范围与项目或剧集不匹配");
    }
  }

  async begin(input: RunScope & {
    requestId?: string;
    content: string;
  }): Promise<{ id: string; status: RunStatus; duplicate: boolean }> {
    this.validateScope(input);
    const id = input.requestId && /^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId) ? input.requestId : randomUUID();
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
        isolationKey: input.isolationKey, inputHash, inputContent: input.content,
        status: "running", createTime: now, updateTime: now,
      });
      return { id, status: "running" as const, duplicate: false };
    });
  }

  async beginStep(runId: string, stepKey: string, inputContent: string): Promise<{ cached: boolean; output?: string; resultRef?: string }> {
    const inputHash = createHash("sha256").update(inputContent).digest("hex");
    return this.db.transaction(async (trx) => {
      const run = await trx("o_agentRun").where({ id: runId }).first();
      if (!run || run.status !== "running") throw new Error("任务已停止，不能继续执行步骤");
      const prior = await trx("o_agentStep").where({ runId, stepKey }).first();
      if (prior) {
        if (prior.inputHash && prior.inputHash !== inputHash) throw new Error(`步骤 ${stepKey} 输入已变化，拒绝复用旧结果`);
        if (prior.status === "completed") {
          return { cached: true, output: prior.output ?? undefined, resultRef: prior.resultRef ?? undefined };
        }
        if (prior.status === "retryable") {
          const claimed = await trx("o_agentStep").where({ runId, stepKey, status: "retryable" }).update({
            status: "running", output: null, resultRef: null, error: null, updateTime: Date.now(),
          });
          if (claimed !== 1) throw new Error(`步骤 ${stepKey} 的重试状态已变化，请重新核对`);
          return { cached: false };
        }
        throw new Error(`步骤 ${stepKey} 当前状态为 ${prior.status}，必须先核对结果再继续`);
      }
      const now = Date.now();
      await trx("o_agentStep").insert({
        id: randomUUID(), runId, stepKey, inputHash, inputContent, status: "running", createTime: now, updateTime: now,
      });
      return { cached: false };
    });
  }

  /** 兼容旧调用；新代码优先使用 beginStep，以便恢复时复用已完成结果。 */
  async startStep(runId: string, stepKey: string): Promise<void> {
    const state = await this.beginStep(runId, stepKey, stepKey);
    if (state.cached) throw new Error(`步骤 ${stepKey} 已执行，不能重复调用`);
  }

  async saveStepOutput(runId: string, stepKey: string, output: string): Promise<void> {
    const count = await this.db("o_agentStep").where({ runId, stepKey, status: "running" })
      .update({ output, updateTime: Date.now() });
    if (count !== 1) throw new Error(`步骤 ${stepKey} 输出状态未能保存`);
  }

  async finishStep(runId: string, stepKey: string, resultRef: string): Promise<void> {
    const count = await this.db("o_agentStep").where({ runId, stepKey, status: "running" })
      .update({ status: "completed", resultRef, error: null, updateTime: Date.now() });
    if (count !== 1) throw new Error(`步骤 ${stepKey} 完成状态未能保存`);
  }

  async failStep(runId: string, stepKey: string, error: string): Promise<void> {
    await this.db("o_agentStep").where({ runId, stepKey, status: "running" })
      .update({ status: "failed", error, updateTime: Date.now() });
  }

  /** 对已经开始但无法证明无副作用的步骤，必须进入 reconciling，而不是盲目重跑。 */
  async markStepReconciling(runId: string, stepKey: string, error: string): Promise<void> {
    await this.db("o_agentStep").where({ runId, stepKey }).whereIn("status", ["running", "failed"])
      .update({ status: "reconciling", error, updateTime: Date.now() });
  }

  async resolveStep(
    runId: string,
    stepKey: string,
    resolution: "completed" | "failed" | "retryable",
    resultRef?: string,
    error?: string,
  ): Promise<void> {
    const count = await this.db("o_agentStep").where({ runId, stepKey }).whereIn("status", ["reconciling", "failed"])
      .update({
        status: resolution,
        resultRef: resolution === "completed" ? resultRef ?? null : null,
        error: resolution === "completed" ? null : error ?? (resolution === "retryable" ? "已核对，可安全重试" : "已核对为失败"),
        updateTime: Date.now(),
      });
    if (count !== 1) throw new Error(`步骤 ${stepKey} 不在可核对状态`);
  }

  async resolveToolCall(
    runId: string,
    id: string,
    resolution: "completed" | "retryable",
    output?: unknown,
    error?: string,
  ): Promise<void> {
    const count = await this.db("o_agentToolCall")
      .where({ id, runId, sideEffect: 1 })
      .whereIn("status", ["running", "reconciling", "failed"])
      .update({
        status: resolution,
        outputJson: resolution === "completed" ? JSON.stringify(output ?? null) : null,
        error: resolution === "completed" ? null : error ?? "已核对，可安全重试",
        updateTime: Date.now(),
      });
    if (count !== 1) throw new Error("工具调用不在可核对状态");
  }

  async finish(runId: string, status: "completed" | "failed" | "reconciling", error?: string): Promise<void> {
    await this.db.transaction(async (trx) => {
      if (status === "completed") {
        const [unresolvedSteps, unresolvedTools] = await Promise.all([
          trx("o_agentStep").where({ runId }).whereIn("status", ["running", "reconciling", "failed", "retryable"]),
          trx("o_agentToolCall").where({ runId, sideEffect: 1 }).whereIn("status", ["running", "reconciling", "failed", "retryable"]),
        ]);
        if (unresolvedSteps.length || unresolvedTools.length) {
          throw new Error(`任务仍有待处理状态：步骤 ${unresolvedSteps.length} 个，写工具 ${unresolvedTools.length} 个，不能标记完成`);
        }
      } else {
        await trx("o_agentStep").where({ runId, status: "running" })
          .update({ status: "reconciling", error: error ?? null, updateTime: Date.now() });
        await trx("o_agentToolCall").where({ runId, status: "running", sideEffect: 1 })
          .update({ status: "reconciling", error: error ?? null, updateTime: Date.now() });
      }
      await trx("o_agentRun").where({ id: runId, status: "running" })
        .update({ status, error: error ?? null, updateTime: Date.now() });
    });
  }

  async getRun(runId: string) {
    const run = await this.db("o_agentRun").where({ id: runId }).first();
    if (!run) throw new Error("任务不存在");
    return run;
  }

  async resume(runId: string, scope: RunScope): Promise<{ id: string; content: string }> {
    this.validateScope(scope);
    return this.db.transaction(async (trx) => {
      const run = await trx("o_agentRun").where({ id: runId }).first();
      if (!run) throw new Error("任务不存在");
      if (
        run.agentType !== scope.agentType || Number(run.projectId) !== scope.projectId ||
        (run.episodesId == null ? undefined : Number(run.episodesId)) !== scope.episodesId ||
        run.isolationKey !== scope.isolationKey
      ) throw new Error("任务不属于当前项目或 Agent 上下文");
      if (!["reconciling", "failed"].includes(run.status)) throw new Error(`任务当前状态为 ${run.status}，不能恢复`);

      const unresolvedSteps = await trx("o_agentStep").where({ runId }).whereIn("status", ["running", "reconciling", "failed"]);
      if (unresolvedSteps.length) {
        throw new Error(`仍有 ${unresolvedSteps.length} 个步骤需要核对，不能自动恢复`);
      }
      const unresolvedTools = await trx("o_agentToolCall")
        .where({ runId, sideEffect: 1 })
        .whereIn("status", ["running", "reconciling", "failed"]);
      if (unresolvedTools.length) {
        throw new Error(`仍有 ${unresolvedTools.length} 个写工具调用需要核对，不能自动恢复`);
      }
      if (typeof run.inputContent !== "string" || !run.inputContent.length) {
        throw new Error("旧任务未保存原始输入，无法自动恢复");
      }
      const updated = await trx("o_agentRun").where({ id: runId, status: run.status })
        .update({ status: "running", error: null, updateTime: Date.now() });
      if (updated !== 1) throw new Error("任务状态已变化，请刷新后重试");
      return { id: runId, content: run.inputContent };
    });
  }

  async reconcile(runId: string): Promise<{ status: RunStatus; steps: StepState[]; toolCalls: ToolCallState[] }> {
    const run = await this.db("o_agentRun").where({ id: runId }).first();
    if (!run) throw new Error("任务不存在");
    const [steps, toolCalls] = await Promise.all([
      this.db("o_agentStep").where({ runId }).orderBy("createTime", "asc"),
      this.db("o_agentToolCall").where({ runId }).orderBy("createTime", "asc"),
    ]);
    return {
      status: run.status as RunStatus,
      steps: steps.map((step) => ({
        stepKey: step.stepKey,
        status: step.status,
        resultRef: step.resultRef ?? undefined,
        output: step.output ?? undefined,
        error: step.error ?? undefined,
      })),
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        stepKey: call.stepKey ?? undefined,
        toolName: call.toolName,
        status: call.status,
        sideEffect: Number(call.sideEffect) === 1,
        input: parseJson(call.inputJson),
        output: parseJson(call.outputJson),
        error: call.error ?? undefined,
      })),
    };
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
