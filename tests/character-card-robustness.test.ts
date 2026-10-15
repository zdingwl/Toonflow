import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { characterCardProfile } from "../src/utils/characterCardProfile";
import { migrateCharacterCards, searchCharacterCards, saveGeneratedCharacterCard, validateCharacterCardInput } from "../src/utils/characterCards";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";

const visual = { face: "自然椭圆脸与清晰眉眼", body: "成年自然比例", hair: "黑色长发", clothing: "白色衬衫与灰色长裤", environment: "", shape: "" };
async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await migrateCharacterCards(db);
  return db;
}

test("direct source confirmation of adulthood supports an adult card without inventing an exact age", async t => {
  const db = await fixture(t);
  const profile = characterCardProfile([{ fact: "成年女性" }], "");
  assert.equal(profile.ageMin, 18);
  assert.equal(profile.ageMax, null);
  const saved = await saveGeneratedCharacterCard(db, { name: "原文明示成年的人物", artStyle: "realistic_3d_anime", roleDefinition: "成年女性",
    ...profile, ownerId: 1, visualDesign: visual });
  assert.equal(saved.ageBand, "adult");
});

test("a denied or unconfirmed adult setting does not become confirmation", () => {
  for (const userConstraints of ["本角色未确认成年", "本角色不是成年人物", "本角色不能设定为成年"]) {
    const profile = characterCardProfile([], userConstraints);
    assert.equal(profile.ageMin, null, userConstraints);
    assert.equal(profile.ageMax, null, userConstraints);
    assert.equal(profile.ageBand, "unknown", userConstraints);
  }
});

test("negative adult design constraints save an unknown-age card without inventing an age", async t => {
  const db = await fixture(t);
  const bodies = ["自然匀称的女性比例，肩线舒展，站姿端正克制；不使用成人胸腰臀夸张曲线或性感裸露设计",
    "自然比例，不采用成人体态", "自然比例，不套用成人特征", "自然比例，不表现成年年龄特征",
    "自然比例，不是成年人物，不据此推定精确年龄", "自然比例，不采用成人或儿童外观"];
  for (const [index, body] of bodies.entries()) {
    const saved = await saveGeneratedCharacterCard(db, { name: `年龄未确认的外观${index}`, artStyle: "realistic_3d_anime",
      roleDefinition: "女性，年龄未确认", ageBand: "unknown", gender: "female", ownerId: 1, visualDesign: { ...visual, body } });
    assert.equal(saved.ageBand, "unknown", body);
    assert.equal(saved.ageMin, null, body);
    assert.equal(saved.ageMax, null, body);
    assert.equal(saved.visualDesign.body, body, "a validation fix preserves the original design instead of rewriting it");
  }
});

test("an unrelated negation cannot hide a later positive age assertion in unknown-age visual design", () => {
  for (const body of ["成年自然体态", "中年自然比例", "儿童自然体态", "不是成年而是儿童自然体态",
    "不使用成人特征，采用儿童自然体态", "不推断成年身份但采用老年体态", "不使用成人特征且保留儿童自然比例", "not adult but child proportions"]) {
    assert.throws(() => validateCharacterCardInput({ name: "年龄未确认", artStyle: "realistic_3d_anime", roleDefinition: "年龄未知的人物",
      ageBand: "unknown", visualDesign: { ...visual, body } }), /明确年龄特征/, body);
  }
});

test("explicit age ranges preserve both bounds rather than silently using the final number", () => {
  for (const fact of ["年龄20至25岁", "年龄二十至二十五岁", "年龄20-25岁"]) {
    const profile = characterCardProfile([{ fact }], "");
    assert.equal(profile.ageMin, 20, fact);
    assert.equal(profile.ageMax, 25, fact);
  }
});

test("explicit heroine customization filters gender while negative gender settings remain unknown", () => {
  assert.equal(characterCardProfile([], "本角色确认18岁以上，上层社会富家女主角造型").gender, "female");
  assert.equal(characterCardProfile([], "本角色不是女性，不要设为男性").gender, "unknown");
});

test("explicit source age categories generate compatible cards without invented numeric ages", async t => {
  const db = await fixture(t);
  for (const [fact, band, body] of [["儿童", "child", "儿童自然体态"], ["少年男性", "teen", "少年自然体态"],
    ["中年女性", "middle", "中年自然体态"], ["老年女性", "elderly", "老年自然体态"]]) {
    const profile = characterCardProfile([{ fact }], "");
    assert.equal(profile.ageBand, band); assert.equal(profile.ageMin, null); assert.equal(profile.ageMax, null);
    const card = await saveGeneratedCharacterCard(db, { name: fact, roleDefinition: fact, artStyle: "realistic_3d_anime",
      ...profile, ownerId: 1, visualDesign: { ...visual, body } });
    assert.equal(card.ageBand, band);
  }
  assert.throws(() => characterCardProfile([{ fact: "儿童，8岁" }], "本角色确认18岁以上"), /冲突/);
});

test("40-plus source bounds allow compatible elderly reference cards", async t => {
  const db = await fixture(t), profile = characterCardProfile([{ fact: "女性，40岁以上" }], "");
  assert.equal(profile.ageMin, 40);
  assert.equal(profile.ageMax, null);
  const candidates = await searchCharacterCards(db, { ...profile, ageBand: profile.searchAgeBand, ownerId: 1,
    artStyle: "realistic_3d_anime", roleDefinition: "老年女性，长者，温和坚定，日常生活" });
  assert.ok(candidates.some(card => card.ageBand === "elderly"), "an open lower bound cannot acquire a middle-age upper bound");
});

test("source below 18 is not classified as an adult and never searches adult references", async t => {
  const db = await fixture(t), profile = characterCardProfile([{ fact: "女性，18岁以下" }], "");
  assert.notEqual(profile.ageBand, "adult");
  const cards = await searchCharacterCards(db, { ...profile, ageBand: profile.searchAgeBand, ownerId: 1,
    artStyle: "realistic_3d_anime", roleDefinition: "日常人物" });
  assert.ok(cards.every(card => card.ageBand !== "adult" && card.ageBand !== "middle" && card.ageBand !== "elderly"));
});

test("full reuse supplies the entire selected design instead of only a partial face and hair reference", async t => {
  const db = await fixture(t);
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content"); table.integer("extractState"); table.text("errorReason");
  });
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); table.primary(["scriptId", "assetId"]); });
  await migrateAssetDescriptions(db);
  await db("o_script").insert({ id: 1, projectId: 7, name: "一集", content: "艾娃是女性，25岁，黑色长发。" });
  let finalInput: any;
  const invoke = async (request: any) => {
    const input = JSON.parse(request.messages[0].content), schema = await request.tools.resultTool.inputSchema.jsonSchema;
    let result: any;
    if (schema.properties.newAssets) result = { newAssets: [{ name: "艾娃", type: "role", desc: "女性", scriptIds: [1] }], existingAssetRefs: [] };
    else if (schema.properties.decisions) result = { decisions: input.candidates.map((candidate: any) => ({ candidateId: candidate.candidateId, retain: true })) };
    else if (schema.properties.mode) result = { mode: "reuse", references: [{ cardId: input.candidates[0].id,
      version: input.candidates[0].version, borrowedFields: ["face", "hair"] }] };
    else if (schema.properties.describe) {
      finalInput = input;
      result = { describe: "自然眉眼，黑色长发，白色衬衫与灰色长裤", visualDesign: visual,
        scriptFacts: input.verifiedFacts, conflicts: [], characterDefinition: "成年女性，日常人物" };
    } else result = { scriptFacts: [{ sourceRef: "1:1", fact: "女性" }, { sourceRef: "1:1", fact: "25岁" }] };
    await request.tools.resultTool.execute(result, {});
    return { finishReason: "tool-calls" };
  };
  await extractScriptAssets({ db, invoke, system: "按照剧本生成一张完整角色卡", characterCards: { artStyle: "realistic_3d_anime", ownerId: 1 } },
    { projectId: 7, scriptIds: [1] });
  assert.equal(finalInput.cardMatchMode, "reuse");
  assert.ok(finalInput.referenceCards[0].visualDesign.body, "full reuse must give the final writer the selected body");
  assert.ok(finalInput.referenceCards[0].visualDesign.clothing, "full reuse must give the final writer the selected outfit");
});
