import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  archiveCharacterCard, characterCardFromAsset, characterCardSummary, getCharacterCard, listCharacterCards,
  migrateCharacterCards, saveCharacterCard, saveGeneratedCharacterCard, searchCharacterCards,
  type CharacterCardInput,
} from "../src/utils/characterCards";

async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await migrateCharacterCards(db);
  return db;
}
const card = (overrides: Partial<CharacterCardInput> = {}): CharacterCardInput => ({
  name: "测试角色卡", artStyle: "realistic_3d_anime", roleDefinition: "成年女性，理性沉稳，现代都市", ageBand: "adult", gender: "female",
  visualDesign: { face: "自然椭圆脸，清晰杏眼", body: "成年自然体态", hair: "黑色齐肩发", clothing: "灰蓝外套、白色内搭、深灰长裤、黑色平底鞋", environment: "", shape: "" },
  describe: "", ...overrides,
});

test("migration seeds ten complete cards once; known bands do not invent numerical ages", async t => {
  const db = await fixture(t);
  await migrateCharacterCards(db);
  const cards = await listCharacterCards(db, { ownerId: 1 });
  assert.equal(cards.length, 10);
  assert.equal((await db("o_characterCardVersion")).length, 10);
  const bandOnly = await saveCharacterCard(db, card(), 1);
  assert.equal(bandOnly.ageMin, null);
  assert.equal(bandOnly.ageMax, null);
  assert.ok(cards.some(item => item.ageBand === "unknown" && item.ageMin === null && item.ageMax === null));
  assert.ok(cards.every(item => item.ownerId === 0 && item.provenance.method === "seed" && item.visualDesign.face && item.visualDesign.clothing));
});

test("search hard filters style, explicit age and owner before ranking and caps three candidates", async t => {
  const db = await fixture(t);
  const target = await saveCharacterCard(db, card({ roleDefinition: "成年女性，宇航员，理性沉稳", ageMin: 25, ageMax: 25 }), 1);
  await saveCharacterCard(db, card({ roleDefinition: target.roleDefinition, artStyle: "anime" }), 1);
  await saveCharacterCard(db, card({ roleDefinition: target.roleDefinition, ageBand: "middle", ageMin: 50, ageMax: 50 }), 1);
  const foreign = await saveCharacterCard(db, card({ roleDefinition: target.roleDefinition, ageMin: 25, ageMax: 25 }), 2);
  const results = await searchCharacterCards(db, { artStyle: "realistic_3d_anime", roleDefinition: target.roleDefinition, ageMin: 25, ageMax: 25, gender: "女性", ownerId: 1, limit: 20 });
  assert.ok(results.length <= 3);
  assert.equal(results[0].id, target.id);
  assert.equal(results[0].matchKind, "full");
  assert.ok(results.every(item => item.artStyle === target.artStyle && item.ageBand === "adult" && item.gender === "female" && item.id !== foreign.id));
  assert.equal(await getCharacterCard(db, foreign.id, 1), null);
  const teens = await searchCharacterCards(db, { artStyle: target.artStyle, roleDefinition: "学生", ageMin: 16, ageMax: 16, ownerId: 1 });
  assert.ok(teens.length > 0 && teens.every(item => item.ageBand === "teen"));
});

test("18-plus lower bound accepts middle and elderly candidates without inventing an upper age", async t => {
  const db = await fixture(t);
  const elder = await saveCharacterCard(db, card({ ageBand: "elderly", ageMin: 70, ageMax: 70, roleDefinition: "成年女性，宇航员，理性沉稳" }), 1);
  const results = await searchCharacterCards(db, { artStyle: elder.artStyle, roleDefinition: elder.roleDefinition, ageMin: 18, ownerId: 1 });
  assert.equal(results[0].id, elder.id);
  assert.ok(results.every(item => item.ageBand !== "child" && item.ageBand !== "teen" && item.ageBand !== "unknown"));
  const adult = await saveCharacterCard(db, card({ ageMin: 18, ageMax: null }), 1);
  assert.equal(adult.ageMax, null);
});

test("unknown age never searches adult cards and unknown bands cannot imply exact ages", async t => {
  const db = await fixture(t);
  const results = await searchCharacterCards(db, { artStyle: "realistic_3d_anime", roleDefinition: "都市女主", ownerId: 1 });
  assert.ok(results.length > 0);
  assert.ok(results.every(item => item.ageBand === "unknown" && item.ageMin === null));
  await assert.rejects(saveCharacterCard(db, card({ ageBand: "unknown", ageMin: 25 }), 1), /年龄未知/);
  await assert.rejects(saveCharacterCard(db, card({ ageBand: "teen", ageMin: 18 }), 1), /年龄范围/);
});

test("known female targets can reference unknown neutral templates, while explicit male designs are excluded", async t => {
  const db = await fixture(t);
  const male = await saveCharacterCard(db, card({ ageBand: "unknown", gender: "male", roleDefinition: "女性，现代日常",
    visualDesign: { ...card().visualDesign, body: "自然体态" } }), 1);
  const results = await searchCharacterCards(db, { artStyle: "realistic_3d_anime", roleDefinition: "女性，现代日常", ageBand: "unknown", gender: "female", ownerId: 1 });
  assert.ok(results.some(item => item.gender === "unknown"));
  assert.ok(results.every(item => item.id !== male.id && item.gender !== "male"));
  const strictUiList = await listCharacterCards(db, { ageBand: "unknown", gender: "female", ownerId: 1 });
  assert.ok(strictUiList.every(item => item.gender === "female"), "the UI list remains a strict gender filter");
});

test("partial definitions provide existing-card reference candidates and short summaries", async t => {
  const db = await fixture(t);
  const results = await searchCharacterCards(db, { artStyle: "realistic_3d_anime", roleDefinition: "成年女性，机械研究员，冷静专注", ageBand: "adult", gender: "female", ownerId: 1 });
  assert.ok(results.length > 0 && results.some(item => item.matchKind === "reference"));
  const summary = characterCardSummary(results[0]);
  assert.ok(summary.face.length <= 100 && summary.clothing.length <= 140);
  assert.equal("visualDesign" in summary, false);
});

test("search ranks all compatible cards instead of stopping at the newest five hundred", async t => {
  const db = await fixture(t);
  const target = await saveCharacterCard(db, card({ roleDefinition: "女性，星际机械设计师，沉稳专注" }), 1);
  const filler = { ownerId: 1, seedKey: null, generationKey: null, name: "普通参考", artStyle: "realistic_3d_anime", roleDefinition: "女性，现代居民",
    ageBand: "adult", ageMin: null, ageMax: null, gender: "female", visualDesign: JSON.stringify(card().visualDesign),
    describe: "完整参考设计", status: "active", version: 1, provenance: JSON.stringify({ method: "manual", references: [] }), createdAt: Date.now(), updatedAt: Date.now() };
  for (let index = 0; index < 6; index++) await db("o_characterCard").insert(Array.from({ length: 100 }, (_, offset) => ({ ...filler, name: `普通参考${index * 100 + offset}` })));
  const results = await searchCharacterCards(db, { artStyle: target.artStyle, roleDefinition: target.roleDefinition, ageBand: "adult", gender: "female", ownerId: 1 });
  assert.equal(results[0].id, target.id);
  assert.equal(results.length, 3);
});

test("library role-definition and appearance keyword filters combine without overriding each other", async t => {
  const db = await fixture(t);
  const target = await saveCharacterCard(db, card({ name: "研究员参考", roleDefinition: "女性，机械研究员",
    visualDesign: { ...card().visualDesign, hair: "银灰色高马尾，清楚发束轮廓" }, describe: "研究员外观，琥珀色虹膜" }), 1);
  await saveCharacterCard(db, card({ name: "医生参考", roleDefinition: "女性，医生",
    visualDesign: { ...card().visualDesign, hair: "银灰色高马尾，清楚发束轮廓" } }), 1);
  const byHair = await listCharacterCards(db, { roleDefinition: "机械研究员", keyword: "银灰色高马尾", ownerId: 1 });
  assert.deepEqual(byHair.map(item => item.id), [target.id]);
  const byDescription = await listCharacterCards(db, { roleDefinition: "机械研究员", keyword: "琥珀色虹膜", ownerId: 1 });
  assert.deepEqual(byDescription.map(item => item.id), [target.id]);
  assert.deepEqual(await listCharacterCards(db, { roleDefinition: "医生", keyword: "琥珀色虹膜", ownerId: 1 }), []);
});

test("editing or archiving preserves adopted immutable versions and rejects foreign/seed writes", async t => {
  const db = await fixture(t);
  const original = await saveCharacterCard(db, card(), 1);
  const updated = await saveCharacterCard(db, { ...original, name: "更新角色卡", visualDesign: { ...original.visualDesign, hair: "栗色短发" } }, 1);
  assert.equal(updated.version, 2);
  assert.equal((await getCharacterCard(db, original.id, 1, 1))!.visualDesign.hair, original.visualDesign.hair);
  await assert.rejects(saveCharacterCard(db, { ...original, name: "过时请求" }, 1), /已更新/);
  await assert.rejects(saveCharacterCard(db, updated, 2), /其他用户/);
  const seed = (await listCharacterCards(db, { ownerId: 1 })).find(item => item.ownerId === 0)!;
  await assert.rejects(saveCharacterCard(db, seed, 1), /只读预置/);
  const archived = await archiveCharacterCard(db, updated.id, 1, 2);
  assert.equal(archived.version, 3);
  assert.equal(archived.status, "archived");
  assert.ok(!(await listCharacterCards(db, { ownerId: 1 })).some(item => item.id === original.id));
  assert.equal((await getCharacterCard(db, original.id, 1, 2))!.status, "active");
});

test("generated cards retain only selected reference fields and are idempotent by source design", async t => {
  const db = await fixture(t);
  const reference = (await listCharacterCards(db, { ownerId: 1 })).find(item => item.ageBand === "adult")!;
  const input = { ...card(), ownerId: 1, sourceProjectId: 7, sourceAssetId: 9,
    describe: "别的项目原句不得复制", provenance: { quote: "别的项目原句", scriptFacts: [{ quote: "不复制" }],
      references: [{ cardId: reference.id, version: 1, borrowedFields: ["face", "hair"], quote: "不复制" }] } };
  const saved = await saveGeneratedCharacterCard(db, input);
  assert.deepEqual(saved.provenance, { method: "generated", references: [{ cardId: reference.id, version: 1, borrowedFields: ["face", "hair"] }] });
  assert.ok(!saved.describe.includes("原句"));
  const again = await saveGeneratedCharacterCard(db, input);
  assert.equal(again.id, saved.id);
  await saveCharacterCard(db, { ...saved, visualDesign: { ...saved.visualDesign, hair: "手动更新" } }, 1);
  assert.equal((await saveGeneratedCharacterCard(db, input)).visualDesign.hair, saved.visualDesign.hair);
  assert.equal((await saveGeneratedCharacterCard(db, input)).version, 1);
  const foreign = await saveCharacterCard(db, card(), 2);
  await assert.rejects(saveGeneratedCharacterCard(db, { ...input, sourceAssetId: 10,
    provenance: { references: [{ cardId: foreign.id, version: 1, borrowedFields: ["face"] }] } }), /无权访问/);
});

test("generated card joins the caller transaction and rolls back with failed project persistence", async t => {
  const db = await fixture(t);
  await assert.rejects(db.transaction(async tx => {
    const saved = await saveGeneratedCharacterCard(tx, { ...card(), ownerId: 1, sourceProjectId: 4, sourceAssetId: 5 });
    assert.equal(saved.version, 1);
    throw new Error("asset write failed");
  }), /asset write failed/);
  assert.equal((await db("o_characterCard").where({ ownerId: 1 })).length, 0);
  assert.equal((await db("o_characterCardVersion")).length, 10);
});

test("fromAsset copies visible design while preserving source facts, constraints and images in the project", async t => {
  const db = await fixture(t);
  await db.schema.createTable("o_project", table => { table.integer("id"); table.integer("userId"); table.text("artStyle"); });
  await db.schema.createTable("o_assets", table => {
    table.integer("id"); table.integer("projectId"); table.integer("imageId"); table.text("name"); table.text("type"); table.text("describe"); table.text("descriptionMeta");
  });
  await db("o_project").insert({ id: 4, userId: 1, artStyle: "realistic_3d_anime" });
  const source = { id: 5, projectId: 4, imageId: 99, name: "艾娃", type: "role", describe: "其他项目人物关系与剧情",
    descriptionMeta: JSON.stringify({ visualDesign: { ...card().visualDesign, body: "自然体态" }, scriptFacts: [{ quote: "原文永久保留" }], userConstraints: "用户要求保留" }) };
  await db("o_assets").insert(source);
  await assert.rejects(characterCardFromAsset(db, { assetId: 5 }, 2), /无权/);
  await assert.rejects(characterCardFromAsset(db, { assetId: 5, projectId: 6 }, 1), /不存在/);
  const saved = await characterCardFromAsset(db, { assetId: 5, projectId: 4 }, 1);
  assert.equal(saved.ageBand, "unknown");
  assert.equal(saved.ageMin, null);
  assert.equal(saved.roleDefinition, "人物外观参考");
  assert.deepEqual(saved.visualDesign, { ...card().visualDesign, body: "自然体态" });
  assert.ok(!JSON.stringify(saved).includes("原文永久保留") && !JSON.stringify(saved).includes("用户要求保留"));
  assert.deepEqual(await db("o_assets").where({ id: 5 }).first(), source);
  await db("o_assets").where({ id: 5 }).update({ descriptionMeta: JSON.stringify({ visualDesign: card().visualDesign }) });
  await assert.rejects(characterCardFromAsset(db, { assetId: 5 }, 1), /请先选择/);
  const aged = await characterCardFromAsset(db, { assetId: 5, ageBand: "adult" }, 1);
  assert.equal(aged.ageBand, "adult");
  assert.equal(aged.ageMax, null);
  await db("o_assets").where({ id: 5 }).update({ descriptionMeta: JSON.stringify({ visualDesign: card().visualDesign,
    characterCard: { ageBand: "adult", ageMin: 18, ageMax: null, roleDefinition: "现代人物", gender: "female" } }) });
  const inherited = await characterCardFromAsset(db, { assetId: 5 }, 1);
  assert.equal(inherited.ageMin, 18);
  assert.equal(inherited.ageMax, null);
});
