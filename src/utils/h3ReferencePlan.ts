import { createHash } from "node:crypto";
import type { RoleReferenceKind } from "@/utils/assetReferenceMedia";
import { h3AssetType, h3ImageAssetItems, type H3SlotItem } from "./h3ReferenceSlots";
import { assertH3ReferenceBindings } from "./h3ReferenceBindings";

export interface H3ReferencePlanSlot {
  assetId: number;
  assetType: string;
  kind?: RoleReferenceKind;
  path: string;
  label: string;
}
export interface H3ReferencePlan { version: 1; slots: H3ReferencePlanSlot[] }
export interface H3RuntimeReference {
  path: string; label: string; sourceType: "assets"; assetType: string;
  fileType: "image"; referenceType: "imageReference"; assetId: number;
  referenceKind?: RoleReferenceKind; prompt?: string;
}
const fields: Record<RoleReferenceKind, string> = {
  FACE: "faceReferencePath", FULL_BODY_FRONT: "fullBodyReferencePath",
  FULL_BODY_SIDE: "sideReferencePath", FULL_BODY_BACK: "backReferencePath",
};
const labels: Record<RoleReferenceKind, string> = {
  FACE: "脸部身份参考", FULL_BODY_FRONT: "正面全身参考",
  FULL_BODY_SIDE: "侧面全身参考", FULL_BODY_BACK: "背面全身参考",
};
const canonicalPath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "");
const promptHash = (prompt: string) => createHash("sha256").update(prompt, "utf8").digest("hex");
const regenerate = (reason: string) => new Error(`${reason}，请重新生成视频提示词`);

/** New slots use the current asset board; crop fields only describe historical plans. */
export function h3SlotPath(item: H3SlotItem): string {
  const kind = item._referenceRole || item.referenceKind;
  const name = String(item.name || item.label || "资产").replace(/(?:脸部身份参考|正面全身参考|侧面全身参考|背面全身参考)$/, "");
  if (kind && !Object.hasOwn(fields, kind)) throw regenerate(`${name}的人物参考类型无效`);
  const path = kind ? item[fields[kind as RoleReferenceKind]] : item.filePath || item.path;
  if (typeof path !== "string" || !path.trim()) throw new Error(`${name}缺少${kind ? labels[kind as RoleReferenceKind] : "图片"}，请先补齐当前资产参考图后重新生成视频提示词`);
  return path;
}

function validatePlan(value: unknown): H3ReferencePlan {
  const plan = value as H3ReferencePlan;
  if (!plan || plan.version !== 1 || !Array.isArray(plan.slots) || plan.slots.length > 9) throw regenerate("已保存的 H3 参考图计划无效");
  const seen = new Set<string>();
  for (const slot of plan.slots) {
    if (!slot || !Number.isSafeInteger(slot.assetId) || typeof slot.assetType !== "string" || !slot.assetType || typeof slot.path !== "string" || !slot.path.trim() || typeof slot.label !== "string" || (slot.kind && !Object.hasOwn(fields, slot.kind))) throw regenerate("已保存的 H3 参考图计划不完整");
    if (slot.kind && slot.assetType !== "role") throw regenerate("已保存的 H3 人物参考类型不一致");
    const key = `${slot.assetId}:${slot.kind || "image"}`;
    if (seen.has(key)) throw regenerate("已保存的 H3 参考图计划存在重复槽位");
    seen.add(key);
  }
  const roles = new Set(plan.slots.filter(slot => slot.assetType === "role").map(slot => slot.assetId));
  for (const id of roles) {
    const slots = plan.slots.filter(slot => slot.assetId === id);
    if (slots.some(slot => !slot.kind)) {
      if (slots.length !== 1) throw regenerate("人物整图不能与独立视图混用");
    } else if (!slots.some(slot => slot.kind === "FULL_BODY_FRONT")) throw regenerate("已保存的 H3 计划缺少人物正面全身参考");
  }
  return plan;
}

const pendingTables = new WeakMap<object, Promise<void>>();
async function ensurePlanTable(db: any): Promise<void> {
  let pending = pendingTables.get(db);
  if (!pending) {
    pending = (async () => {
      if (await db.schema.hasTable("o_h3ReferencePlan")) return;
      try {
        await db.schema.createTable("o_h3ReferencePlan", (table: any) => {
          table.bigInteger("trackId").notNullable();
          table.string("promptHash", 64).notNullable();
          table.text("plan").notNullable();
          table.primary(["trackId", "promptHash"]);
        });
      } catch (cause) {
        // Separate Knex instances may race; only an actually created table resolves that race.
        if (!(await db.schema.hasTable("o_h3ReferencePlan"))) throw cause;
      }
    })();
    pendingTables.set(db, pending);
  }
  try { await pending; } catch (cause) { if (pendingTables.get(db) === pending) pendingTables.delete(db); throw cause; }
}

async function persistPlan(db: any, trackId: number, prompt: string, plan: H3ReferencePlan): Promise<H3ReferencePlan> {
  if (!Number.isSafeInteger(trackId) || !prompt.trim()) throw regenerate("H3 提示词或视频段无效");
  validatePlan(plan);
  await ensurePlanTable(db);
  const key = { trackId, promptHash: promptHash(prompt) };
  const serialized = JSON.stringify(plan);
  await db("o_h3ReferencePlan").insert({ ...key, plan: serialized }).onConflict(["trackId", "promptHash"]).ignore();
  const stored = await db("o_h3ReferencePlan").where(key).first();
  if (stored?.plan !== serialized) throw regenerate("同一提示词已绑定不同的参考图，不可覆盖历史计划");
  return plan;
}

export async function saveH3ReferencePlan(db: any, trackId: number, prompt: string, slots: H3SlotItem[]): Promise<H3ReferencePlan> {
  const plan: H3ReferencePlan = {
    version: 1,
    slots: slots.filter(slot => h3ImageAssetItems([slot]).length > 0).map(slot => ({
      assetId: Number(slot.assetId ?? slot.id), assetType: h3AssetType(slot),
      ...(slot._referenceRole || slot.referenceKind ? { kind: slot._referenceRole || slot.referenceKind } : {}),
      path: h3SlotPath(slot), label: String(slot.name || slot.label || `资产${slot.assetId ?? slot.id}`),
    })),
  };
  return persistPlan(db, trackId, prompt, plan);
}

export async function loadH3ReferencePlan(db: any, trackId: number, prompt: string): Promise<H3ReferencePlan | null> {
  // Read-only preflight must never create schema or alter legacy projects.
  if (!(await db.schema.hasTable("o_h3ReferencePlan"))) return null;
  const stored = await db("o_h3ReferencePlan").where({ trackId, promptHash: promptHash(prompt) }).first();
  if (!stored) return null;
  try { return validatePlan(JSON.parse(stored.plan)); } catch { throw regenerate("已保存的 H3 参考图计划无法读取"); }
}

/** Restore the saved whole-image order; historical crop plans require prompt regeneration. */
export function resolveH3ReferencePlan(items: H3SlotItem[], plan: H3ReferencePlan): H3RuntimeReference[] {
  validatePlan(plan);
  if (plan.slots.some(slot => slot.kind)) throw regenerate("该视频段仍绑定人物独立视图，现已改为每个人物一张完整参考图");
  const assets = h3ImageAssetItems(items);
  const byId = new Map(assets.map(item => [Number(item.assetId ?? item.id), item]));
  const expectedIds = new Set(plan.slots.map(slot => slot.assetId));
  if (byId.size !== expectedIds.size || [...expectedIds].some(id => !byId.has(id))) throw regenerate("当前图片资产集合与提示词保存的参考图计划不一致");
  return plan.slots.map(slot => {
    const current = byId.get(slot.assetId)!;
    if (h3AssetType(current) !== slot.assetType) throw regenerate(`${slot.label}的资产类型已变化`);
    const currentPath = h3SlotPath({ ...current, _referenceRole: slot.kind, referenceKind: slot.kind });
    if (canonicalPath(currentPath) !== canonicalPath(slot.path)) throw regenerate(`${slot.label}的参考图片已变化`);
    return {
      path: slot.path, label: slot.label, sourceType: "assets", assetType: slot.assetType,
      fileType: "image", referenceType: "imageReference", assetId: slot.assetId,
      ...(slot.kind ? { referenceKind: slot.kind } : {}),
      ...(current.prompt ? { prompt: current.prompt } : {}),
    };
  });
}

function pictureNumbers(prompt: string): number[] {
  return [...new Set([...prompt.replace(/<d>[\s\S]*?<\/d>/g, "").matchAll(/<Picture\s+(\d+)>/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
}

/** Translation and manual edits may copy a plan only while the numbered Picture set stays identical. */
export async function copyH3ReferencePlan(db: any, trackId: number, sourcePrompt: string, targetPrompt: string): Promise<H3ReferencePlan | null> {
  const plan = await loadH3ReferencePlan(db, trackId, sourcePrompt);
  if (!plan) return null;
  const expected = plan.slots.map((_, index) => index + 1);
  if (JSON.stringify(pictureNumbers(sourcePrompt)) !== JSON.stringify(expected) || JSON.stringify(pictureNumbers(targetPrompt)) !== JSON.stringify(expected)) throw regenerate("参考图编号已变化");
  assertH3ReferenceBindings(targetPrompt, plan.slots, sourcePrompt);
  return persistPlan(db, trackId, targetPrompt, plan);
}
