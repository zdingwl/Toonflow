import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  beginCharacterCardImage, completeCharacterCardImage, failCharacterCardImage, getCharacterCard, migrateCharacterCards,
  saveCharacterCard, type CharacterCardInput,
} from "../src/utils/characterCards";
import { hydrateCharacterCard } from "../src/utils/characterCardImageResponse";

const cardInput: CharacterCardInput = { name: "图文参考", artStyle: "realistic_3d_anime", roleDefinition: "女性，现代日常", ageBand: "adult", gender: "female",
  visualDesign: { face: "自然鹅蛋脸", body: "成年自然体态", hair: "黑色长发", clothing: "白色上衣、灰色长裤、黑色平底鞋", environment: "", shape: "" } };
async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await migrateCharacterCards(db);
  const card = await saveCharacterCard(db, cardInput, 1);
  const paths: string[] = [];
  const oss = {
    async getSmallImageUrl(path: string) { paths.push(`small:${path}`); return `/oss/thumb/${path}`; },
    async getFileUrl(path: string) { paths.push(`full:${path}`); return `/oss/${path}`; },
  };
  const begin = (version: number) => beginCharacterCardImage(db, { cardId: card.id, baseVersion: version, ownerId: 1,
    prompt: "完整四视图", model: "vendor:image-model", resolution: "2K" });
  return { db, card, paths, oss, begin };
}

test("missing card images return null URLs and a queued job stays distinguishable from actual generation", async t => {
  const f = await fixture(t);
  const empty = await hydrateCharacterCard(f.db, f.card, 1, f.oss);
  assert.equal(empty.imageUrl, null);
  assert.equal(empty.imageFullUrl, null);
  assert.equal(empty.imageGeneration, null);
  assert.deepEqual(f.paths, []);
  const attempt = await f.begin(1);
  const queued = await hydrateCharacterCard(f.db, f.card, 1, f.oss, id => { assert.equal(id, attempt.id); return "queued"; });
  assert.equal(queued.imageGeneration!.state, "running");
  assert.equal(queued.imageGeneration!.phase, "queued");
  assert.equal(queued.imageGeneration!.adopted, false);
  assert.equal(queued.imageGeneration!.canReview, false);
  assert.equal(queued.candidateFullUrl, null);
  const running = await hydrateCharacterCard(f.db, f.card, 1, f.oss);
  assert.equal(running.imageGeneration!.phase, "running");
});

test("ready card URLs use the adopted complete file and regenerate status preserves the old preview", async t => {
  const f = await fixture(t);
  const attempt = await f.begin(1);
  const done = await completeCharacterCardImage(f.db, { attemptId: attempt.id, ownerId: 1, filePath: "cards/complete-sheet.png" });
  const ready = await hydrateCharacterCard(f.db, done.card, 1, f.oss);
  assert.equal(ready.imageUrl, "/oss/thumb/cards/complete-sheet.png");
  assert.equal(ready.imageFullUrl, "/oss/cards/complete-sheet.png");
  assert.equal(ready.imageGeneration!.adopted, true);
  assert.equal(ready.imageGeneration!.resultVersion, 2);
  assert.equal(ready.imageGeneration!.model, "vendor:image-model");
  const edited = await saveCharacterCard(f.db, { ...done.card, visualDesign: { ...done.card.visualDesign, hair: "栗色短发" } }, 1);
  const pending = await f.begin(edited.version);
  const queued = await hydrateCharacterCard(f.db, edited, 1, f.oss, async id => { assert.equal(id, pending.id); return "queued" as const; });
  assert.equal(queued.imageNeedsRegeneration, true);
  assert.equal(queued.imageUrl, ready.imageUrl);
  assert.equal(queued.imageFullUrl, ready.imageFullUrl);
  assert.equal(queued.imageGeneration!.id, pending.id);
});

test("historical versions keep their own image and never report a later version's current job", async t => {
  const f = await fixture(t);
  const first = await f.begin(1);
  const initialImage = await completeCharacterCardImage(f.db, { attemptId: first.id, ownerId: 1, filePath: "cards/version-two.png" });
  const edited = await saveCharacterCard(f.db, { ...initialImage.card, visualDesign: { ...initialImage.card.visualDesign, clothing: "灰色外套、黑色长裤、黑色平底鞋" } }, 1);
  const later = await f.begin(edited.version);
  const historical = (await getCharacterCard(f.db, f.card.id, 1, 2))!;
  const historyResponse = await hydrateCharacterCard(f.db, historical, 1, f.oss, () => { throw new Error("do not inspect another version's queue phase"); });
  assert.equal(historyResponse.imageFullUrl, "/oss/cards/version-two.png");
  assert.equal(historyResponse.imageGeneration!.id, first.id);
  assert.notEqual(historyResponse.imageGeneration!.id, later.id);
  assert.equal(historyResponse.imageGeneration!.state, "completed");
  assert.equal(historyResponse.imageGeneration!.adopted, true);
  const original = await hydrateCharacterCard(f.db, (await getCharacterCard(f.db, f.card.id, 1, 1))!, 1, f.oss);
  assert.equal(original.imageFullUrl, null);
  assert.equal(original.imageGeneration!.adopted, false, "an image adopted in version 2 is not adopted in the version 1 snapshot");
  await completeCharacterCardImage(f.db, { attemptId: later.id, ownerId: 1, filePath: "cards/version-four.png" });
  const frozen = await hydrateCharacterCard(f.db, historical, 1, f.oss);
  assert.equal(frozen.imageFullUrl, "/oss/cards/version-two.png");
  assert.equal(frozen.imageGeneration!.id, first.id);
});

test("unadopted late output does not become a URL fallback and current failure explains itself beside the old image", async t => {
  const f = await fixture(t);
  const first = await f.begin(1);
  const ready = await completeCharacterCardImage(f.db, { attemptId: first.id, ownerId: 1, filePath: "cards/paid-original.png" });
  const lateAttempt = await f.begin(2);
  const edited = await saveCharacterCard(f.db, { ...ready.card, name: "更新的角色卡" }, 1);
  await completeCharacterCardImage(f.db, { attemptId: lateAttempt.id, ownerId: 1, filePath: "cards/late-unadopted.png" });
  const failure = await f.begin(edited.version);
  await f.db("o_characterCardImage").where({ id: failure.id }).update({ filePath: "cards/rejected-paid-candidate.png" });
  await failCharacterCardImage(f.db, { attemptId: failure.id, ownerId: 1, errorReason: "模型返回空图片" });
  const response = await hydrateCharacterCard(f.db, (await getCharacterCard(f.db, f.card.id, 1))!, 1, f.oss);
  assert.equal(response.imageFullUrl, "/oss/cards/paid-original.png");
  assert.equal(response.imageGeneration!.id, failure.id);
  assert.equal(response.imageGeneration!.state, "failed");
  assert.equal(response.imageGeneration!.errorReason, "模型返回空图片");
  assert.equal(response.imageErrorReason, "模型返回空图片");
  assert.equal(response.candidateImageUrl, "/oss/thumb/cards/rejected-paid-candidate.png");
  assert.equal(response.candidateFullUrl, "/oss/cards/rejected-paid-candidate.png");
  assert.equal(response.imageGeneration!.candidateFullUrl, response.candidateFullUrl);
  assert.equal(response.imageGeneration!.canReview, true);
  const staleCandidateView = await hydrateCharacterCard(f.db, (await getCharacterCard(f.db, f.card.id, 1, 2))!, 1, f.oss);
  assert.equal(staleCandidateView.candidateFullUrl, null, "an unrelated failed version cannot appear beside a historical card");
  assert.ok(!f.paths.some(path => path.includes("late-unadopted")));
});

test("a public seed candidate can be previewed but only its attempt owner may request review", async t => {
  const f = await fixture(t);
  const seed = (await getCharacterCard(f.db, 4, 1))!;
  const attempt = await beginCharacterCardImage(f.db, { cardId: seed.id, baseVersion: seed.version, ownerId: 1,
    prompt: "完整四视图", model: "vendor:image-model", resolution: "4K" });
  await f.db("o_characterCardImage").where({ id: attempt.id }).update({ filePath: "cards/seed-failed-candidate.png" });
  await failCharacterCardImage(f.db, { attemptId: attempt.id, ownerId: 1, errorReason: "等待复核" });
  const owner = await hydrateCharacterCard(f.db, seed, 1, f.oss);
  assert.equal(owner.imageUrl, null);
  assert.equal(owner.imageFullUrl, null);
  assert.equal(owner.imageGeneration!.canReview, true);
  assert.equal(owner.candidateFullUrl, "/oss/cards/seed-failed-candidate.png");
  const other = await hydrateCharacterCard(f.db, seed, 2, f.oss);
  assert.equal(other.candidateFullUrl, owner.candidateFullUrl);
  assert.equal(other.imageGeneration!.canReview, false);
  await f.db("o_characterCardImage").where({ id: attempt.id }).update({ filePath: null });
  const noFile = await hydrateCharacterCard(f.db, seed, 1, f.oss);
  assert.equal(noFile.candidateFullUrl, null);
  assert.equal(noFile.imageGeneration!.canReview, false);
});

test("hydration cannot expose image URLs from a private card to another owner", async t => {
  const f = await fixture(t);
  const attempt = await f.begin(1);
  const done = await completeCharacterCardImage(f.db, { attemptId: attempt.id, ownerId: 1, filePath: "cards/private.png" });
  await assert.rejects(hydrateCharacterCard(f.db, done.card, 2, f.oss), /无权访问/);
  assert.deepEqual(f.paths, []);
});
