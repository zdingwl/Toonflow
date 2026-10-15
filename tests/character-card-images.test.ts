import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  beginCharacterCardImage, completeCharacterCardImage, failCharacterCardImage, getCharacterCard, getLatestCharacterCardImage,
  listCharacterCardImages, migrateCharacterCards, recoverCharacterCardImages, saveCharacterCard, characterCardFromAsset,
  archiveCharacterCard, type CharacterCardInput,
} from "../src/utils/characterCards";

const input = (): CharacterCardInput => ({ name: "图文角色卡", artStyle: "realistic_3d_anime", roleDefinition: "女性，现代日常人物",
  ageBand: "adult", gender: "female", describe: "自然比例与完整日常衣装", visualDesign: {
    face: "自然鹅蛋脸、清晰杏眼", body: "成年自然比例", hair: "墨黑长发", clothing: "白衬衫、灰色长裤、黑色平底鞋", environment: "", shape: "",
  } });
async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await migrateCharacterCards(db);
  const card = await saveCharacterCard(db, input(), 1);
  return { db, card };
}
const imageInput = (cardId: number, baseVersion: number) => ({ cardId, baseVersion, ownerId: 1, prompt: "完整人物四视图", model: "existing:image-model", resolution: "2K" });

test("image completion persists a new immutable card version and idempotent retries preserve the first file", async t => {
  const { db, card } = await fixture(t);
  const attempt = await beginCharacterCardImage(db, imageInput(card.id, card.version));
  assert.equal(attempt.duplicate, false);
  assert.equal(attempt.state, "running");
  const done = await completeCharacterCardImage(db, { attemptId: attempt.id, ownerId: 1, filePath: "cards/first-full-sheet.png" });
  assert.equal(done.adopted, true);
  assert.equal(done.attempt.resultVersion, 2);
  assert.equal(done.card.version, 2);
  assert.equal(done.card.imageId, attempt.id);
  assert.equal(done.card.imagePath, "cards/first-full-sheet.png");
  assert.equal(done.card.imageState, "ready");
  assert.equal(done.card.imageNeedsRegeneration, false);
  assert.equal((await getCharacterCard(db, card.id, 1, 1))!.imagePath, null);
  assert.equal((await getCharacterCard(db, card.id, 1, 2))!.imagePath, done.card.imagePath);
  const retry = await completeCharacterCardImage(db, { attemptId: attempt.id, ownerId: 1, filePath: "cards/duplicate-callback.png" });
  assert.equal(retry.card.version, 2);
  assert.equal(retry.attempt.filePath, "cards/first-full-sheet.png");
  assert.equal((await db("o_characterCardVersion").where({ cardId: card.id })).length, 2);
});

test("overlapping starts and a database unique guard prevent duplicate paid work for the same version", async t => {
  const { db, card } = await fixture(t);
  const [first, duplicate] = await Promise.all([beginCharacterCardImage(db, imageInput(card.id, 1)), beginCharacterCardImage(db, imageInput(card.id, 1))]);
  assert.equal(first.id, duplicate.id);
  assert.deepEqual([first.duplicate, duplicate.duplicate].sort(), [false, true]);
  assert.equal((await listCharacterCardImages(db, card.id, 1)).length, 1);
  const raw = await db("o_characterCardImage").where({ id: first.id }).first();
  delete raw.id;
  await assert.rejects(db("o_characterCardImage").insert(raw), /UNIQUE constraint/);
});

test("text changes retain the selected image, mark it stale and cannot be overwritten by a late completion", async t => {
  const { db, card } = await fixture(t);
  const initial = await beginCharacterCardImage(db, imageInput(card.id, 1));
  const ready = await completeCharacterCardImage(db, { attemptId: initial.id, ownerId: 1, filePath: "cards/old-full-sheet.png" });
  const pending = await beginCharacterCardImage(db, imageInput(card.id, ready.card.version));
  const edited = await saveCharacterCard(db, { ...ready.card, visualDesign: { ...ready.card.visualDesign, hair: "栗色短发" } }, 1);
  assert.equal(edited.version, 3);
  assert.equal(edited.imagePath, ready.card.imagePath);
  assert.equal(edited.imageNeedsRegeneration, true);
  assert.equal(edited.imageState, "stale");
  const late = await completeCharacterCardImage(db, { attemptId: pending.id, ownerId: 1, filePath: "cards/late-paid-output.png" });
  assert.equal(late.adopted, false);
  assert.equal(late.attempt.state, "completed");
  assert.equal(late.attempt.resultVersion, null);
  assert.equal(late.card.version, 3);
  assert.equal(late.card.visualDesign.hair, "栗色短发");
  assert.equal(late.card.imagePath, "cards/old-full-sheet.png");
  const history = await listCharacterCardImages(db, card.id, 1);
  assert.deepEqual(history.map(row => row.filePath), ["cards/late-paid-output.png", "cards/old-full-sheet.png"]);
  assert.equal((await getCharacterCard(db, card.id, 1, 2))!.imageNeedsRegeneration, false);
});

test("failed generation and startup recovery preserve an existing image and allow an explicit retry", async t => {
  const { db, card } = await fixture(t);
  const first = await beginCharacterCardImage(db, imageInput(card.id, 1));
  const ready = await completeCharacterCardImage(db, { attemptId: first.id, ownerId: 1, filePath: "cards/paid-existing.png" });
  const pending = await beginCharacterCardImage(db, imageInput(card.id, 2));
  const failed = await failCharacterCardImage(db, { attemptId: pending.id, ownerId: 1, errorReason: "供应商输出失败" });
  assert.equal(failed.attempt.state, "failed");
  assert.equal(failed.attempt.errorReason, "供应商输出失败");
  assert.equal(failed.card.imagePath, ready.card.imagePath);
  assert.equal(failed.card.version, 2);
  const retry = await beginCharacterCardImage(db, imageInput(card.id, 2));
  assert.notEqual(retry.id, pending.id);
  assert.equal(await recoverCharacterCardImages(db), 1);
  const recovered = await getLatestCharacterCardImage(db, card.id, 1);
  assert.equal(recovered!.state, "failed");
  assert.match(recovered!.errorReason!, /手动重试/);
  assert.equal((await getCharacterCard(db, card.id, 1))!.imagePath, "cards/paid-existing.png");
  assert.equal((await getCharacterCard(db, card.id, 1))!.version, 2);
  await assert.rejects(completeCharacterCardImage(db, { attemptId: retry.id, ownerId: 1, filePath: "cards/failed-record-overwrite.png" }), /已经结束/);
});

test("seed cards allow new image versions while their text remains read-only", async t => {
  const { db } = await fixture(t);
  const seed = (await getCharacterCard(db, 4, 1))!;
  const attempt = await beginCharacterCardImage(db, imageInput(seed.id, seed.version));
  const done = await completeCharacterCardImage(db, { attemptId: attempt.id, ownerId: 1, filePath: "cards/seed-full-sheet.png" });
  assert.equal(done.card.ownerId, 0);
  assert.equal(done.card.version, 2);
  assert.equal(done.card.visualDesign.face, seed.visualDesign.face);
  assert.equal((await getCharacterCard(db, seed.id, 2))!.imagePath, "cards/seed-full-sheet.png");
  assert.equal((await getCharacterCard(db, seed.id, 1, 1))!.imagePath, null);
  await assert.rejects(saveCharacterCard(db, { ...done.card, name: "不可修改预置文本" }, 1), /只读预置/);
});

test("image history, completion and failure reject a different owner", async t => {
  const { db, card } = await fixture(t);
  await assert.rejects(beginCharacterCardImage(db, { ...imageInput(card.id, 1), ownerId: 2 }), /无权/);
  const attempt = await beginCharacterCardImage(db, imageInput(card.id, 1));
  await assert.rejects(completeCharacterCardImage(db, { attemptId: attempt.id, ownerId: 2, filePath: "foreign.png" }), /无权/);
  await assert.rejects(failCharacterCardImage(db, { attemptId: attempt.id, ownerId: 2, errorReason: "无权写" }), /无权/);
  await assert.rejects(listCharacterCardImages(db, card.id, 2), /无权/);
  assert.equal((await getLatestCharacterCardImage(db, card.id, 1))!.state, "running");
});

test("archiving a card prevents a late image from being automatically adopted", async t => {
  const { db, card } = await fixture(t);
  const attempt = await beginCharacterCardImage(db, imageInput(card.id, 1));
  await archiveCharacterCard(db, card.id, 1, 1);
  const late = await completeCharacterCardImage(db, { attemptId: attempt.id, ownerId: 1, filePath: "cards/archived-paid-output.png" });
  assert.equal(late.adopted, false);
  assert.equal(late.card.status, "archived");
  assert.equal(late.card.imagePath, null);
  assert.equal(late.attempt.filePath, "cards/archived-paid-output.png");
});

test("fromAsset imports the selected complete sheet into its first card snapshot and leaves the source untouched", async t => {
  const { db } = await fixture(t);
  await db.schema.createTable("o_project", table => { table.integer("id"); table.integer("userId"); table.text("artStyle"); });
  await db.schema.createTable("o_assets", table => {
    for (const field of ["id", "projectId", "imageId", "descriptionVersion", "imageDescriptionVersion"]) table.integer(field);
    for (const field of ["name", "type", "describe", "descriptionMeta", "faceReferencePath"]) table.text(field);
  });
  await db.schema.createTable("o_image", table => {
    table.integer("id"); table.integer("assetsId"); table.integer("descriptionVersion");
    for (const field of ["state", "filePath", "prompt", "model", "resolution"]) table.text(field);
  });
  await db("o_project").insert({ id: 1, userId: 1, artStyle: "realistic_3d_anime" });
  const source = { id: 30, projectId: 1, imageId: 40, descriptionVersion: 2, imageDescriptionVersion: 2, name: "艾娃", type: "role",
    describe: "当前原文描述", faceReferencePath: "assets/cropped-face.png", descriptionMeta: JSON.stringify({ visualDesign: input().visualDesign,
      characterCard: { ageBand: "adult", ageMin: 18, ageMax: null, gender: "female" }, scriptFacts: [{ quote: "项目来源保留" }] }) };
  const image = { id: 40, assetsId: 30, descriptionVersion: 2, state: "已完成", filePath: "assets/selected-complete-four-view.png",
    prompt: "旧已完成图片提示词", model: "source:image-model", resolution: "2K" };
  await db("o_assets").insert(source);
  await db("o_image").insert(image);
  const card = await characterCardFromAsset(db, { assetId: 30 }, 1);
  assert.equal(card.version, 1);
  assert.equal(card.imagePath, image.filePath);
  assert.notEqual(card.imagePath, source.faceReferencePath);
  assert.equal(card.imageState, "ready");
  assert.equal(card.imageNeedsRegeneration, false);
  assert.equal((await getCharacterCard(db, card.id, 1, 1))!.imagePath, image.filePath);
  const imported = await getLatestCharacterCardImage(db, card.id, 1);
  assert.equal(imported!.sourceImageId, 40);
  assert.equal(imported!.baseVersion, 1);
  assert.equal(imported!.resultVersion, 1);
  assert.equal(imported!.state, "completed");
  assert.deepEqual(await db("o_assets").where({ id: 30 }).first(), source);
  assert.deepEqual(await db("o_image").where({ id: 40 }).first(), image);
  await db("o_assets").where({ id: 30 }).update({ descriptionVersion: 3 });
  const stale = await characterCardFromAsset(db, { assetId: 30 }, 1);
  assert.equal(stale.imagePath, image.filePath);
  assert.equal(stale.imageNeedsRegeneration, true);
  assert.equal(stale.imageState, "stale");
});

test("image attempts and adopted snapshots participate in the caller transaction", async t => {
  const { db, card } = await fixture(t);
  await assert.rejects(db.transaction(async tx => {
    const attempt = await beginCharacterCardImage(tx, imageInput(card.id, 1));
    const done = await completeCharacterCardImage(tx, { attemptId: attempt.id, ownerId: 1, filePath: "cards/rolled-back.png" });
    assert.equal(done.card.version, 2);
    throw new Error("transaction rollback");
  }), /transaction rollback/);
  assert.equal((await listCharacterCardImages(db, card.id, 1)).length, 0);
  assert.equal((await getCharacterCard(db, card.id, 1))!.version, 1);
  assert.equal((await getCharacterCard(db, card.id, 1))!.imagePath, null);
  assert.equal((await db("o_characterCardVersion").where({ cardId: card.id })).length, 1);
});

test("additive media migration preserves existing text cards and legacy snapshots", async t => {
  const { db, card } = await fixture(t);
  await db.schema.dropTable("o_characterCardImage");
  await db.schema.alterTable("o_characterCard", table => { table.dropColumns("imagePath", "imageId", "imageState", "imageNeedsRegeneration", "imageErrorReason"); });
  const oldSnapshot = { ...card } as any;
  for (const field of ["imagePath", "imageId", "imageState", "imageNeedsRegeneration", "imageErrorReason"]) delete oldSnapshot[field];
  await db("o_characterCardVersion").where({ cardId: card.id, version: 1 }).update({ snapshot: JSON.stringify(oldSnapshot) });
  await migrateCharacterCards(db);
  assert.equal((await getCharacterCard(db, card.id, 1))!.name, card.name);
  assert.equal((await getCharacterCard(db, card.id, 1))!.version, 1);
  assert.equal((await getCharacterCard(db, card.id, 1, 1))!.imagePath, null);
  assert.equal((await getCharacterCard(db, card.id, 1, 1))!.imageNeedsRegeneration, false);
  assert.equal((await db("o_characterCard")).length, 11);
});
