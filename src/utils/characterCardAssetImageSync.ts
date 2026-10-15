import type { Knex } from "knex";
import { descriptionMeta, descriptionVersion } from "./assetDescriptionVersion";
import { beginCharacterCardImage, completeCharacterCardImage, characterVisualFields, getCharacterCard } from "./characterCards";

export interface CharacterCardAssetImageSyncResult {
  synced: boolean;
  reason?: "unbound" | "unavailable" | "asset_changed" | "image_unavailable" | "image_stale" | "card_changed" | "design_changed" | "image_running" | "image_ready";
  cardId?: number; version?: number; imageId?: number; duplicate?: boolean;
}

/**
 * Import the already adopted project picture, without calling a provider. `asset` must be the
 * snapshot read before rendering/upload/adoption began. A changed binding or description can
 * never receive the old render. New image versions preserve every paid image and old snapshot.
 */
export async function syncCharacterCardAssetImage(db: Knex, input: {
  asset: any; imageId: number | null | undefined;
}): Promise<CharacterCardAssetImageSyncResult> {
  const snapshot = input.asset, snapshotMeta = descriptionMeta(snapshot || {}), binding = snapshotMeta.characterCard;
  if (snapshot?.type !== "role" || !Number.isSafeInteger(binding?.cardId) || binding.cardId <= 0
    || !Number.isSafeInteger(binding?.version) || binding.version <= 0 || !Number.isSafeInteger(input.imageId) || Number(input.imageId) <= 0)
    return { synced: false, reason: "unbound" };
  if (!(await db.schema.hasTable("o_characterCard")) || !(await db.schema.hasTable("o_characterCardImage")))
    return { synced: false, reason: "unavailable" };

  // Always open a transaction/savepoint. An optional library-sync failure must not partially
  // write media or roll back a successfully saved paid project picture in the caller transaction.
  return db.transaction(async trx => {
    const live = await trx("o_assets").where({ id: snapshot.id, projectId: snapshot.projectId, type: "role" }).first();
    const meta = descriptionMeta(live || {}), liveBinding = meta.characterCard;
    if (!live || Number(live.imageId) !== Number(input.imageId) || descriptionVersion(live) !== descriptionVersion(snapshot)
      || liveBinding?.cardId !== binding.cardId || liveBinding?.version !== binding.version)
      return { synced: false, reason: "asset_changed" };
    const image = await trx("o_image").where({ id: input.imageId, assetsId: snapshot.id, type: "role", state: "已完成" }).first();
    if (!image?.filePath?.trim()) return { synced: false, reason: "image_unavailable" };
    if (Number(image.descriptionVersion || 0) !== descriptionVersion(snapshot)
      || Number(live.imageDescriptionVersion || 0) !== descriptionVersion(snapshot))
      return { synced: false, reason: "image_stale" };
    const project = await trx("o_project").where({ id: snapshot.projectId }).first("userId");
    const ownerId = Number(project?.userId);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return { synced: false, reason: "unavailable" };
    const card = await getCharacterCard(trx, binding.cardId, ownerId);
    if (!card || card.status !== "active" || card.version !== binding.version)
      return { synced: false, reason: "card_changed" };
    const identical = (visual: any) => !!visual && characterVisualFields.every(field => typeof visual[field] === "string"
      && visual[field] === card.visualDesign[field]);
    if (!identical(snapshotMeta.visualDesign) || !identical(meta.visualDesign)) return { synced: false, reason: "design_changed" };

    const previous = await trx("o_characterCardImage").where({ cardId: card.id, sourceImageId: input.imageId, state: "completed" }).first();
    if (previous) return { synced: true, duplicate: true, cardId: card.id,
      version: previous.resultVersion ?? card.version, imageId: previous.id };
    // A project render fills a missing card picture. Keep the card's already approved picture;
    // users may still retain/adopt a different project picture without changing library identity.
    if (card.imageState === "ready" && card.imagePath?.trim()) return { synced: false, reason: "image_ready" };
    const attempt = await beginCharacterCardImage(trx, { cardId: card.id, baseVersion: card.version, ownerId,
      prompt: String(snapshot.prompt || card.describe || "项目已采用人物图片"), model: String(image.model || "project-image"),
      resolution: String(image.resolution || "source") });
    // A real in-flight card render belongs to its worker. Do not complete it with another image.
    if (attempt.duplicate) return { synced: false, reason: "image_running" };
    await trx("o_characterCardImage").where({ id: attempt.id }).update({ sourceImageId: image.id });
    const completed = await completeCharacterCardImage(trx, { attemptId: attempt.id, ownerId, filePath: image.filePath });
    if (!completed.adopted) throw new Error("角色卡在图片同步期间发生变化，项目图片已保留");
    const nextMeta = { ...meta, characterCard: { ...liveBinding, version: completed.card.version,
      imageId: completed.attempt.id, sourceImageId: image.id } };
    const changed = await trx("o_assets").where({ id: snapshot.id, projectId: snapshot.projectId, type: "role",
      imageId: input.imageId, descriptionMeta: live.descriptionMeta }).update({ descriptionMeta: JSON.stringify(nextMeta) });
    if (!changed) throw new Error("项目角色在图片同步期间发生变化，项目图片已保留");
    return { synced: true, cardId: card.id, version: completed.card.version, imageId: completed.attempt.id };
  });
}

/** Library synchronization is secondary to preserving a successfully generated project image. */
export async function syncCharacterCardAssetImageSafely(db: Knex, input: Parameters<typeof syncCharacterCardAssetImage>[1]): Promise<void> {
  try { await syncCharacterCardAssetImage(db, input); }
  catch (cause) {
    console.warn("项目图片已保存，角色卡图片同步失败：", cause instanceof Error ? cause.message : String(cause));
  }
}
