import test from "node:test";
import assert from "node:assert/strict";
import { expandH3AssetSlots, selectedH3Views } from "../src/utils/h3ReferenceSlots";

test("one manually approved four-view board contributes one Picture by default", () => {
  const refs = expandH3AssetSlots([{ id: 1, type: "role", name: "科尔", filePath: "/role.png" }, { type: "scene", name: "天台" }]);
  assert.equal(refs.length, 2);
  assert.equal(refs[0]._referenceRole, "BOARD");
  assert.equal(refs[0].id, 1);
});

test("angle-specific references use actual visible character views", () => {
  assert.deepEqual(selectedH3Views({ h3ReferenceMode: "auto", h3ShotView: "side" }), ["SIDE", "FACE"]);
  assert.deepEqual(selectedH3Views({ h3ReferenceMode: "auto", h3ShotView: "back" }), ["BACK", "FRONT"]);
  assert.deepEqual(selectedH3Views({ h3ReferenceMode: "auto", h3ShotView: "turn" }), ["BACK", "SIDE", "FACE"]);
  assert.deepEqual(selectedH3Views({ h3ReferenceMode: "auto" }), ["BOARD"]);
});

test("manual view selection keeps order and rejects contradictory choices", () => {
  assert.deepEqual(selectedH3Views({ h3ReferenceMode: "manual", h3Views: ["BACK", "SIDE", "FACE"] }), ["BACK", "SIDE", "FACE"]);
  assert.throws(() => selectedH3Views({ h3ReferenceMode: "manual", h3Views: ["BOARD", "SIDE"] }), /手动参考视图/);
  assert.throws(() => selectedH3Views({ h3ReferenceMode: "manual", h3Views: [] }), /手动参考视图/);
});

test("expanded reference list respects H3 nine-image limit", () => {
  const items = Array.from({ length: 4 }, (_, id) => ({ id, type: "role", h3ReferenceMode: "manual", h3Views: ["FACE", "FRONT", "SIDE"] }));
  assert.throws(() => expandH3AssetSlots(items), /最多支持 9 张/);
});
