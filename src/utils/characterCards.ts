import type { Knex } from "knex";
import { z } from "zod";
import { createHash } from "node:crypto";

export const characterAgeBands = ["unknown", "child", "teen", "adult", "middle", "elderly"] as const;
export type CharacterAgeBand = typeof characterAgeBands[number];
export const characterVisualFields = ["face", "body", "hair", "clothing", "environment", "shape"] as const;
export type CharacterVisualField = typeof characterVisualFields[number];
export type CharacterVisualDesign = Record<CharacterVisualField, string>;
export const characterVisualDesignSchema = z.object(Object.fromEntries(characterVisualFields.map(field => [field, z.string().trim().max(1600)])) as Record<CharacterVisualField, z.ZodString>);
const ageNumber = z.number().int().min(0).max(120).nullable().optional();
export const characterCardInputSchema = z.object({
  id: z.number().int().positive().optional(), version: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100), artStyle: z.string().trim().min(1).max(100),
  roleDefinition: z.string().trim().min(1).max(600),
  ageMin: ageNumber, ageMax: ageNumber, ageBand: z.enum(characterAgeBands).default("unknown"),
  gender: z.string().trim().max(40).default("unknown"),
  visualDesign: characterVisualDesignSchema, describe: z.string().trim().max(6000).default(""),
});
export type CharacterCardInput = z.input<typeof characterCardInputSchema>;
export interface CharacterCardReference { cardId: number; version: number; borrowedFields: CharacterVisualField[] }
export interface CharacterCardProvenance {
  method: "seed" | "manual" | "generated" | "from_asset";
  references: CharacterCardReference[];
}
export interface CharacterCard {
  id: number; ownerId: number; name: string; artStyle: string; roleDefinition: string;
  ageMin: number | null; ageMax: number | null; ageBand: CharacterAgeBand; gender: string;
  visualDesign: CharacterVisualDesign; describe: string; version: number; status: "active" | "archived";
  provenance: CharacterCardProvenance; sourceProjectId: number | null; sourceAssetId: number | null;
  imagePath: string | null; imageId: number | null; imageState: "missing" | "ready" | "stale";
  imageNeedsRegeneration: boolean; imageErrorReason: string | null;
  createdAt: number; updatedAt: number;
}
export interface CharacterCardImageAttempt {
  id: number; cardId: number; baseVersion: number; resultVersion: number | null; ownerId: number;
  state: "running" | "completed" | "failed"; prompt: string; model: string; resolution: string;
  filePath: string | null; sourceImageId: number | null; errorReason: string | null;
  createdAt: number; updatedAt: number; finishedAt: number | null;
}
export interface CharacterCardQuery {
  artStyle?: string; roleDefinition?: string; keyword?: string; ageMin?: number | null; ageMax?: number | null;
  ageBand?: CharacterAgeBand; gender?: string; ownerId?: number; limit?: number; includeArchived?: boolean;
}
const ageRanges: Record<Exclude<CharacterAgeBand, "unknown">, [number, number]> = {
  child: [0, 11], teen: [12, 17], adult: [18, 120], middle: [40, 59], elderly: [60, 120],
};

function safeJson(value: unknown, fallback: any): any {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}
function asCard(row: any): CharacterCard {
  const { seedKey, generationKey, ...publicFields } = row;
  return { ...publicFields, visualDesign: safeJson(row.visualDesign, {}), provenance: safeJson(row.provenance, { method: "manual", references: [] }),
    imagePath: row.imagePath || null, imageId: row.imageId ?? null, imageState: row.imageState || "missing",
    imageNeedsRegeneration: !!row.imageNeedsRegeneration, imageErrorReason: row.imageErrorReason || null };
}
function requireOwner(ownerId?: number): number {
  if (!Number.isInteger(ownerId) || Number(ownerId) <= 0) throw new Error("请先登录后操作角色卡");
  return Number(ownerId);
}
export function characterCardOwner(req: { user?: any }): number { return requireOwner(req.user?.id); }
function canRead(query: Knex.QueryBuilder, ownerId?: number) {
  const owners = ownerId && Number.isInteger(ownerId) && ownerId > 0 ? [0, ownerId] : [0];
  return query.whereIn("ownerId", owners);
}
function normalizedGender(value?: string) {
  const gender = (value || "unknown").trim().toLowerCase();
  if (["female", "woman", "女", "女性", "女人"].includes(gender)) return "female";
  if (["male", "man", "男", "男性", "男人"].includes(gender)) return "male";
  return gender;
}
function hasExplicitAgeFeature(visualDesign: CharacterVisualDesign) {
  const ageFeature = /成年|成人|中年|老年|青少年|儿童|\badult\b|\bteen\b|\bchild\b/gi;
  const denial = /不(?:据此)?(?:推定|推断|证明|指定|擅自|使用|采用|套用|表现)|不是|并非|不应|不能|不得|\b(?:not|never|without)\b/i;
  return characterVisualFields.flatMap(field => String(visualDesign[field] || "").split(/[。；，.!;]/)).some(clause => {
    // Negation belongs to the corresponding age assertion. A later contrast or
    // positive assertion ("不是成年而是儿童") cannot hide another explicit age.
    for (const segment of clause.replace(/未成年(?:人)?/gu, "").split(/但是|然而|不过|而是|但|却|\b(?:but|however|rather|yet)\b/gi)) {
      let previousEnd = 0, deniedSequence = false;
      for (const feature of segment.matchAll(ageFeature)) {
        const prefix = segment.slice(previousEnd, feature.index);
        const coordinated = deniedSequence && /(?:或(?:者)?|和|及|与|以及|\b(?:and|or))\s*$/i.test(prefix)
          && !/采用|保留|使用|写成|属于|呈现|表现|设为|是|\b(?:use|retain|show|is)\b/i.test(prefix);
        deniedSequence = denial.test(prefix) || coordinated;
        if (!deniedSequence) return true;
        previousEnd = feature.index + feature[0].length;
      }
    }
    return false;
  });
}
export function validateCharacterCardInput(input: CharacterCardInput) {
  const card = characterCardInputSchema.parse(input);
  let ageMin = card.ageMin ?? null, ageMax = card.ageMax ?? null;
  if (card.ageBand === "unknown") {
    if (ageMin !== null || ageMax !== null) throw new Error("年龄未知时不能填写推定年龄，请选择有依据的年龄段");
    if (hasExplicitAgeFeature(card.visualDesign)) throw new Error("外观含明确年龄特征，请选择有依据的年龄段");
  } else {
    const bounds = ageRanges[card.ageBand];
    if ((ageMin !== null && ageMax !== null && ageMin > ageMax)
      || (ageMin !== null && (ageMin < bounds[0] || ageMin > bounds[1]))
      || (ageMax !== null && (ageMax < bounds[0] || ageMax > bounds[1]))) throw new Error("角色卡年龄范围与年龄段不一致");
  }
  if (!card.visualDesign.face || !card.visualDesign.body || !card.visualDesign.hair || !card.visualDesign.clothing) {
    throw new Error("角色卡需要完整的面部、体态、发型和衣装设计");
  }
  return { ...card, ageMin, ageMax, gender: normalizedGender(card.gender),
    describe: card.describe || characterVisualFields.map(field => card.visualDesign[field]).filter(Boolean).join("；") };
}
function normalizeProvenance(value: any, method: CharacterCardProvenance["method"]): CharacterCardProvenance {
  const references: CharacterCardReference[] = [];
  for (const ref of Array.isArray(value?.references) ? value.references.slice(0, 3) : []) {
    if (!Number.isInteger(ref.cardId) || ref.cardId <= 0 || !Number.isInteger(ref.version) || ref.version <= 0) throw new Error("参考角色卡编号或版本无效");
    const borrowedFields = [...new Set<CharacterVisualField>((Array.isArray(ref.borrowedFields) ? ref.borrowedFields : [])
      .filter((field: any): field is CharacterVisualField => characterVisualFields.includes(field)))];
    if (!borrowedFields.length) throw new Error("请注明参考角色卡借鉴的外观字段");
    references.push({ cardId: ref.cardId, version: ref.version, borrowedFields });
  }
  // Source quotations, user constraints and story relationships must remain in project metadata.
  return { method, references };
}

/** Additive migration: immutable snapshots keep adopted project cards independent of library edits. */
export async function migrateCharacterCards(db: Knex) {
  if (!(await db.schema.hasTable("o_characterCard"))) await db.schema.createTable("o_characterCard", table => {
    table.increments("id"); table.integer("ownerId").notNullable(); table.string("seedKey"); table.string("generationKey");
    for (const field of ["name", "artStyle", "roleDefinition", "ageBand", "gender", "visualDesign", "describe", "status", "provenance"]) table.text(field).notNullable();
    table.integer("ageMin"); table.integer("ageMax"); table.integer("version").notNullable().defaultTo(1);
    table.integer("sourceProjectId"); table.integer("sourceAssetId"); table.bigInteger("createdAt"); table.bigInteger("updatedAt");
    table.unique(["ownerId", "seedKey"]); table.unique(["ownerId", "generationKey"]); table.index(["ownerId", "status", "artStyle", "ageBand"]);
  });
  if (!(await db.schema.hasTable("o_characterCardVersion"))) await db.schema.createTable("o_characterCardVersion", table => {
    table.integer("cardId").notNullable(); table.integer("version").notNullable(); table.text("snapshot").notNullable(); table.bigInteger("createdAt");
    table.primary(["cardId", "version"]);
  });
  for (const field of ["imagePath", "imageId", "imageState", "imageNeedsRegeneration", "imageErrorReason"]) {
    if (await db.schema.hasColumn("o_characterCard", field)) continue;
    await db.schema.alterTable("o_characterCard", table => {
      if (field === "imageId") table.integer(field);
      else if (field === "imageNeedsRegeneration") table.integer(field).notNullable().defaultTo(0);
      else if (field === "imageState") table.text(field).notNullable().defaultTo("missing");
      else table.text(field);
    });
  }
  if (!(await db.schema.hasTable("o_characterCardImage"))) await db.schema.createTable("o_characterCardImage", table => {
    table.increments("id"); table.integer("cardId").notNullable(); table.integer("baseVersion").notNullable(); table.integer("resultVersion");
    table.integer("ownerId").notNullable(); table.text("state").notNullable(); table.text("prompt").notNullable();
    table.text("model").notNullable(); table.text("resolution").notNullable(); table.text("filePath"); table.integer("sourceImageId"); table.text("errorReason");
    table.bigInteger("createdAt").notNullable(); table.bigInteger("updatedAt").notNullable(); table.bigInteger("finishedAt");
    table.index(["cardId", "id"]);
  });
  // A partial unique index also guards duplicate paid work across server processes.
  await db.raw("CREATE UNIQUE INDEX IF NOT EXISTS character_card_image_running ON o_characterCardImage(cardId,baseVersion) WHERE state='running'");
  await recoverCharacterCardImages(db);
  for (const [index, input] of seedCards.entries()) {
    const seedKey = `realistic_3d_anime:v1:${index + 1}`;
    if (await db("o_characterCard").where({ ownerId: 0, seedKey }).first()) continue;
    await insertCard(db, input, { ownerId: 0, seedKey, method: "seed" });
  }
}
async function insertCard(db: Knex, input: CharacterCardInput, options: {
  ownerId: number; seedKey?: string; generationKey?: string; skipSnapshot?: boolean; method: CharacterCardProvenance["method"]; provenance?: any; sourceProjectId?: number | null; sourceAssetId?: number | null;
}): Promise<CharacterCard> {
  const card = validateCharacterCardInput(input), now = Date.now();
  const provenance = normalizeProvenance(options.provenance, options.method);
  for (const ref of provenance.references) {
    if (!(await getCharacterCard(db, ref.cardId, options.ownerId, ref.version))) throw new Error("参考角色卡不存在或无权访问");
  }
  const [id] = await db("o_characterCard").insert({
    ownerId: options.ownerId, seedKey: options.seedKey || null, generationKey: options.generationKey || null, name: card.name, artStyle: card.artStyle, roleDefinition: card.roleDefinition,
    ageMin: card.ageMin, ageMax: card.ageMax, ageBand: card.ageBand, gender: card.gender,
    visualDesign: JSON.stringify(card.visualDesign), describe: card.describe, status: "active", version: 1,
    imagePath: null, imageId: null, imageState: "missing", imageNeedsRegeneration: 0, imageErrorReason: null,
    provenance: JSON.stringify(provenance), sourceProjectId: options.sourceProjectId || null, sourceAssetId: options.sourceAssetId || null, createdAt: now, updatedAt: now,
  });
  const result = asCard(await db("o_characterCard").where({ id }).first());
  if (!options.skipSnapshot) await db("o_characterCardVersion").insert({ cardId: id, version: 1, snapshot: JSON.stringify(result), createdAt: now });
  return result;
}
export async function getCharacterCard(db: Knex, id: number, ownerId?: number, version?: number): Promise<CharacterCard | null> {
  const row = await canRead(db("o_characterCard").where({ id }), ownerId).first();
  if (!row) return null;
  if (version !== undefined) {
    const historical = await db("o_characterCardVersion").where({ cardId: id, version }).first();
    const snapshot = historical ? safeJson(historical.snapshot, null) : null;
    return snapshot ? asCard(snapshot) : null;
  }
  return asCard(row);
}
export async function listCharacterCards(db: Knex, query: CharacterCardQuery = {}): Promise<CharacterCard[]> {
  const qb = canRead(db("o_characterCard"), query.ownerId);
  if (!query.includeArchived) qb.where("status", "active");
  if (query.artStyle) qb.where("artStyle", query.artStyle);
  if (query.ageBand) qb.where("ageBand", query.ageBand);
  const hasAge = query.ageMin != null || query.ageMax != null;
  const min = hasAge ? query.ageMin ?? 0 : undefined, max = hasAge ? query.ageMax ?? 120 : undefined;
  if (min !== undefined && min !== null && max !== undefined && max !== null) {
    if (min > max || min < 0 || max > 120) throw new Error("年龄筛选范围无效");
  }
  if (query.gender && normalizedGender(query.gender) !== "unknown") qb.where("gender", normalizedGender(query.gender));
  const keyword = (query.keyword || "").trim().toLowerCase();
  const definition = (query.roleDefinition || "").trim().toLowerCase();
  const visible: CharacterCard[] = (await qb.orderBy("id", "desc")).map(asCard);
  const rows = visible.filter(card => {
    if (min != null && max != null) {
      const range = card.ageBand === "unknown" ? null : ageRanges[card.ageBand];
      if (!range || (card.ageMax ?? range[1]) < min || (card.ageMin ?? range[0]) > max) return false;
    }
    const searchable = `${card.name} ${card.roleDefinition} ${card.describe} ${characterVisualFields.map(field => card.visualDesign[field] || "").join(" ")}`.toLowerCase();
    return (!keyword || searchable.includes(keyword))
      && (!definition || card.roleDefinition.toLowerCase().includes(definition));
  });
  return query.limit === Infinity ? rows : rows.slice(0, Math.min(Math.max(query.limit || 200, 1), 500));
}
function definitionTokens(value: string) {
  const text = value.toLowerCase();
  const words = text.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) || [];
  return new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 1
    ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)) : [word]));
}
export function characterCardSummary(card: CharacterCard) {
  return { id: card.id, version: card.version, name: card.name, artStyle: card.artStyle, roleDefinition: card.roleDefinition.slice(0, 160),
    ageMin: card.ageMin, ageMax: card.ageMax, ageBand: card.ageBand, gender: card.gender,
    face: card.visualDesign.face.slice(0, 100), hair: card.visualDesign.hair.slice(0, 80), clothing: card.visualDesign.clothing.slice(0, 140) };
}
/** Hard compatibility first; role-definition similarity ranks the remaining partial references. */
export async function searchCharacterCards(db: Knex, query: CharacterCardQuery): Promise<(CharacterCard & { score: number; matchKind: "full" | "reference" })[]> {
  if (!query.artStyle?.trim()) throw new Error("查找角色卡需要明确画风");
  const hasAge = query.ageMin != null || query.ageMax != null;
  const ageBand = query.ageBand || (hasAge ? undefined : "unknown");
  const gender = normalizedGender(query.gender);
  const candidates = (await listCharacterCards(db, { ...query, ageBand, gender: undefined, keyword: undefined,
    roleDefinition: undefined, includeArchived: false, limit: Infinity }))
    .filter(card => gender === "unknown" || card.gender === gender || card.gender === "unknown");
  const tokens = definitionTokens(query.roleDefinition || "");
  const scored = candidates.map(card => {
    const cardTokens = definitionTokens(card.roleDefinition);
    const matched = [...tokens].filter(token => cardTokens.has(token)).length;
    const score = tokens.size ? matched / tokens.size : 0;
    return { ...card, score, matchKind: (score >= 0.8 && tokens.size ? "full" : "reference") as "full" | "reference" };
  });
  return scored.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, Math.min(Math.max(query.limit || 3, 1), 3));
}
export async function saveCharacterCard(db: Knex, input: CharacterCardInput, ownerId: number): Promise<CharacterCard> {
  requireOwner(ownerId);
  const normalized = validateCharacterCardInput(input);
  return db.transaction(async tx => {
    if (!normalized.id) return insertCard(tx, normalized, { ownerId, method: "manual" });
    const old = await tx("o_characterCard").where({ id: normalized.id, ownerId }).first();
    if (!old) throw new Error("角色卡不存在、属于其他用户或是只读预置卡");
    if (normalized.version === undefined || normalized.version !== old.version) throw new Error("角色卡已更新，请刷新后再保存");
    const result: CharacterCard = { ...asCard(old), ...normalized, id: old.id, ownerId, version: old.version + 1, updatedAt: Date.now(),
      imageState: old.imagePath ? "stale" : "missing", imageNeedsRegeneration: !!old.imagePath, imageErrorReason: null };
    delete (result as any).seedKey; delete (result as any).generationKey;
    const { id, ownerId: _, createdAt, ...values } = result;
    const changed = await tx("o_characterCard").where({ id, ownerId, version: old.version }).update({ ...values,
      visualDesign: JSON.stringify(result.visualDesign), provenance: JSON.stringify(result.provenance), imageNeedsRegeneration: result.imageNeedsRegeneration ? 1 : 0 });
    if (!changed) throw new Error("角色卡已更新，请刷新后再保存");
    await tx("o_characterCardVersion").insert({ cardId: id, version: result.version, snapshot: JSON.stringify(result), createdAt: result.updatedAt });
    return result;
  });
}
export async function saveGeneratedCharacterCard(db: Knex, input: CharacterCardInput & {
  ownerId?: number; sourceProjectId?: number | null; sourceAssetId?: number | null; provenance?: any;
}): Promise<CharacterCard> {
  const ownerId = requireOwner(input.ownerId);
  const card = validateCharacterCardInput({ ...input, describe: "" });
  const generationKey = input.sourceAssetId ? createHash("sha256").update(JSON.stringify({
    projectId: input.sourceProjectId || null, assetId: input.sourceAssetId, name: card.name, artStyle: card.artStyle,
    roleDefinition: card.roleDefinition, ageBand: card.ageBand, ageMin: card.ageMin, ageMax: card.ageMax,
    gender: card.gender, visualDesign: card.visualDesign,
  })).digest("hex") : undefined;
  const save = async (tx: Knex) => {
    if (generationKey) {
      const old = await tx("o_characterCard").where({ ownerId, generationKey }).first();
      if (old) return (await getCharacterCard(tx, old.id, ownerId, 1))!;
    }
    return insertCard(tx, card, { ownerId, generationKey, method: "generated", provenance: input.provenance,
      sourceProjectId: input.sourceProjectId, sourceAssetId: input.sourceAssetId });
  };
  return (db as any).isTransaction ? save(db) : db.transaction(save);
}
export async function archiveCharacterCard(db: Knex, id: number, ownerId: number, expectedVersion?: number): Promise<CharacterCard> {
  requireOwner(ownerId);
  return db.transaction(async tx => {
    const row = await tx("o_characterCard").where({ id, ownerId }).first();
    if (!row) throw new Error("角色卡不存在、属于其他用户或是只读预置卡");
    if (expectedVersion !== undefined && expectedVersion !== row.version) throw new Error("角色卡已更新，请刷新后再归档");
    if (row.status === "archived") return asCard(row);
    const result: CharacterCard = { ...asCard(row), status: "archived", version: row.version + 1, updatedAt: Date.now() };
    await tx("o_characterCard").where({ id, ownerId, version: row.version }).update({ status: result.status, version: result.version, updatedAt: result.updatedAt });
    await tx("o_characterCardVersion").insert({ cardId: id, version: result.version, snapshot: JSON.stringify(result), createdAt: result.updatedAt });
    return result;
  });
}

function cardImageTransaction<T>(db: Knex, fn: (tx: Knex) => Promise<T>): Promise<T> {
  return (db as any).isTransaction ? fn(db) : db.transaction(fn);
}

/** Startup recovery never silently resumes a paid provider call. */
export async function recoverCharacterCardImages(db: Knex): Promise<number> {
  if (!(await db.schema.hasTable("o_characterCardImage"))) return 0;
  return db("o_characterCardImage").where({ state: "running" }).update({ state: "failed",
    errorReason: "服务已重新启动，请手动重试角色卡图片", updatedAt: Date.now(), finishedAt: Date.now() });
}

export async function listCharacterCardImages(db: Knex, cardId: number, ownerId: number): Promise<CharacterCardImageAttempt[]> {
  requireOwner(ownerId);
  if (!(await getCharacterCard(db, cardId, ownerId))) throw new Error("角色卡不存在或无权访问");
  return db("o_characterCardImage").where({ cardId }).orderBy("id", "desc");
}
export async function getLatestCharacterCardImage(db: Knex, cardId: number, ownerId: number): Promise<CharacterCardImageAttempt | null> {
  return (await listCharacterCardImages(db, cardId, ownerId))[0] || null;
}

export async function beginCharacterCardImage(db: Knex, input: {
  cardId: number; baseVersion: number; ownerId: number; prompt: string; model: string; resolution: string;
}): Promise<CharacterCardImageAttempt & { duplicate: boolean }> {
  requireOwner(input.ownerId);
  const { cardId, baseVersion, prompt, model, resolution } = z.object({
    cardId: z.number().int().positive(), baseVersion: z.number().int().positive(), prompt: z.string().trim().min(1),
    model: z.string().trim().min(1), resolution: z.string().trim().min(1),
  }).parse(input);
  return cardImageTransaction(db, async tx => {
    const card = await getCharacterCard(tx, cardId, input.ownerId);
    if (!card || card.status !== "active") throw new Error("角色卡不存在、已归档或无权访问");
    if (card.version !== baseVersion) throw new Error("角色卡已更新，请刷新后再生成图片");
    const running = await tx("o_characterCardImage").where({ cardId, baseVersion, state: "running" }).first();
    if (running) return { ...running, duplicate: true };
    const now = Date.now();
    try {
      const [id] = await tx("o_characterCardImage").insert({ cardId, baseVersion, ownerId: input.ownerId, state: "running", prompt, model, resolution,
        resultVersion: null, filePath: null, sourceImageId: null, errorReason: null, createdAt: now, updatedAt: now, finishedAt: null });
      return { ...(await tx("o_characterCardImage").where({ id }).first()), duplicate: false };
    } catch (cause) {
      // SQLite's partial unique index is the final guard when two processes race.
      const duplicate = await tx("o_characterCardImage").where({ cardId, baseVersion, state: "running" }).first();
      if (duplicate) return { ...duplicate, duplicate: true };
      throw cause;
    }
  });
}

/** A successful late response is retained as history, but cannot replace a changed card. */
export async function completeCharacterCardImage(db: Knex, input: {
  attemptId: number; ownerId: number; filePath: string;
}): Promise<{ attempt: CharacterCardImageAttempt; card: CharacterCard; adopted: boolean }> {
  requireOwner(input.ownerId);
  if (!input.filePath?.trim()) throw new Error("角色卡图片文件不能为空");
  return cardImageTransaction(db, async tx => {
    const attempt: CharacterCardImageAttempt | undefined = await tx("o_characterCardImage").where({ id: input.attemptId, ownerId: input.ownerId }).first();
    if (!attempt) throw new Error("图片生成记录不存在或无权访问");
    const card = await getCharacterCard(tx, attempt.cardId, input.ownerId);
    if (!card) throw new Error("角色卡不存在或无权访问");
    if (attempt.state === "completed") return { attempt, card, adopted: attempt.resultVersion !== null };
    if (attempt.state !== "running") throw new Error("该图片生成已经结束，不能覆盖失败记录");
    const now = Date.now();
    let adopted = card.version === attempt.baseVersion && card.status === "active";
    let result = card;
    if (adopted) {
      const next: CharacterCard = { ...card, version: card.version + 1, imagePath: input.filePath.trim(), imageId: attempt.id,
        imageState: "ready", imageNeedsRegeneration: false, imageErrorReason: null, updatedAt: now };
      const changed = await tx("o_characterCard").where({ id: card.id, ownerId: card.ownerId, version: card.version, status: "active" })
        .update({ version: next.version, imagePath: next.imagePath, imageId: next.imageId, imageState: next.imageState,
          imageNeedsRegeneration: 0, imageErrorReason: null, updatedAt: now });
      adopted = !!changed;
      if (adopted) {
        await tx("o_characterCardVersion").insert({ cardId: card.id, version: next.version, snapshot: JSON.stringify(next), createdAt: now });
        result = next;
      } else result = (await getCharacterCard(tx, card.id, input.ownerId))!;
    }
    await tx("o_characterCardImage").where({ id: attempt.id, ownerId: input.ownerId, state: "running" }).update({
      state: "completed", filePath: input.filePath.trim(), resultVersion: adopted ? result.version : null,
      errorReason: null, updatedAt: now, finishedAt: now,
    });
    return { attempt: await tx("o_characterCardImage").where({ id: attempt.id }).first(), card: result, adopted };
  });
}

export async function failCharacterCardImage(db: Knex, input: {
  attemptId: number; ownerId: number; errorReason: string;
}): Promise<{ attempt: CharacterCardImageAttempt; card: CharacterCard }> {
  requireOwner(input.ownerId);
  return cardImageTransaction(db, async tx => {
    const attempt: CharacterCardImageAttempt | undefined = await tx("o_characterCardImage").where({ id: input.attemptId, ownerId: input.ownerId }).first();
    if (!attempt) throw new Error("图片生成记录不存在或无权访问");
    const card = await getCharacterCard(tx, attempt.cardId, input.ownerId);
    if (!card) throw new Error("角色卡不存在或无权访问");
    if (attempt.state === "running") await tx("o_characterCardImage").where({ id: attempt.id, state: "running" }).update({
      state: "failed", errorReason: String(input.errorReason || "角色卡图片生成失败").slice(0, 1200), updatedAt: Date.now(), finishedAt: Date.now(),
    });
    return { attempt: await tx("o_characterCardImage").where({ id: attempt.id }).first(), card };
  });
}
export async function characterCardFromAsset(db: Knex, input: {
  assetId: number; projectId?: number; name?: string; roleDefinition?: string; ageBand?: CharacterAgeBand;
  ageMin?: number | null; ageMax?: number | null; gender?: string;
}, ownerId: number): Promise<CharacterCard> {
  requireOwner(ownerId);
  const asset = await db("o_assets").where({ id: input.assetId, type: "role" }).first();
  if (!asset || (input.projectId !== undefined && input.projectId !== asset.projectId)) throw new Error("人物资产不存在");
  const project = await db("o_project").where({ id: asset.projectId, userId: ownerId }).first();
  if (!project) throw new Error("无权读取该项目人物资产");
  const meta = safeJson(asset.descriptionMeta, {});
  const visualDesign = meta.visualDesign;
  if (!visualDesign) throw new Error("该人物还没有完整外观设计，请先生成角色卡");
  // Copy only visible design. Story quotes, user constraints and the old description stay in the project.
  const profile = meta.characterCard || {};
  const ageBand = input.ageBand || (characterAgeBands.includes(profile.ageBand) ? profile.ageBand : "unknown");
  if (ageBand === "unknown" && hasExplicitAgeFeature(visualDesign)) {
    throw new Error("该外观包含明确年龄特征，请先选择有依据的年龄段再加入角色卡库");
  }
  const card: CharacterCardInput = { name: input.name || `${asset.name}·外观参考`, artStyle: project.artStyle,
    roleDefinition: input.roleDefinition || profile.roleDefinition || "人物外观参考", ageBand,
    ageMin: input.ageMin !== undefined ? input.ageMin : profile.ageMin, ageMax: input.ageMax !== undefined ? input.ageMax : profile.ageMax,
    gender: input.gender || profile.gender || "unknown", visualDesign, describe: "" };
  return cardImageTransaction(db, async tx => {
    const live = await tx("o_assets").where({ id: asset.id, projectId: asset.projectId }).first();
    if (!live || live.descriptionMeta !== asset.descriptionMeta || live.imageId !== asset.imageId || live.describe !== asset.describe)
      throw new Error("人物资产已更新，请刷新后再加入角色卡库");
    let image: any;
    if (asset.imageId != null && await tx.schema.hasTable("o_image")) {
      image = await tx("o_image").where({ id: asset.imageId }).first();
      if (!image || image.state !== "已完成" || !image.filePath || (image.assetsId != null && Number(image.assetsId) !== Number(asset.id)))
        throw new Error("人物当前选图尚未完成或不属于该人物，请先确认完整参考图");
    }
    const result = await insertCard(tx, card, { ownerId, method: "from_asset", sourceProjectId: asset.projectId, sourceAssetId: asset.id, skipSnapshot: !!image });
    if (!image) return result;
    const now = Date.now();
    const [imageId] = await tx("o_characterCardImage").insert({ cardId: result.id, baseVersion: 1, resultVersion: 1, ownerId,
      state: "completed", prompt: String(image.prompt || ""), model: String(image.model || "imported"), resolution: String(image.resolution || "source"),
      filePath: image.filePath, sourceImageId: image.id, errorReason: null, createdAt: now, updatedAt: now, finishedAt: now });
    const sourceVersion = Number(asset.imageDescriptionVersion ?? image.descriptionVersion ?? asset.descriptionVersion ?? 0);
    const imageNeedsRegeneration = sourceVersion !== Number(asset.descriptionVersion || 0);
    const withImage: CharacterCard = { ...result, imageId, imagePath: image.filePath, imageState: imageNeedsRegeneration ? "stale" : "ready", imageNeedsRegeneration };
    await tx("o_characterCard").where({ id: result.id, ownerId }).update({ imageId, imagePath: image.filePath,
      imageState: withImage.imageState, imageNeedsRegeneration: imageNeedsRegeneration ? 1 : 0 });
    await tx("o_characterCardVersion").insert({ cardId: result.id, version: 1, snapshot: JSON.stringify(withImage), createdAt: now });
    return withImage;
  });
}

const visual = (face: string, body: string, hair: string, clothing: string): CharacterVisualDesign => ({ face, body, hair, clothing, environment: "", shape: "" });
const seedCards: CharacterCardInput[] = [
  { name: "灵动儿童", roleDefinition: "儿童，活泼好奇，日常生活人物", ageBand: "child", gender: "unknown",
    visualDesign: visual("圆润脸型、自然大眼与柔和眉线，清楚保留儿童比例。", "儿童自然体态，肩窄四肢匀称。", "蓬松齐耳短发，发梢自然。", "浅黄色圆领棉质上衣、蓝灰宽松长裤、白色软底运动鞋，衣装方便活动。") },
  { name: "清爽少年", roleDefinition: "少年，学生，清爽安静", ageBand: "teen", gender: "male",
    visualDesign: visual("清爽椭圆脸、平直眉与自然鼻梁，保留少年面部比例。", "少年自然体态与适度肩线。", "深棕短发，额前碎发形成轻微弧线。", "浅蓝衬衫搭米白针织背心、深灰直筒长裤、白色帆布鞋，面料轻柔。") },
  { name: "率真少女", roleDefinition: "少女，学生，率真活泼", ageBand: "teen", gender: "female",
    visualDesign: visual("柔和椭圆脸、清晰杏眼与自然淡眉，保留少女年龄特征。", "少女自然体态，姿态轻快。", "栗棕色齐肩发，侧边简单发夹。", "奶油白棉质卫衣、浅蓝直筒牛仔裤、浅灰运动鞋，搭配整洁轻便。") },
  { name: "都市女主", roleDefinition: "成年青年女性，都市女主，时髦独立，日常职场", ageBand: "adult", gender: "female",
    visualDesign: visual("流畅小鹅蛋脸、清晰杏眼、微挑眉尾与精致鼻尖，五官比例协调，柔雾玫瑰豆沙妆。", "成年自然比例，肩线清楚，姿态从容。", "墨黑长发低马尾，脸周保留弧形发束与自然颅顶蓬松度。", "象牙白翻领衬衫、黑色短款收腰外套、奶油白中长A字裙、黑色低跟踝靴，柔缎与挺括面料形成对比，配小型银色耳饰。") },
  { name: "利落行动者", roleDefinition: "成年青年女性，行动者，冷静坚毅，现代便装", ageBand: "adult", gender: "female",
    visualDesign: visual("偏窄椭圆脸、平直眉与清晰眼尾，神情沉稳。", "成年自然体态，肩背挺直，衣装留有活动松量。", "深棕色及肩发，利落低束发与少量脸周碎发。", "青灰轻薄短夹克、米白圆领上衣、深灰直筒工装裤、黑色平底踝靴，剪裁利落且不过度堆叠配件。") },
  { name: "沉稳青年", roleDefinition: "成年青年男性，可靠伙伴，沉稳理性，现代都市", ageBand: "adult", gender: "male",
    visualDesign: visual("略方脸型、清楚眉骨与平直鼻梁，五官比例自然。", "成年自然比例，肩线舒展。", "黑色短发侧分，顶部微蓬松。", "深蓝轻薄外套、灰白棉质内搭、炭灰直筒长裤、深棕皮质短靴，哑光面料与皮革形成细微对比。") },
  { name: "干练中年女性", roleDefinition: "中年女性，管理者，干练从容，现代职场", ageBand: "middle", gender: "female",
    visualDesign: visual("长椭圆脸型、清楚眉眼与自然轻微纹理，保留中年面部特征。", "中年自然体态，肩背稳定舒展。", "深棕及肩短发，发尾内收。", "深青合体西装、米白圆领内搭、炭灰直筒长裤、深棕低跟鞋，衣装剪裁端正，配小型哑金耳饰。") },
  { name: "温厚中年男性", roleDefinition: "中年男性，普通居民，温厚务实，日常生活", ageBand: "middle", gender: "male",
    visualDesign: visual("宽椭圆脸、柔和眼型与自然鼻翼，保留轻微法令纹。", "中年自然体态，躯干比例真实。", "深灰黑短发，鬓角少量灰白。", "暖棕针织开衫、浅米色棉质衬衫、深蓝直筒长裤、深灰平底鞋，衣装整洁朴素且材质清楚。") },
  { name: "清雅长者", roleDefinition: "老年女性，长者，温和坚定，日常生活", ageBand: "elderly", gender: "female",
    visualDesign: visual("柔和长椭圆脸，自然眼周与额部纹理，眼神清澈。", "老年自然体态，姿态稳定。", "银灰短发，轻微波纹与自然蓬松度。", "淡灰蓝开衫、米白内搭、深灰宽松长裤、棕色软底平底鞋，针织面料温和。") },
  { name: "年龄未定外观参考", roleDefinition: "年龄未明人物，中性外观，现代日常，年龄留待剧本或用户确认", ageBand: "unknown", gender: "unknown",
    visualDesign: visual("自然椭圆脸，眉眼比例协调；面部年龄特征由当前人物依据确定。", "自然比例；不据此推定成年身份或精确年龄。", "深棕色整洁短发，发束轮廓清楚。", "灰蓝圆领上衣、深灰直筒长裤与白色平底鞋，剪裁和尺寸按当前人物明确体态调整。") },
].map(card => ({ ...card, ageBand: card.ageBand as CharacterAgeBand, artStyle: "realistic_3d_anime", describe: "",
  ...(["都市女主", "利落行动者", "沉稳青年"].includes(card.name) ? { ageMin: 18, ageMax: 39 } : {}) }));
