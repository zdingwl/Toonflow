import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { expandH3AssetSlots } from "../src/utils/h3ReferenceSlots";
import { copyH3ReferencePlan, h3SlotPath, loadH3ReferencePlan, resolveH3ReferencePlan, saveH3ReferencePlan } from "../src/utils/h3ReferencePlan";

const items = [
  { id: 1, type: "role", name: "艾娃", filePath: "/sheet.png", faceReferencePath: "/face.png", fullBodyReferencePath: "/front.png", sideReferencePath: "/side.png", backReferencePath: "/back.png" },
  { id: 2, type: "scene", name: "甲板", filePath: "/deck.png" },
];
const prompt = "<Picture 1> depicts Ava. <Picture 2> depicts the deck.";
function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(async () => { await db.destroy(); });
  return db;
}

test("H3 paths use full boards while historical crop paths remain readable", () => {
  assert.equal(h3SlotPath({ ...items[0], _referenceRole: "FULL_BODY_FRONT" }), "/front.png");
  assert.equal(h3SlotPath(items[1]), "/deck.png");
  assert.equal(h3SlotPath(items[0]), "/sheet.png");
  assert.throws(() => h3SlotPath({ ...items[0], _referenceRole: "FACE", faceReferencePath: null }), /缺少脸部身份参考/);
});

test("concurrent lazy saves use one exact-prompt plan and leave other prompts and tracks separate", async t => {
  const db = fixture(t), slots = expandH3AssetSlots(items);
  await Promise.all(Array.from({ length: 8 }, () => saveH3ReferencePlan(db, 100, prompt, slots)));
  assert.equal((await db("o_h3ReferencePlan")).length, 1);
  const loaded = await loadH3ReferencePlan(db, 100, prompt);
  assert.deepEqual(loaded?.slots.map(slot => [slot.assetId, slot.kind, slot.path]), [[1, undefined, "/sheet.png"], [2, undefined, "/deck.png"]]);
  assert.equal(await loadH3ReferencePlan(db, 101, prompt), null);
  assert.equal(await loadH3ReferencePlan(db, 100, `${prompt} `), null);
});

test("runtime restores saved order independently of upload ordering and accepts runtime field aliases", async t => {
  const db = fixture(t), plan = await saveH3ReferencePlan(db, 100, prompt, expandH3AssetSlots(items));
  const runtime = resolveH3ReferencePlan([
    { assetId: 2, assetType: "scene", sourceType: "assets", path: "/deck.png", label: "甲板" },
    { ...items[0], id: undefined, assetId: 1, type: undefined, assetType: "role", path: "/sheet.png", sourceType: "assets", prompt: "generated prose mentions all four views" },
    { assetId: 9, assetType: "audio", fileType: "audio", path: "/voice.mp3", sourceType: "assets" },
    { id: 10, type: "tool", _fileType: "video", filePath: "/clip.mp4" },
    { id: 11, _type: "storyboard", filePath: "/guide.png" },
    { id: 12, _type: "assets", type: "tool", _reference: false, filePath: "/unselected.png" },
  ], plan);
  assert.deepEqual(runtime.map(item => item.path), ["/sheet.png", "/deck.png"]);
  assert.ok(runtime.every(item => item.fileType === "image" && item.sourceType === "assets" && item.referenceType === "imageReference"));
  assert.deepEqual(runtime.map(item => item.referenceKind), [undefined, undefined]);
});

test("changed image asset sets, asset types, selected boards and missing boards require regeneration", async t => {
  const db = fixture(t), plan = await saveH3ReferencePlan(db, 100, prompt, expandH3AssetSlots(items));
  assert.throws(() => resolveH3ReferencePlan([items[0]], plan), /资产集合.*重新生成/);
  assert.throws(() => resolveH3ReferencePlan([...items, { id: 3, type: "tool", filePath: "/new.png" }], plan), /资产集合.*重新生成/);
  assert.throws(() => resolveH3ReferencePlan([{ ...items[0], filePath: "/new-sheet.png" }, items[1]], plan), /参考图片已变化.*重新生成/);
  assert.throws(() => resolveH3ReferencePlan([{ ...items[0], filePath: null }, items[1]], plan), /缺少图片/);
  assert.throws(() => resolveH3ReferencePlan([items[0], { ...items[1], type: "tool" }], plan), /资产类型已变化/);
});

test("same prompt cannot silently rebind its existing reference plan", async t => {
  const db = fixture(t), before = await saveH3ReferencePlan(db, 100, prompt, expandH3AssetSlots(items));
  await assert.rejects(saveH3ReferencePlan(db, 100, prompt, expandH3AssetSlots([{ ...items[0], filePath: "/new-sheet.png" }, items[1]])), /不可覆盖历史计划/);
  assert.deepEqual(await loadH3ReferencePlan(db, 100, prompt), before);
});

test("translation and manual wording changes copy the plan without re-reading directional prose", async t => {
  const db = fixture(t), before = await saveH3ReferencePlan(db, 100, prompt, expandH3AssetSlots(items));
  const translated = "<Picture 1>是艾娃。<Picture 2>是甲板。艾娃侧身背对镜头。";
  assert.deepEqual(await copyH3ReferencePlan(db, 100, prompt, translated), before);
  assert.deepEqual(await loadH3ReferencePlan(db, 100, translated), before);
  const spokenLabel = translated + ' <d>[English] The printed label is <Picture 99>.</d>';
  assert.deepEqual(await copyH3ReferencePlan(db, 100, prompt, spokenLabel), before);
  assert.deepEqual(resolveH3ReferencePlan(items, (await loadH3ReferencePlan(db, 100, translated))!).map(item => item.path), ["/sheet.png", "/deck.png"]);
  await assert.rejects(copyH3ReferencePlan(db, 100, prompt, translated.replace("<Picture 2>", "<Picture 3>")), /参考图编号已变化/);
  await assert.rejects(copyH3ReferencePlan(db, 100, prompt, "<Picture 1> only"), /参考图编号已变化/);
  assert.equal(await copyH3ReferencePlan(db, 100, "legacy prompt", "edited legacy prompt"), null);
});

test("stored corrupt or duplicate slot plans fail closed", async t => {
  const db = fixture(t), slots = expandH3AssetSlots(items);
  await assert.rejects(saveH3ReferencePlan(db, 100, prompt, [...slots, slots[0]]), /重复槽位/);
  await saveH3ReferencePlan(db, 100, prompt, slots);
  await db("o_h3ReferencePlan").update({ plan: '{"version":1,"slots":[{"assetId":1}]}' });
  await assert.rejects(loadH3ReferencePlan(db, 100, prompt), /计划无法读取/);
});
