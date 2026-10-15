import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { beginCharacterCardImage, getCharacterCard, listCharacterCardImages, migrateCharacterCards, saveCharacterCard } from "../src/utils/characterCards";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { syncCharacterCardAssetImage, syncCharacterCardAssetImageSafely } from "../src/utils/characterCardAssetImageSync";

export const visual = { face: "自然椭圆脸，清晰眉眼", body: "自然比例，肩线舒展", hair: "黑色长发",
  clothing: "白色翻领衬衫、灰色长裤与黑色平底鞋", environment: "", shape: "" };

async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_project", table => { table.integer("id"); table.integer("userId"); table.text("artStyle"); });
  await db.schema.createTable("o_assets", table => {
    table.integer("id").primary(); for (const field of ["projectId", "assetsId", "imageId"]) table.integer(field);
    for (const field of ["type", "name", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_image", table => {
    table.increments("id"); table.integer("assetsId"); for (const field of ["type", "state", "filePath", "model", "resolution", "errorReason"]) table.text(field);
  });
  await migrateAssetDescriptions(db); await migrateCharacterCards(db);
  await db("o_project").insert({ id: 7, userId: 1, artStyle: "realistic_3d_anime" });
  const card = await saveCharacterCard(db, { name: "人物参考卡", artStyle: "realistic_3d_anime", roleDefinition: "女性，黑色长发，日常人物",
    ageBand: "unknown", gender: "female", visualDesign: visual }, 1);
  await db("o_image").insert([{ id: 40, assetsId: 10, type: "role", state: "已完成", filePath: "/old-paid.jpg", descriptionVersion: 1 },
    { id: 41, assetsId: 10, type: "role", state: "已完成", filePath: "/new-paid.jpg", model: "qwen-image-2.1-fourview-local", resolution: "2560x960", descriptionVersion: 2 }]);
  const meta = { visualDesign: visual, userConstraints: "保留黑色长发", scriptFacts: [{ sourceRef: "1:1", quote: "原文永久保留", fact: "黑色长发" }],
    characterCard: { cardId: card.id, version: card.version, name: card.name, mode: "reference", references: [] } };
  await db("o_assets").insert({ id: 10, projectId: 7, type: "role", name: "艾娃", describe: "当前人物描述", prompt: "当前图片提示词",
    descriptionVersion: 2, imageDescriptionVersion: 1, imageId: 40, descriptionMeta: JSON.stringify(meta) });
  const snapshot = await db("o_assets").where({ id: 10 }).first();
  await db("o_assets").where({ id: 10 }).update({ imageId: 41, imageDescriptionVersion: 2 });
  return { db, card, snapshot, meta };
}

test("a completed matching project picture creates a fixed image version and updates only its project binding", async t => {
  const f = await fixture(t);
  await f.db("o_assets").insert({ ...f.snapshot, id: 11, name: "其他人物" });
  const result = await syncCharacterCardAssetImage(f.db, { asset: f.snapshot, imageId: 41 });
  assert.equal(result.synced, true); assert.equal(result.version, 2);
  const card = await getCharacterCard(f.db, f.card.id, 1);
  assert.equal(card?.imagePath, "/new-paid.jpg"); assert.equal(card?.version, 2); assert.equal(card?.imageState, "ready");
  assert.equal((await getCharacterCard(f.db, f.card.id, 1, 1))?.imagePath, null, "the old adopted library snapshot is immutable");
  const live = await f.db("o_assets").where({ id: 10 }).first(), meta = JSON.parse(live.descriptionMeta);
  assert.equal(meta.characterCard.version, 2); assert.equal(meta.characterCard.imageId, result.imageId); assert.equal(meta.characterCard.sourceImageId, 41);
  assert.deepEqual(meta.scriptFacts, f.meta.scriptFacts); assert.equal(meta.userConstraints, f.meta.userConstraints);
  assert.equal(JSON.parse((await f.db("o_assets").where({ id: 11 }).first()).descriptionMeta).characterCard.version, 1);
  assert.equal((await f.db("o_image").where({ id: 40 }).first()).filePath, "/old-paid.jpg");
  assert.equal(live.imageId, 41); assert.equal((await listCharacterCardImages(f.db, f.card.id, 1))[0].sourceImageId, 41);
});

test("adopting the same project image again does not duplicate media or increase the card version", async t => {
  const f = await fixture(t);
  await syncCharacterCardAssetImage(f.db, { asset: f.snapshot, imageId: 41 });
  const live = await f.db("o_assets").where({ id: 10 }).first();
  const repeated = await syncCharacterCardAssetImage(f.db, { asset: live, imageId: 41 });
  assert.equal(repeated.synced, true); assert.equal(repeated.duplicate, true);
  assert.equal((await listCharacterCardImages(f.db, f.card.id, 1)).length, 1);
  assert.equal((await getCharacterCard(f.db, f.card.id, 1))?.version, 2);
});

test("a newer project picture preserves the card's already ready picture and its immutable snapshot", async t => {
  const f = await fixture(t);
  await syncCharacterCardAssetImage(f.db, { asset: f.snapshot, imageId: 41 });
  const snapshot = await f.db("o_assets").where({ id: 10 }).first();
  await f.db("o_image").insert({ id: 42, assetsId: 10, type: "role", state: "已完成", filePath: "/next-paid.jpg", descriptionVersion: 2 });
  await f.db("o_assets").where({ id: 10 }).update({ imageId: 42 });
  const synced = await syncCharacterCardAssetImage(f.db, { asset: snapshot, imageId: 42 });
  assert.equal(synced.synced, false); assert.equal(synced.reason, "image_ready");
  assert.equal((await getCharacterCard(f.db, f.card.id, 1, 2))?.imagePath, "/new-paid.jpg");
  assert.equal((await getCharacterCard(f.db, f.card.id, 1))?.version, 2);
  assert.equal((await getCharacterCard(f.db, f.card.id, 1))?.imagePath, "/new-paid.jpg");
  assert.equal((await listCharacterCardImages(f.db, f.card.id, 1)).length, 1);
  assert.equal((await f.db("o_image")).length, 3);
  const live = await f.db("o_assets").where({ id: 10 }).first();
  assert.equal(live.imageId, 42); assert.equal(JSON.parse(live.descriptionMeta).characterCard.version, 2);
});

for (const changed of ["description", "binding", "card_version", "design", "old_image", "unselected_image", "unfinished_image"] as const) {
  test(`${changed}: late or incompatible pictures stay in the project without entering the card library`, async t => {
    const f = await fixture(t);
    if (changed === "description") await f.db("o_assets").where({ id: 10 }).update({ descriptionVersion: 3 });
    if (changed === "binding") await f.db("o_assets").where({ id: 10 }).update({ descriptionMeta: JSON.stringify({ ...f.meta, characterCard: { ...f.meta.characterCard, version: 2 } }) });
    if (changed === "card_version") await saveCharacterCard(f.db, { ...f.card, name: "人工更新后的卡" }, 1);
    if (changed === "design") await f.db("o_assets").where({ id: 10 }).update({ descriptionMeta: JSON.stringify({ ...f.meta, visualDesign: { ...visual, clothing: "不同衣装" } }) });
    if (changed === "old_image") await f.db("o_image").where({ id: 41 }).update({ descriptionVersion: 1 });
    if (changed === "unselected_image") await f.db("o_assets").where({ id: 10 }).update({ imageId: 40 });
    if (changed === "unfinished_image") await f.db("o_image").where({ id: 41 }).update({ state: "生成中" });
    const liveBefore = await f.db("o_assets").where({ id: 10 }).first();
    const result = await syncCharacterCardAssetImage(f.db, { asset: f.snapshot, imageId: 41 });
    assert.equal(result.synced, false);
    assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), liveBefore);
    assert.equal((await listCharacterCardImages(f.db, f.card.id, 1)).length, 0);
    assert.equal((await getCharacterCard(f.db, f.card.id, 1))?.imagePath, null);
  });
}

test("a paid in-flight card render is never hijacked by a project-image import", async t => {
  const f = await fixture(t);
  const running = await beginCharacterCardImage(f.db, { cardId: f.card.id, baseVersion: 1, ownerId: 1, prompt: "付费绘图任务", model: "qwen", resolution: "1K" });
  const result = await syncCharacterCardAssetImage(f.db, { asset: f.snapshot, imageId: 41 });
  assert.equal(result.reason, "image_running");
  const attempts = await listCharacterCardImages(f.db, f.card.id, 1);
  assert.equal(attempts.length, 1); assert.equal(attempts[0].id, running.id); assert.equal(attempts[0].state, "running");
  assert.equal(attempts[0].filePath, null); assert.equal(attempts[0].sourceImageId, null);
});

test("a sync failure rolls back its savepoint while preserving the successfully saved project picture", async t => {
  const f = await fixture(t); t.mock.method(console, "warn", () => {});
  await f.db.raw("CREATE TRIGGER deny_card_binding BEFORE UPDATE OF descriptionMeta ON o_assets BEGIN SELECT RAISE(ABORT, 'sync denied'); END");
  await f.db.transaction(async trx => {
    await trx("o_image").where({ id: 41 }).update({ resolution: "saved-project-image" });
    await syncCharacterCardAssetImageSafely(trx, { asset: f.snapshot, imageId: 41 });
  });
  assert.equal((await getCharacterCard(f.db, f.card.id, 1))?.version, 1);
  assert.equal((await listCharacterCardImages(f.db, f.card.id, 1)).length, 0);
  assert.equal((await f.db("o_image").where({ id: 41 }).first()).state, "已完成");
  assert.equal((await f.db("o_image").where({ id: 41 }).first()).resolution, "saved-project-image");
  assert.equal((await f.db("o_assets").where({ id: 10 }).first()).imageId, 41);
});
