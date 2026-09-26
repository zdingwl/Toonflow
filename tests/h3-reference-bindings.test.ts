import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { assertH3ReferenceBindings, type H3ReferenceBindingSlot } from "../src/utils/h3ReferenceBindings";
import { copyH3ReferencePlan, loadH3ReferencePlan, saveH3ReferencePlan } from "../src/utils/h3ReferencePlan";

const slots: H3ReferenceBindingSlot[] = [
  { assetId: 115, assetType: "role", kind: "FACE" },
  { assetId: 115, assetType: "role", kind: "FULL_BODY_FRONT" },
  { assetId: 118, assetType: "scene" },
];

test("free-form prompts need no subject_definitions section", () => {
  assert.doesNotThrow(() => assertH3ReferenceBindings(
    "Ava from <Picture 1> and <Picture 2> crosses the storm deck from <Picture 3>.",
    slots,
  ));
});

test("headings, section order and Markdown style are irrelevant to reference checks", () => {
  const prompt = `Preface\n\n## Camera\nTrack <Picture 3>.\n\n## Cast\nUse <Picture 2> and <Picture 1>.`;
  assert.doesNotThrow(() => assertH3ReferenceBindings(prompt, slots));
});

test("Subject labels are optional but keep their Picture mapping consistent", () => {
  assert.doesNotThrow(() => assertH3ReferenceBindings(
    "Ava <Subject 1> from <Picture 1> and <Picture 2> crosses the deck; the storm <Subject 2> uses <Picture 3>.",
    slots,
  ));
  assert.throws(() => assertH3ReferenceBindings(
    "<Subject 1> is Ava from <Picture 1>. <Subject 2> is the storm from <Picture 3>. Later <Subject 1> is treated as <Picture 2>.",
    slots,
  ), /对应关系不一致/);
  assert.throws(() => assertH3ReferenceBindings(
    "<Subject 1> is Ava from <Picture 1>. <Subject 2> is the storm from <Picture 3> and <Picture 2>.",
    slots,
    "<Subject 1> is Ava from <Picture 2>. <Subject 2> is the storm from <Picture 1> and <Picture 3>.",
  ), /翻译前后对应了不同的 Picture/);
});

test("explicit Picture tags must still match every saved upload slot", () => {
  assert.throws(() => assertH3ReferenceBindings("Use <Picture 1> and <Picture 2>.", slots), /Picture 槽位/);
  assert.throws(() => assertH3ReferenceBindings("Use <Picture 1>, <Picture 2> and <Picture 4>.", slots), /Picture 槽位/);
});

test("zero-picture text mode remains valid", () => {
  assert.doesNotThrow(() => assertH3ReferenceBindings("A woman walks through rain.", []));
});

function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(async () => { await db.destroy(); });
  return db;
}

const persistedSlots = [
  { id: 115, type: "role", _referenceRole: "FACE" as const, faceReferencePath: "/ava-face.png" },
  { id: 115, type: "role", _referenceRole: "FULL_BODY_FRONT" as const, fullBodyReferencePath: "/ava-front.png" },
  { id: 118, type: "scene", filePath: "/ocean.png" },
];

test("reference plans copy between free-form prompts with the same Picture set", async t => {
  const db = fixture(t);
  const source = "Use <Picture 1>, <Picture 2> and <Picture 3> in one continuous storm shot.";
  const saved = await saveH3ReferencePlan(db, 10, source, persistedSlots);
  const target = "# Final prompt\n<Picture 3> defines the storm; <Picture 1> and <Picture 2> define Ava.";
  assert.deepEqual(await copyH3ReferencePlan(db, 10, source, target), saved);
  assert.deepEqual(await loadH3ReferencePlan(db, 10, target), saved);
});

test("reference plan copies still reject a changed Picture set", async t => {
  const db = fixture(t);
  const source = "Use <Picture 1>, <Picture 2> and <Picture 3>.";
  await saveH3ReferencePlan(db, 10, source, persistedSlots);
  await assert.rejects(copyH3ReferencePlan(db, 10, source, "Use <Picture 1> and <Picture 2>."), /参考图编号已变化/);
  assert.equal((await db("o_h3ReferencePlan")).length, 1);
});
