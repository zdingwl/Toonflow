import type { Knex } from "knex";
import { listCharacterCardImages, type CharacterCard } from "./characterCards";

export interface CharacterCardImageUrls {
  getSmallImageUrl(path: string): string | Promise<string>;
  getFileUrl(path: string): string | Promise<string>;
}
export type CharacterCardImagePhase = (attemptId: number) => "queued" | "running" | undefined | Promise<"queued" | "running" | undefined>;

/** Image URLs belong to the supplied immutable card; unrelated current jobs never change them. */
export async function hydrateCharacterCard(
  db: Knex, card: CharacterCard, ownerId: number, oss: CharacterCardImageUrls, phaseForAttempt?: CharacterCardImagePhase,
) {
  const attempts = await listCharacterCardImages(db, card.id, ownerId);
  const attempt = attempts.find(image => image.baseVersion === card.version || image.resultVersion === card.version);
  const [imageUrl, imageFullUrl] = card.imagePath
    ? await Promise.all([oss.getSmallImageUrl(card.imagePath), oss.getFileUrl(card.imagePath)]) : [null, null];
  const [candidateImageUrl, candidateFullUrl] = attempt?.state === "failed" && attempt.filePath
    ? await Promise.all([oss.getSmallImageUrl(attempt.filePath), oss.getFileUrl(attempt.filePath)]) : [null, null];
  const imageGeneration = attempt ? {
    id: attempt.id, state: attempt.state,
    phase: attempt.state === "running" ? (await phaseForAttempt?.(attempt.id)) || "running" : undefined,
    model: attempt.model, resolution: attempt.resolution, baseVersion: attempt.baseVersion, resultVersion: attempt.resultVersion,
    errorReason: attempt.errorReason,
    adopted: attempt.resultVersion === card.version && card.imageId === attempt.id,
    candidateImageUrl, candidateFullUrl,
    canReview: attempt.state === "failed" && !!attempt.filePath && attempt.ownerId === ownerId && attempt.baseVersion === card.version,
  } : null;
  return { ...card, imageUrl, imageFullUrl, candidateImageUrl, candidateFullUrl, imageGeneration,
    imageErrorReason: imageGeneration?.state === "failed" ? imageGeneration.errorReason : card.imageErrorReason };
}
