import type { Knex } from "knex";
import pLimit from "p-limit";
import { getCharacterCard, completeCharacterCardImage, failCharacterCardImage, type CharacterCard, type CharacterCardImageAttempt } from "./characterCards";

export interface CharacterCardImageDependencies {
  db: Knex;
  render: (card: CharacterCard, attempt: CharacterCardImageAttempt) => Promise<{ filePath: string; prompt: string }>;
}
/** One complete sheet at a time prevents local GPU overload. Persisted attempts guard retries. */
export function createCharacterCardImageQueue(deps: CharacterCardImageDependencies) {
  const limit = pLimit(1);
  const pending = new Map<number, "queued" | "running">();
  const jobs = new Map<number, Promise<void>>();
  function enqueue(attempt: CharacterCardImageAttempt): Promise<void> {
    const existing = jobs.get(attempt.id);
    if (existing) return existing;
    pending.set(attempt.id, "queued");
    const job = limit(async () => {
      try {
        const liveAttempt = await deps.db("o_characterCardImage").where({ id: attempt.id, state: "running" }).first();
        if (!liveAttempt) return;
        const card = await getCharacterCard(deps.db, attempt.cardId, attempt.ownerId);
        // Queued cards may be edited before the GPU is free. Do not pay for an obsolete design.
        if (!card || card.status !== "active" || card.version !== attempt.baseVersion) throw new Error("角色卡在排队期间已更新，请按当前版本重新生成图片");
        pending.set(attempt.id, "running");
        const result = await deps.render(card, attempt);
        await deps.db("o_characterCardImage").where({ id: attempt.id, state: "running" }).update({ prompt: result.prompt, updatedAt: Date.now() });
        await completeCharacterCardImage(deps.db, { attemptId: attempt.id, ownerId: attempt.ownerId, filePath: result.filePath });
      } catch (cause) {
        await failCharacterCardImage(deps.db, { attemptId: attempt.id, ownerId: attempt.ownerId,
          errorReason: cause instanceof Error ? cause.message : String(cause) });
      } finally { pending.delete(attempt.id); jobs.delete(attempt.id); }
    });
    jobs.set(attempt.id, job);
    return job;
  }
  return { enqueue, phase: (id: number) => pending.get(id) };
}

let activeQueue: ReturnType<typeof createCharacterCardImageQueue> | undefined;
export function characterCardImageQueue(deps: CharacterCardImageDependencies) {
  return activeQueue ??= createCharacterCardImageQueue(deps);
}
export function getCharacterCardImagePhase(id: number) { return activeQueue?.phase(id); }
