import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";

export type OperationReceiptScope = {
  projectId: number;
  episodesId: number;
};

export type OperationReceipt<T = unknown> = {
  version: 1;
  kind: string;
  requestId: string;
  inputHash: string;
  data: T;
  createTime: number;
  claimToken?: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + stableJson(object[key])).join(",") + "}";
}

export function operationInputHash(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function operationReceiptKey(kind: string, requestId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new Error("操作 requestId 无效");
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(kind)) throw new Error("操作回执类型无效");
  return `agentReceipt:${kind}:${requestId}`;
}

export function operationReceiptId(kind: string, requestId: string): number {
  const digest = createHash("sha256").update(`${kind}\n${requestId}`).digest("hex");
  // o_agentWorkData 普通记录使用 SQLite 正整数 rowid；Agent 回执使用负的 52-bit 确定性 ID，避免并发重复插入。
  const value = Number.parseInt(digest.slice(0, 13), 16);
  return -(value + 1);
}

function parseReceipt<T>(raw: string | null | undefined): OperationReceipt<T> {
  if (!raw) throw new Error("操作回执内容为空");
  const parsed = JSON.parse(raw) as OperationReceipt<T>;
  if (
    parsed?.version !== 1 ||
    typeof parsed.kind !== "string" ||
    typeof parsed.requestId !== "string" ||
    typeof parsed.inputHash !== "string"
  ) throw new Error("操作回执格式无效");
  return parsed;
}

export async function getOperationReceipt<T = unknown>(
  db: Knex,
  scope: OperationReceiptScope,
  kind: string,
  requestId: string,
  expectedInput?: unknown,
): Promise<OperationReceipt<T> | null> {
  const id = operationReceiptId(kind, requestId);
  const key = operationReceiptKey(kind, requestId);
  const row = await db("o_agentWorkData").where({ id }).first();
  if (!row) return null;
  if (
    Number(row.projectId) !== scope.projectId ||
    Number(row.episodesId) !== scope.episodesId ||
    row.key !== key
  ) throw new Error("操作回执 ID 冲突或作用域不匹配");
  const receipt = parseReceipt<T>(row.data);
  if (receipt.kind !== kind || receipt.requestId !== requestId) throw new Error("操作回执标识不匹配");
  if (expectedInput !== undefined && receipt.inputHash !== operationInputHash(expectedInput)) {
    throw new Error("相同 requestId 对应不同操作内容");
  }
  return receipt;
}

export async function withOperationReceipt<T>(
  db: Knex,
  scope: OperationReceiptScope,
  kind: string,
  requestId: string,
  input: unknown,
  create: (trx: Knex.Transaction) => Promise<T>,
): Promise<{ duplicate: boolean; receipt: OperationReceipt<T> }> {
  return db.transaction(async (trx) => {
    const prior = await getOperationReceipt<T>(trx as unknown as Knex, scope, kind, requestId, input);
    if (prior) return { duplicate: true, receipt: prior };

    const id = operationReceiptId(kind, requestId);
    const key = operationReceiptKey(kind, requestId);
    const inputHash = operationInputHash(input);
    const createTime = Date.now();
    const claimToken = randomUUID();
    const provisional: OperationReceipt<null> = {
      version: 1,
      kind,
      requestId,
      inputHash,
      data: null,
      createTime,
      claimToken,
    };

    // 先用确定性主键抢占操作，再执行真正副作用。两个并发重试最多只有一个能拥有 claimToken。
    await trx("o_agentWorkData").insert({
      id,
      projectId: scope.projectId,
      episodesId: scope.episodesId,
      key,
      data: JSON.stringify(provisional),
      createTime,
      updateTime: createTime,
    }).onConflict("id").ignore();

    const claimedRow = await trx("o_agentWorkData").where({ id }).first();
    if (!claimedRow) throw new Error("操作回执抢占失败");
    if (
      Number(claimedRow.projectId) !== scope.projectId ||
      Number(claimedRow.episodesId) !== scope.episodesId ||
      claimedRow.key !== key
    ) throw new Error("操作回执 ID 冲突或作用域不匹配");
    const claimedReceipt = parseReceipt<any>(claimedRow.data);
    if (claimedReceipt.inputHash !== inputHash || claimedReceipt.kind !== kind || claimedReceipt.requestId !== requestId) {
      throw new Error("相同 requestId 对应不同操作内容");
    }
    if (claimedReceipt.claimToken !== claimToken) {
      if (claimedReceipt.data == null) throw new Error("相同操作正在由另一个请求提交，请稍后重试");
      return { duplicate: true, receipt: claimedReceipt as OperationReceipt<T> };
    }

    const data = await create(trx);
    const receipt: OperationReceipt<T> = {
      version: 1,
      kind,
      requestId,
      inputHash,
      data,
      createTime,
      claimToken,
    };
    const updated = await trx("o_agentWorkData").where({ id }).update({
      data: JSON.stringify(receipt),
      updateTime: Date.now(),
    });
    if (updated !== 1) throw new Error("操作回执完成状态写入失败");

    const saved = await getOperationReceipt<T>(trx as unknown as Knex, scope, kind, requestId, input);
    if (!saved || saved.data == null) throw new Error("操作回执写入失败");
    return { duplicate: false, receipt: saved };
  });
}
