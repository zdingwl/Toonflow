import test from "node:test";
import assert from "node:assert/strict";
import { expandH3AssetSlots } from "../src/utils/h3ReferenceSlots";

test("H3 role assets expand to face and full-body slots in runtime order", () => {
  const slots = expandH3AssetSlots([
    { id: 1, type: "role", name: "艾娃" },
    { id: 2, type: "scene", name: "甲板" },
  ]);
  assert.deepEqual(slots.map((item) => [item.id, item._referenceRole]), [
    [1, "FACE"],
    [1, "FULL_BODY_FRONT"],
    [2, undefined],
  ]);
});

test("H3 rejects reference sets larger than nine slots", () => {
  assert.throws(
    () => expandH3AssetSlots(Array.from({ length: 5 }, (_, id) => ({ id, type: "role", name: `角色${id}` }))),
    /最多支持 9 张参考图/,
  );
});

test("H3 adds side and back references only when the shot direction requires them", () => {
  const slots = expandH3AssetSlots([{ id: 1, type: "role", name: "艾娃" }], "侧面转身后背对镜头");
  assert.deepEqual(slots.map(item => item._referenceRole), [
    "FACE", "FULL_BODY_FRONT", "FULL_BODY_SIDE", "FULL_BODY_BACK",
  ]);
});
