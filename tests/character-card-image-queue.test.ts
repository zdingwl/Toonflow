import test from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { beginCharacterCardImage, getCharacterCard, migrateCharacterCards, saveCharacterCard } from "../src/utils/characterCards";
import { createCharacterCardImageQueue } from "../src/utils/characterCardImageGeneration";

test("serial queue skips obsolete waiting designs and duplicate scheduling does not call renderer twice", async t => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy()); await migrateCharacterCards(db);
  const a = await beginCharacterCardImage(db, { cardId: 4, baseVersion: 1, ownerId: 1, prompt: "facts", model: "local:qwen", resolution: "2K" });
  const seed = (await getCharacterCard(db, 5, 1))!;
  const editable = await saveCharacterCard(db, { ...seed, id: undefined, version: undefined, name: "排队角色" }, 1);
  const b = await beginCharacterCardImage(db, { cardId: editable.id, baseVersion: 1, ownerId: 1, prompt: "facts", model: "local:qwen", resolution: "2K" });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const calls: number[] = [];
  const queue = createCharacterCardImageQueue({ db, render: async (card) => { calls.push(card.id); started(); await gate; return { filePath: "cards/full.jpg", prompt: "full sheet" }; } });
  const first = queue.enqueue(a); const duplicate = queue.enqueue(a); const second = queue.enqueue(b);
  assert.equal(first, duplicate); await running;
  assert.equal(queue.phase(a.id), "running"); assert.equal(queue.phase(b.id), "queued");
  await saveCharacterCard(db, { ...editable, name: "已经修改" }, 1);
  release(); await Promise.all([first, duplicate, second]);
  assert.deepEqual(calls, [4]);
  assert.equal((await getCharacterCard(db, 4, 1))!.imagePath, "cards/full.jpg");
  assert.match((await db("o_characterCardImage").where({ id: b.id }).first()).errorReason, /排队期间已更新/);
  assert.equal(queue.phase(a.id), undefined);
});

test("provider failure persists its cause and the following queued card still completes", async t => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy()); await migrateCharacterCards(db);
  const attempt = async (id: number) => beginCharacterCardImage(db, { cardId: id, baseVersion: 1, ownerId: 1, prompt: "facts", model: "local:qwen", resolution: "2K" });
  const a = await attempt(4), b = await attempt(5);
  const queue = createCharacterCardImageQueue({ db, render: async card => {
    if (card.id === 4) throw new Error("GPU temporarily unavailable");
    return { filePath: "cards/next.jpg", prompt: "next full sheet" };
  } });
  await Promise.all([queue.enqueue(a), queue.enqueue(b)]);
  assert.equal((await db("o_characterCardImage").where({ id: a.id }).first()).state, "failed");
  assert.equal((await getCharacterCard(db, 4, 1))!.imagePath, null);
  assert.equal((await getCharacterCard(db, 5, 1))!.imagePath, "cards/next.jpg");
});
