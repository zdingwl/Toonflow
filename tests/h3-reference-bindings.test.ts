import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { assertH3ReferenceBindings, type H3ReferenceBindingSlot } from "../src/utils/h3ReferenceBindings";
import { copyH3ReferencePlan, loadH3ReferencePlan, saveH3ReferencePlan } from "../src/utils/h3ReferencePlan";

const fourViews: H3ReferenceBindingSlot[] = [
  { assetId: 115, assetType: "role", kind: "FACE" },
  { assetId: 115, assetType: "role", kind: "FULL_BODY_FRONT" },
  { assetId: 115, assetType: "role", kind: "FULL_BODY_SIDE" },
  { assetId: 115, assetType: "role", kind: "FULL_BODY_BACK" },
];
const twoRoles: H3ReferenceBindingSlot[] = [
  ...fourViews.slice(0, 2),
  { assetId: 117, assetType: "role", kind: "FACE" },
  { assetId: 117, assetType: "role", kind: "FULL_BODY_FRONT" },
];
const prompt = (definitions: string, detail = "<Subject 7> moves.") => `subject_definitions:
${definitions}
summary:
[reference generation] Two characters interact.
retention_analysis:
Preserve their identities.
detailed_description:
Semi-realistic 3D.
[Shot 1] ${detail}
overall_soundscape:
Wind.
non_diegetic_music:
N/A`;
const sameRole = "<Subject 7> is Ava in <Picture 1> (face), <Picture 2> (front), <Picture 3> (side), and <Picture 4> (back).";
const ava = "<Subject 7> is Ava in <Picture 1> (face) and <Picture 2> (front).";
const cole = "<Subject 3> is Cole in <Picture 3> (face) and <Picture 4> (front).";
const source = prompt(`${ava}\n${cole}`);

test("four crops of the same asset belong to one Subject independently of its number", () => {
  assert.doesNotThrow(() => assertH3ReferenceBindings(prompt(sameRole), fourViews));
});
test("different assets permit nonsequential Subjects and reordered definitions", () => {
  assert.doesNotThrow(() => assertH3ReferenceBindings(prompt(`${cole}\n${ava}`), twoRoles, source));
});
test("rejects splitting a four-view identity into separate Subjects", () => {
  const split = prompt(`${ava}\n<Subject 3> is the side and back figure in <Picture 3> and <Picture 4>.`);
  assert.throws(() => assertH3ReferenceBindings(split, fourViews), /同一资产 115.*拆成多个 Subject/);
});
test("rejects a Subject mixing crops of different characters", () => {
  assert.throws(() => assertH3ReferenceBindings(prompt(sameRole), twoRoles), /混用了不同资产/);
});
test("rejects a picture reused by a second Subject", () => {
  assert.throws(() => assertH3ReferenceBindings(prompt(`${sameRole}\n<Subject 8> is another person in <Picture 1>.`), fourViews), /多个 Subject 重复引用/);
});
test("a picture mentioned only in the shot cannot satisfy its asset binding", () => {
  const missing = prompt(ava, "<Subject 7> is shown with <Picture 3> and <Picture 4>.");
  assert.throws(() => assertH3ReferenceBindings(missing, twoRoles), /Picture 3.*唯一 Subject/);
});
test("asset images cannot be repurposed as independent keyframe anchors", () => {
  const anchors = prompt(`${ava}\n<Picture 3> is the first frame.\n<Picture 4> is the last frame.`);
  assert.throws(() => assertH3ReferenceBindings(anchors, twoRoles), /独立画面锚点/);
});
test("Audio references to Subjects and extra video-only Subjects do not create picture ownership", () => {
  const definitions = `${ava}\n<Audio 1> is the voice of <Subject 7> (S1).\n${cole}\n<Subject 12> is the bird from <Video 1>.\n<Video 1> is the motion source.`;
  assert.doesNotThrow(() => assertH3ReferenceBindings(prompt(definitions), twoRoles, source));
});
test("rejects references beyond the saved picture slots and duplicate Subject definitions", () => {
  assert.throws(() => assertH3ReferenceBindings(prompt(sameRole.replace("<Picture 4>", "<Picture 5>")), fourViews), /不存在的.*Picture 5/);
  assert.throws(() => assertH3ReferenceBindings(prompt(`${ava}\n${cole.replace("<Subject 3>", "<Subject 7>")}`), twoRoles), /重复定义/);
});
test("translation cannot swap identities while retaining exactly the same Picture numbers", () => {
  const swapped = prompt(`${ava.replace(/Picture 1/g, "Picture 3").replace(/Picture 2/g, "Picture 4")}\n${cole.replace(/Picture 3/g, "Picture 1").replace(/Picture 4/g, "Picture 2")}`);
  assert.doesNotThrow(() => assertH3ReferenceBindings(swapped, twoRoles));
  assert.throws(() => assertH3ReferenceBindings(swapped, twoRoles, source), /Subject 与资产的对应关系已变化/);
});
test("manual edits may change prose but cannot remove definitions or rename an existing Subject", () => {
  assert.doesNotThrow(() => assertH3ReferenceBindings(source.replace("Ava", "the woman").replace("moves", "turns"), twoRoles, source));
  assert.throws(() => assertH3ReferenceBindings(source.replace("subject_definitions:", "notes:"), twoRoles, source), /缺少完整/);
  assert.throws(() => assertH3ReferenceBindings(source.replaceAll("<Subject 7>", "<Subject 9>"), twoRoles, source), /对应关系已变化/);
});
test("zero-picture text mode and old unstructured source plans stay compatible", () => {
  assert.doesNotThrow(() => assertH3ReferenceBindings("A woman walks.", []));
  assert.doesNotThrow(() => assertH3ReferenceBindings("<Picture 1> and <Picture 2> depict Ava.", twoRoles, "legacy plain-text source"));
  assert.throws(() => assertH3ReferenceBindings("A woman walks.", twoRoles), /缺少完整/);
});
test("scene and prop assets also keep distinct bindings", () => {
  const slots: H3ReferenceBindingSlot[] = [{ assetId: 1, assetType: "scene" }, { assetId: 2, assetType: "tool" }];
  assert.throws(() => assertH3ReferenceBindings(prompt("<Subject 8> is the room and phone in <Picture 1> and <Picture 2>."), slots), /混用了不同资产/);
  assert.doesNotThrow(() => assertH3ReferenceBindings(prompt("<Subject 8> is the room in <Picture 1>.\n<Subject 2> is the phone in <Picture 2>."), slots));
});

function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(async () => { await db.destroy(); });
  return db;
}
const persistedSlots = [
  { id: 115, type: "role", _referenceRole: "FACE" as const, faceReferencePath: "/ava-face.png" },
  { id: 115, type: "role", _referenceRole: "FULL_BODY_FRONT" as const, fullBodyReferencePath: "/ava-front.png" },
  { id: 117, type: "role", _referenceRole: "FACE" as const, faceReferencePath: "/cole-face.png" },
  { id: 117, type: "role", _referenceRole: "FULL_BODY_FRONT" as const, fullBodyReferencePath: "/cole-front.png" },
];
test("copy rejects manual identity swaps before creating a new prompt-plan record", async t => {
  const db = fixture(t);
  const before = await saveH3ReferencePlan(db, 10, source, persistedSlots);
  const swapped = prompt(`${ava.replace("<Subject 7>", "<Subject 3>")}\n${cole.replace("<Subject 3>", "<Subject 7>")}`);
  await assert.rejects(copyH3ReferencePlan(db, 10, source, swapped), /对应关系已变化/);
  assert.equal((await db("o_h3ReferencePlan")).length, 1);
  assert.equal(await loadH3ReferencePlan(db, 10, swapped), null);
  assert.deepEqual(await loadH3ReferencePlan(db, 10, source), before);
  const translated = source.replace("Ava", "the woman").replace("Cole", "the man");
  assert.deepEqual(await copyH3ReferencePlan(db, 10, source, translated), before);
});
test("copy still accepts historical simple prompts whose picture set stays identical", async t => {
  const db = fixture(t);
  const old = "<Picture 1> and <Picture 2> show Ava. <Picture 3> and <Picture 4> show Cole.";
  const before = await saveH3ReferencePlan(db, 10, old, persistedSlots);
  assert.deepEqual(await copyH3ReferencePlan(db, 10, old, old + " They turn."), before);
});

const oceanAndSharkSlots: H3ReferenceBindingSlot[] = [
  { assetId: 115, assetType: "role", kind: "FACE" },
  { assetId: 115, assetType: "role", kind: "FULL_BODY_FRONT" },
  { assetId: 118, assetType: "scene" },
  { assetId: 124, assetType: "tool" },
  { assetId: 128, assetType: "tool" },
];
const ocean = "<Subject 2> is the ocean environment shown in <Picture 3>.";
const phone = "<Subject 3> is the smartphone shown in <Picture 4>.";
const shark = "<Subject 4> is the giant shark shown in <Picture 5>, the same creature also visible as a scale reference within <Picture 3>.";

test("the actual ocean-and-shark cross-reference is valid regardless of scene definition order", () => {
  for (const definitions of [
    [ava, ocean, phone, shark],
    [ava, shark, phone, ocean],
  ]) {
    const original = prompt(definitions.join("\n"));
    assert.doesNotThrow(() => assertH3ReferenceBindings(original, oceanAndSharkSlots));
    const translated = original.replace("same creature also visible as a scale reference", "same shark visible in the background");
    assert.doesNotThrow(() => assertH3ReferenceBindings(translated, oceanAndSharkSlots, original));
  }
});

test("role and creature Subjects may mention an independently bound environment as context", () => {
  const slots: H3ReferenceBindingSlot[] = [
    { assetId: 10, assetType: "character", kind: "FULL_BODY_FRONT" },
    { assetId: 20, assetType: "environment" },
    { assetId: 30, assetType: "creature" },
  ];
  const definitions = [
    "<Subject 1> is Ava from <Picture 1>, also standing within the setting of <Picture 2>.",
    "<Subject 3> is the shark from <Picture 3>, also visible in <Picture 2>.",
    "<Subject 2> is the ocean from <Picture 2>.",
  ].join("\n");
  assert.doesNotThrow(() => assertH3ReferenceBindings(prompt(definitions), slots));
});

test("a scene mentioned only as context cannot be merged into a character or prop Subject", () => {
  for (const assetType of ["role", "tool"]) {
    const slots: H3ReferenceBindingSlot[] = [
      { assetId: 10, assetType, ...(assetType === "role" ? { kind: "FULL_BODY_FRONT" as const } : {}) },
      { assetId: 20, assetType: "scene" },
    ];
    assert.throws(() => assertH3ReferenceBindings(
      prompt("<Subject 1> is the subject in <Picture 1> and the setting in <Picture 2>."), slots,
    ), /背景场景仍需独立 Subject/);
  }
});

test("context cannot substitute for a scene's own missing slot coverage", () => {
  const slots: H3ReferenceBindingSlot[] = [
    { assetId: 10, assetType: "tool" },
    { assetId: 20, assetType: "scene" },
    { assetId: 20, assetType: "scene" },
  ];
  const definitions = [
    "<Subject 1> is the shark in <Picture 1>, also visible in <Picture 3>.",
    "<Subject 2> is the ocean in <Picture 2>.",
  ].join("\n");
  assert.throws(() => assertH3ReferenceBindings(prompt(definitions), slots), /Picture 3.*唯一 Subject/);
});

test("a scene's primary Subject cannot absorb another scene, character or prop even if it has a separate owner", () => {
  for (const otherType of ["role", "tool", "scene"]) {
    const slots: H3ReferenceBindingSlot[] = [
      { assetId: 10, assetType: "scene" },
      { assetId: 20, assetType: otherType, ...(otherType === "role" ? { kind: "FULL_BODY_FRONT" as const } : {}) },
    ];
    const definitions = "<Subject 1> is the room from <Picture 1> and <Picture 2>.\n<Subject 2> is another asset from <Picture 2>.";
    assert.throws(() => assertH3ReferenceBindings(prompt(definitions), slots), /混用了不同资产/);
  }
});

test("a separate owner never permits contextual cross-reference to another role or prop", () => {
  for (const otherType of ["role", "tool"]) {
    const slots: H3ReferenceBindingSlot[] = [
      { assetId: 10, assetType: "role", kind: "FULL_BODY_FRONT" },
      { assetId: 20, assetType: otherType, ...(otherType === "role" ? { kind: "FULL_BODY_FRONT" as const } : {}) },
    ];
    const definitions = "<Subject 1> is Ava in <Picture 1>, also shown in <Picture 2>.\n<Subject 2> is another asset in <Picture 2>.";
    assert.throws(() => assertH3ReferenceBindings(prompt(definitions), slots), /混用了不同资产/);
  }
});

test("copy preserves a valid scene-context plan without changing primary Subject ownership", async t => {
  const db = fixture(t);
  const slots = [
    ...persistedSlots.slice(0, 2),
    { id: 118, type: "scene", filePath: "/ocean.png" },
    { id: 124, type: "tool", filePath: "/phone.png" },
    { id: 128, type: "tool", filePath: "/shark.png" },
  ];
  const original = prompt([ava, ocean, phone, shark].join("\n"));
  const saved = await saveH3ReferencePlan(db, 42, original, slots);
  const translated = original.replace("the giant shark", "the enormous shark");
  assert.deepEqual(await copyH3ReferencePlan(db, 42, original, translated), saved);
  assert.deepEqual(await loadH3ReferencePlan(db, 42, translated), saved);
  const swapped = translated.replace("<Subject 4> is the enormous shark shown in <Picture 5>", "<Subject 4> is the enormous shark shown in <Picture 3>");
  await assert.rejects(copyH3ReferencePlan(db, 42, original, swapped), /参考图编号|重复引用|对应关系/);
  assert.equal((await db("o_h3ReferencePlan")).length, 2);
});

