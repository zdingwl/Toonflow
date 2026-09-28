import type { Knex } from "knex";

/** Independent from designVersion, which versions adopted image references. */
export async function migrateAssetDescriptions(db: Knex) {
  if (!(await db.schema.hasTable("o_assets"))) return;
  for (const name of ["descriptionVersion", "promptDescriptionVersion", "imageDescriptionVersion"]) {
    if (!(await db.schema.hasColumn("o_assets", name))) await db.schema.alterTable("o_assets", t => { t.integer(name).notNullable().defaultTo(0); });
  }
  if (!(await db.schema.hasColumn("o_assets", "descriptionMeta"))) await db.schema.alterTable("o_assets", t => { t.text("descriptionMeta"); });
  if (await db.schema.hasTable("o_image") && !(await db.schema.hasColumn("o_image", "descriptionVersion"))) {
    await db.schema.alterTable("o_image", t => { t.integer("descriptionVersion").notNullable().defaultTo(0); });
  }
  if (!(await db.schema.hasTable("o_assetDescriptionHistory"))) await db.schema.createTable("o_assetDescriptionHistory", t => {
    t.increments("id"); t.integer("assetId").notNullable(); t.integer("projectId").notNullable();
    t.integer("version").notNullable(); t.text("describe"); t.text("meta"); t.bigInteger("createdAt");
    t.unique(["assetId", "version"]);
  });
}

export function descriptionMeta(asset: any): any {
  try { return JSON.parse(asset.descriptionMeta || "{}"); } catch { return {}; }
}
export const descriptionVersion = (asset: any): number => Number(asset.descriptionVersion || 0);
export const promptIsStale = (asset: any): boolean => descriptionVersion(asset) > Number(asset.promptDescriptionVersion || 0);
export const imageIsStale = (asset: any): boolean => !!asset.imageId && descriptionVersion(asset) > Number(asset.imageDescriptionVersion || 0);
export function requireCurrentAssetPrompt(asset: any, submittedPrompt?: string) {
  if (promptIsStale(asset)) throw new Error(`${asset.name}：描述已更新，请先重新生成提示词`);
  if (submittedPrompt !== undefined && descriptionVersion(asset) > 0 && typeof asset.prompt === "string" && submittedPrompt.trim() !== asset.prompt.trim()) {
    throw new Error(`${asset.name}：提示词与当前保存的版本不一致，请保存编辑或刷新后再生成图片`);
  }
}

/** Must be called in the same transaction as the caller's other asset changes. */
export async function saveDescription(db: any, asset: any, describe: string, meta: any) {
  const text = describe.trim();
  if (!text) throw new Error("资产描述不能为空");
  const oldVersion = descriptionVersion(asset);
  if (text === (asset.describe || "").trim()) {
    await db("o_assets").where({ id: asset.id, projectId: asset.projectId }).update({ descriptionMeta: JSON.stringify(meta) });
    return oldVersion;
  }
  await db("o_assetDescriptionHistory").insert({
    assetId: asset.id, projectId: asset.projectId, version: oldVersion,
    describe: asset.describe, meta: asset.descriptionMeta, createdAt: Date.now(),
  }).onConflict(["assetId", "version"]).ignore();
  const version = oldVersion + 1;
  await db("o_assets").where({ id: asset.id, projectId: asset.projectId }).update({
    describe: text, descriptionVersion: version, descriptionMeta: JSON.stringify(meta),
    promptState: "待更新", promptErrorReason: null,
  });
  return version;
}

/** A late prompt response must never bless a newer description. */
export async function saveGeneratedAssetPrompt(db: any, asset: any, prompt: string) {
  const where: any = { id: asset.id, projectId: asset.projectId, describe: asset.describe };
  // Legacy test callers without the migrated schema remain readable.
  if (asset.descriptionVersion !== undefined) where.descriptionVersion = descriptionVersion(asset);
  const values: any = { prompt, promptState: "已完成", promptErrorReason: null };
  if (asset.descriptionVersion !== undefined) values.promptDescriptionVersion = descriptionVersion(asset);
  const changed = await db("o_assets").where(where).update(values);
  if (!changed) throw new Error("资产描述已变化，请重新生成提示词");
}

export function changedDesignFields(before: any, after: any): string[] {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(key => JSON.stringify(before?.[key] ?? "") !== JSON.stringify(after?.[key] ?? ""));
}
