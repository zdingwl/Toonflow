import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import knex from "knex";
import { reviewCharacterCardCandidate, resolveCandidateFile, sanitizedReviewError } from "../scripts/review-character-card-candidate";
import { beginCharacterCardImage, completeCharacterCardImage, failCharacterCardImage, getCharacterCard,
  migrateCharacterCards, saveCharacterCard, type CharacterCardInput } from "../src/utils/characterCards";

const definition = (): CharacterCardInput => ({ name: "艾娃", artStyle: "realistic_3d_anime", roleDefinition: "女性，城市生活人物",
  ageBand: "adult", gender: "female", describe: "自然比例，现代日常服装", visualDesign: {
    face: "鹅蛋脸，杏眼", body: "成年自然比例", hair: "墨黑长发", clothing: "白衬衫、灰色长裤、黑色平底鞋", environment: "", shape: "",
  } });
async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await migrateCharacterCards(db);
  const initial = await saveCharacterCard(db, definition(), 1);
  const first = await beginCharacterCardImage(db, { cardId: initial.id, baseVersion: 1, ownerId: 1, prompt: "旧图稿", model: "paid:image", resolution: "4K" });
  const { card } = await completeCharacterCardImage(db, { attemptId: first.id, ownerId: 1, filePath: "/cards/old-complete.jpg" });
  const failed = await beginCharacterCardImage(db, { cardId: card.id, baseVersion: card.version, ownerId: 1, prompt: "原绘制稿", model: "paid:actual-image-model", resolution: "4K" });
  await db("o_characterCardImage").where({ id: failed.id }).update({ filePath: "/cards/paid-candidate.jpg", prompt: "  原绘制稿\n保留换行  " });
  await failCharacterCardImage(db, { attemptId: failed.id, ownerId: 1, errorReason: "旧复核误判" });
  const source = await db("o_characterCardImage").where({ id: failed.id }).first();
  return { db, card, source };
}

test("review adopts the existing file in a new immutable version and preserves the original failure exactly", async t => {
  const { db, card, source } = await fixture(t);
  let calls = 0;
  let startedId: number | undefined;
  const report = await reviewCharacterCardCandidate({ db, started: async event => {
    assert.equal(event.cardId, card.id);
    assert.notEqual(event.attemptId, source.id);
    const committed = await db("o_characterCardImage").where({ id: event.attemptId }).first();
    assert.equal(committed.state, "running");
    assert.equal(committed.filePath, source.filePath);
    startedId = event.attemptId;
  }, review: async (contextCard, candidate) => {
    assert.ok(startedId, "the committed attempt is announced before the provider starts");
    calls += 1;
    assert.equal(contextCard.version, card.version);
    assert.deepEqual(candidate, source);
    const pending = await db("o_characterCardImage").where({ cardId: card.id, state: "running" }).first();
    assert.equal(pending.prompt, source.prompt);
    assert.equal(pending.model, source.model);
    assert.equal(pending.resolution, "4K");
    assert.equal(pending.filePath, source.filePath);
  } }, { attemptId: source.id });
  assert.equal(calls, 1);
  assert.equal(report.passed, true);
  assert.equal(report.adopted, true);
  assert.notEqual(report.reviewAttemptId, source.id);
  assert.equal(report.reviewAttemptId, startedId);
  assert.equal(report.resultVersion, card.version + 1);
  assert.deepEqual(await db("o_characterCardImage").where({ id: source.id }).first(), source);
  const updated = (await getCharacterCard(db, card.id, 1))!;
  assert.equal(updated.imagePath, source.filePath);
  assert.equal(updated.imageId, report.reviewAttemptId);
  assert.equal((await getCharacterCard(db, card.id, 1, card.version))!.imagePath, "/cards/old-complete.jpg");
});

test("failed review retains the paid file and old selected image without touching another running seed task", async t => {
  const { db, card, source } = await fixture(t);
  const seed = (await getCharacterCard(db, 4, 1))!;
  const other = await beginCharacterCardImage(db, { cardId: seed.id, baseVersion: seed.version, ownerId: 1, prompt: "正在生成种子", model: "paid:image", resolution: "4K" });
  const otherBefore = await db("o_characterCardImage").where({ id: other.id }).first();
  const report = await reviewCharacterCardCandidate({ db, safeError: error => sanitizedReviewError(error, ["secret-key"]),
    review: async () => { throw new Error("仍有外观冲突 secret-key"); } }, { attemptId: source.id });
  assert.equal(report.passed, false);
  assert.equal(report.adopted, false);
  assert.equal(report.errorReason, "仍有外观冲突 [redacted]");
  const failed = await db("o_characterCardImage").where({ id: report.reviewAttemptId }).first();
  assert.equal(failed.state, "failed");
  assert.equal(failed.filePath, source.filePath);
  assert.equal(failed.prompt, source.prompt);
  assert.deepEqual(await getCharacterCard(db, card.id, 1), card);
  assert.deepEqual(await db("o_characterCardImage").where({ id: source.id }).first(), source);
  assert.deepEqual(await db("o_characterCardImage").where({ id: other.id }).first(), otherBefore);
});

test("existing running work rejects review without hijacking or failing the original task", async t => {
  const { db, card, source } = await fixture(t);
  const running = await beginCharacterCardImage(db, { cardId: card.id, baseVersion: card.version, ownerId: 1, prompt: "新付费任务", model: "paid:image", resolution: "4K" });
  const before = await db("o_characterCardImage").where({ cardId: card.id }).orderBy("id");
  let calls = 0;
  let announcements = 0;
  await assert.rejects(reviewCharacterCardCandidate({ db, started: () => { announcements += 1; }, review: async () => { calls += 1; } }, { attemptId: source.id }), /进行中/);
  assert.equal(calls, 0);
  assert.equal(announcements, 0);
  assert.deepEqual(await db("o_characterCardImage").where({ cardId: card.id }).orderBy("id"), before);
  assert.equal((await db("o_characterCardImage").where({ id: running.id }).first()).state, "running");
});

test("review rejects missing candidate, wrong owner, and obsolete version before creating any task", async t => {
  const { db, card, source } = await fixture(t);
  let calls = 0;
  const deps = { db, review: async () => { calls += 1; } };
  const count = (await db("o_characterCardImage")).length;
  await assert.rejects(reviewCharacterCardCandidate(deps, { attemptId: source.id, ownerId: 2 }), /无权/);
  await db("o_characterCardImage").where({ id: source.id }).update({ filePath: null });
  await assert.rejects(reviewCharacterCardCandidate(deps, { attemptId: source.id }), /候选文件/);
  await db("o_characterCardImage").where({ id: source.id }).update({ filePath: source.filePath });
  await saveCharacterCard(db, { ...card, visualDesign: { ...card.visualDesign, hair: "栗色短发" } }, 1);
  await assert.rejects(reviewCharacterCardCandidate(deps, { attemptId: source.id }), /已经变更/);
  assert.equal(calls, 0);
  assert.equal((await db("o_characterCardImage")).length, count);
});

test("text edited during review leaves the verified file in history and does not overwrite current design", async t => {
  const { db, card, source } = await fixture(t);
  const report = await reviewCharacterCardCandidate({ db, review: async () => {
    await saveCharacterCard(db, { ...card, visualDesign: { ...card.visualDesign, hair: "栗色短发" } }, 1);
  } }, { attemptId: source.id });
  assert.equal(report.passed, true);
  assert.equal(report.adopted, false);
  assert.equal(report.resultVersion, null);
  const current = (await getCharacterCard(db, card.id, 1))!;
  assert.equal(current.visualDesign.hair, "栗色短发");
  assert.equal(current.imagePath, "/cards/old-complete.jpg");
  const output = await db("o_characterCardImage").where({ id: report.reviewAttemptId }).first();
  assert.equal(output.state, "completed");
  assert.equal(output.filePath, source.filePath);
});

test("OSS loader resolves a complete local file but refuses traversal", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-card-review-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const root = path.join(folder, "oss");
  fs.mkdirSync(path.join(root, "cards"), { recursive: true });
  fs.writeFileSync(path.join(root, "cards", "sheet.jpg"), "existing file");
  assert.equal(resolveCandidateFile(root, "/cards/sheet.jpg"), fs.realpathSync(path.join(root, "cards", "sheet.jpg")));
  assert.throws(() => resolveCandidateFile(root, "../outside.jpg"), /超出/);
  assert.throws(() => resolveCandidateFile(root, "cards"), /不合法/);
});

test("review errors redact known credentials, bearer tokens, and SQL parameter text", () => {
  assert.equal(sanitizedReviewError(new Error("供应商失败 api-secret Bearer abc.def"), ["api-secret"]), "供应商失败 [redacted] Bearer [redacted]");
  assert.equal(sanitizedReviewError(new Error("update sensitive set value='secret' - database is locked")), "database is locked");
});
