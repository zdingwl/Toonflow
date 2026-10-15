import type { Knex } from "knex";
import { beginCharacterCardImage, completeCharacterCardImage, failCharacterCardImage, getCharacterCard,
  type CharacterCard, type CharacterCardImageAttempt } from "./characterCards";

export interface CandidateReviewReport {
  sourceAttemptId: number; reviewAttemptId: number; cardId: number; ownerId: number; baseVersion: number;
  resultVersion: number | null; passed: boolean; adopted: boolean; filePath: string; model: string; resolution: string;
  errorReason?: string;
}
export function sanitizedReviewError(cause: unknown, secrets: string[] = []): string {
  let message = String((cause as any)?.message || cause || "图片复核失败");
  if (/\b(?:insert into|update|select|delete from)\b/i.test(message) && message.includes(" - ")) message = message.slice(message.lastIndexOf(" - ") + 3);
  for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]");
  message = message.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]");
  return message.slice(0, 1200);
}

/** Owns a separate review attempt; no provider, startup, or migration side effects. */
export async function reviewCharacterCardCandidate(deps: {
  db: Knex;
  review: (card: CharacterCard, candidate: CharacterCardImageAttempt) => Promise<void>;
  safeError?: (cause: unknown) => string;
  started?: (input: { attemptId: number; cardId: number }) => void | Promise<void>;
}, options: { attemptId: number; ownerId?: number }): Promise<CandidateReviewReport> {
  if (!Number.isSafeInteger(options.attemptId) || options.attemptId <= 0) throw new Error("请指定有效的失败图片记录 ID");
  const prepared = await deps.db.transaction(async tx => {
    const source: CharacterCardImageAttempt | undefined = await tx("o_characterCardImage").where({ id: options.attemptId }).first();
    if (!source || source.state !== "failed" || !source.filePath?.trim()) throw new Error("只允许复核保留了候选文件的失败记录");
    const ownerId = options.ownerId ?? source.ownerId;
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || ownerId !== source.ownerId) throw new Error("图片记录不存在或无权复核");
    const card = await getCharacterCard(tx, source.cardId, ownerId);
    if (!card || card.status !== "active" || card.version !== source.baseVersion) throw new Error("角色卡已经变更，原候选不能用于当前版本");
    const running = await tx("o_characterCardImage").where({ cardId: card.id, state: "running" }).first();
    if (running) throw new Error("该角色卡已有进行中的图片任务，请等待完成后复核");
    const attempt = await beginCharacterCardImage(tx, { cardId: card.id, baseVersion: card.version, ownerId,
      prompt: source.prompt, model: source.model, resolution: source.resolution });
    if (attempt.duplicate) throw new Error("该版本已有进行中的图片任务，未创建重复复核");
    // Preserve the original paid output and exact request even if another audit rejects it.
    await tx("o_characterCardImage").where({ id: attempt.id, ownerId, state: "running" }).update({
      prompt: source.prompt, model: source.model, resolution: source.resolution, filePath: source.filePath,
    });
    return { source, card, attemptId: attempt.id, ownerId };
  });
  const { source, card, attemptId, ownerId } = prepared;
  const report: CandidateReviewReport = { sourceAttemptId: source.id, reviewAttemptId: attemptId, cardId: card.id,
    ownerId, baseVersion: card.version, resultVersion: null, passed: false, adopted: false,
    filePath: source.filePath!, model: source.model, resolution: source.resolution };
  try {
    await deps.started?.({ attemptId, cardId: card.id });
    await deps.review(card, source);
    const result = await completeCharacterCardImage(deps.db, { attemptId, ownerId, filePath: source.filePath! });
    return { ...report, passed: true, adopted: result.adopted, resultVersion: result.attempt.resultVersion };
  } catch (cause) {
    const errorReason = (deps.safeError || sanitizedReviewError)(cause);
    await failCharacterCardImage(deps.db, { attemptId, ownerId, errorReason });
    return { ...report, errorReason };
  }
}
