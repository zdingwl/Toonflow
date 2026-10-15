import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";

const runTable = "o_assetExtractionRun";
const stepTable = "o_assetExtractionStep";
const stageLabels: Record<string, string> = {
  discovery: "识别资产", facts: "收集人物事实", factReview: "核对人物事实", merge: "归并事实", card: "生成角色卡",
  design: "生成资产描述", validation: "校验结果", saving: "保存资产", complete: "已完成",
};

/** Stable JSON hashing prevents object-property order from invalidating a checkpoint. */
function fingerprint(value: unknown): string {
  const ancestors = new Set<object>();
  function normalize(input: any): any {
    if (input === null || typeof input !== "object") {
      if (typeof input === "bigint") return { $bigint: input.toString() };
      return input;
    }
    if (ancestors.has(input)) throw new TypeError("资产提取进度输入不能包含循环引用");
    ancestors.add(input);
    const output = Array.isArray(input) ? input.map(normalize)
      : typeof input.toJSON === "function" ? normalize(input.toJSON())
      : Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key])]));
    ancestors.delete(input);
    return output;
  }
  return createHash("sha256").update(JSON.stringify(normalize(value)) ?? "undefined").digest("hex");
}

/** Called by startup migration only; extraction must never mutate a legacy fixture's schema. */
export async function migrateAssetExtractionCheckpoints(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable(runTable))) await db.schema.createTable(runTable, table => {
    table.increments("id"); table.string("runId", 36).notNullable().unique(); table.integer("projectId").notNullable();
    table.string("scriptSetHash", 64).notNullable(); table.text("scriptIds").notNullable();
    table.string("signatureHash", 64).notNullable(); table.string("status", 16).notNullable();
    table.string("stage", 40).notNullable(); table.integer("completed").notNullable().defaultTo(0);
    table.integer("total").notNullable().defaultTo(0); table.text("label"); table.text("error");
    table.bigInteger("createdAt").notNullable(); table.bigInteger("updatedAt").notNullable(); table.bigInteger("completedAt");
    table.index(["projectId", "scriptSetHash", "signatureHash", "status"]);
  });
  if (!(await db.schema.hasTable(stepTable))) await db.schema.createTable(stepTable, table => {
    table.increments("id"); table.string("runId", 36).notNullable().references("runId").inTable(runTable).onDelete("CASCADE");
    table.string("stage", 40).notNullable(); table.text("key").notNullable(); table.string("inputHash", 64).notNullable();
    table.text("result").notNullable(); table.bigInteger("createdAt").notNullable(); table.bigInteger("updatedAt").notNullable();
    table.unique(["runId", "stage", "key", "inputHash"]);
  });
}

export interface AssetExtractionCheckpoint {
  runId: string | null;
  enabled: boolean;
  read(stage: string, key: string, input: unknown): Promise<any | undefined>;
  write(stage: string, key: string, input: unknown, result: unknown): Promise<void>;
  progress(stage: string, completed: number, total: number, label?: string): Promise<void>;
  /** Call only after the final asset transaction has committed successfully. */
  complete(): Promise<void>;
  fail(error: unknown): Promise<void>;
}

async function checkpointTablesExist(db: Knex): Promise<boolean> {
  return !!db.schema?.hasTable && await db.schema.hasTable(runTable) && await db.schema.hasTable(stepTable);
}

/** Single-process startup only, before accepting requests: running rows belong to the stopped process. */
export async function recoverStaleAssetExtractionRuns(db: Knex): Promise<number> {
  if (!(await checkpointTablesExist(db))) return 0;
  return db(runTable).where({ status: "running" }).update({
    status: "failed", error: "服务已重新启动；再次提取将从已保存的阶段继续", updatedAt: Date.now(),
  });
}

/**
 * signature must include effective model/configuration, rules, original scripts and candidate-card
 * versions. Steps also hash their exact inputs. Store only schema-validated successful results, and
 * schema-validate read results again at the call site. Failed or uncommitted calls have no cache row.
 */
export async function createAssetExtractionCheckpoint(db: Knex, options: {
  projectId: number; scriptIds: number[]; signature: unknown;
}): Promise<AssetExtractionCheckpoint> {
  if (!(await checkpointTablesExist(db))) return {
    runId: null, enabled: false, read: async () => undefined, write: async () => {},
    progress: async () => {}, complete: async () => {}, fail: async () => {},
  };
  const scriptIds = [...new Set(options.scriptIds)].sort((a, b) => a - b);
  const scriptSetHash = fingerprint(scriptIds), signatureHash = fingerprint(options.signature);
  // Completed runs are history. An explicit subsequent extraction must start a fresh run.
  const failedRun = await db(runTable).where({ projectId: options.projectId, scriptSetHash, signatureHash, status: "failed" })
    .orderBy("updatedAt", "desc").first();
  const runId: string = failedRun?.runId ?? randomUUID();
  const now = Date.now();
  if (failedRun) {
    const claimed = await db(runTable).where({ runId, status: "failed" }).update({ status: "running", error: null, updatedAt: now });
    // A simultaneous request already claimed this run. Give it independent checkpoints.
    if (!claimed) return createFreshCheckpoint(db, options.projectId, scriptIds, scriptSetHash, signatureHash);
  } else await insertRun(db, runId, options.projectId, scriptIds, scriptSetHash, signatureHash);
  return checkpointForRun(db, runId, signatureHash);
}

async function insertRun(db: Knex, runId: string, projectId: number, scriptIds: number[], scriptSetHash: string, signatureHash: string) {
  const now = Date.now();
  await db(runTable).insert({ runId, projectId, scriptIds: JSON.stringify(scriptIds), scriptSetHash, signatureHash,
    status: "running", stage: "discovery", completed: 0, total: 0, createdAt: now, updatedAt: now });
}

async function createFreshCheckpoint(db: Knex, projectId: number, scriptIds: number[], scriptSetHash: string, signatureHash: string) {
  const runId = randomUUID();
  await insertRun(db, runId, projectId, scriptIds, scriptSetHash, signatureHash);
  return checkpointForRun(db, runId, signatureHash);
}

function checkpointForRun(db: Knex, runId: string, signatureHash: string): AssetExtractionCheckpoint {
  const inputHash = (stage: string, key: string, input: unknown) => fingerprint({ signatureHash, stage, key, input });
  return {
    runId, enabled: true,
    async read(stage, key, input) {
      const result = await db(stepTable).where({ runId, stage, key, inputHash: inputHash(stage, key, input) }).first("result");
      if (!result) return undefined;
      try { return JSON.parse(result.result); } catch { return undefined; }
    },
    async write(stage, key, input, result) {
      const serialized = JSON.stringify(result);
      if (serialized === undefined) throw new TypeError("资产提取进度只能保存可序列化的成功结果");
      const hash = inputHash(stage, key, input), now = Date.now();
      await db.transaction(async trx => {
        const run = await trx(runTable).where({ runId, status: "running" }).first("runId");
        if (!run) throw new Error("资产提取已结束，不能继续保存阶段结果");
        await trx(stepTable).insert({ runId, stage, key, inputHash: hash, result: serialized, createdAt: now, updatedAt: now })
          .onConflict(["runId", "stage", "key", "inputHash"]).merge({ result: serialized, updatedAt: now });
        await trx(runTable).where({ runId, status: "running" }).update({ updatedAt: now });
      });
    },
    async progress(stage, completed, total, label) {
      if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || total < completed)
        throw new Error("资产提取阶段进度无效");
      // Even saving N/N is still running until the caller confirms the asset transaction committed.
      await db(runTable).where({ runId, status: "running" }).update({ stage, completed, total, label: label ?? null, updatedAt: Date.now() });
    },
    async complete() {
      const now = Date.now();
      await db(runTable).where({ runId, status: "running" }).update({
        status: "completed", stage: "complete", error: null, completedAt: now, updatedAt: now,
      });
    },
    async fail(error) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "资产提取失败");
      await db(runTable).where({ runId, status: "running" }).update({ status: "failed", error: message, updatedAt: Date.now() });
    },
  };
}

export interface AssetExtractionProgress {
  runId: string; projectId: number; scriptIds: number[]; status: "running" | "failed" | "completed";
  stage: string; stageLabel: string; completed: number; total: number; label: string | null;
  error: string | null; createdAt: number; updatedAt: number; completedAt: number | null;
}

export async function getAssetExtractionProgress(db: Knex, projectId: number): Promise<AssetExtractionProgress | null> {
  if (!(await checkpointTablesExist(db))) return null;
  const row = await db(runTable).where({ projectId }).orderBy("updatedAt", "desc").orderBy("id", "desc").first();
  if (!row) return null;
  return { runId: row.runId, projectId: row.projectId, scriptIds: JSON.parse(row.scriptIds), status: row.status,
    stage: row.stage, stageLabel: stageLabels[row.stage] ?? row.stage, completed: row.completed, total: row.total,
    label: row.label ?? null, error: row.error ?? null, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
    completedAt: row.completedAt == null ? null : Number(row.completedAt) };
}
