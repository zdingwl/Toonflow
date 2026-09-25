import test from "node:test";
import assert from "node:assert/strict";
import { expandH3AssetSlots } from "../src/utils/h3ReferenceSlots";

const role = (id: number, name = `角色${id}`) => ({ id, type: "role", name });
const views = (items: ReturnType<typeof expandH3AssetSlots>, id: number) => items.filter(item => item.id === id).map(item => item._referenceRole);

test("H3 role assets expand to face and full-body slots in runtime order", () => {
  const slots = expandH3AssetSlots([role(1, "艾娃"), { id: 2, type: "scene", name: "甲板" }]);
  assert.deepEqual(slots.map(item => [item.id, item._referenceRole]), [[1, "FACE"], [1, "FULL_BODY_FRONT"], [2, undefined]]);
});

test("actual three-role two-scene two-tool shot fits nine slots without dropping any asset", () => {
  const slots = expandH3AssetSlots([
    role(115, "艾娃"), role(116, "麦迪逊"), role(117, "科尔"),
    { id: 119, type: "scene", name: "小公寓" }, { id: 118, type: "scene", name: "末世海洋" },
    { id: 124, type: "tool", name: "海洋基建系统手机" }, { id: 128, type: "tool", name: "巨鲨" },
  ], "麦迪逊在艾娃身后推掌，科尔被拖入海中。");
  assert.equal(slots.length, 9);
  assert.deepEqual([...new Set(slots.map(item => item.id))], [115, 116, 117, 119, 118, 124, 128]);
  assert.deepEqual(views(slots, 115), ["FACE", "FULL_BODY_FRONT"]);
  assert.deepEqual(views(slots, 116), ["FACE", "FULL_BODY_FRONT"]);
  assert.deepEqual(views(slots, 117), ["FULL_BODY_FRONT"]);
});

test("five roles keep all fronts and distribute the remaining four face slots deterministically", () => {
  const slots = expandH3AssetSlots(Array.from({ length: 5 }, (_, id) => role(id)));
  assert.equal(slots.length, 9);
  for (let id = 0; id < 4; id++) assert.deepEqual(views(slots, id), ["FACE", "FULL_BODY_FRONT"]);
  assert.deepEqual(views(slots, 4), ["FULL_BODY_FRONT"]);
});

test("only more than nine distinct image assets exceed the H3 budget", () => {
  const nine = expandH3AssetSlots(Array.from({ length: 9 }, (_, id) => role(id)));
  assert.equal(nine.length, 9); assert.ok(nine.every(item => item._referenceRole === "FULL_BODY_FRONT"));
  assert.throws(() => expandH3AssetSlots(Array.from({ length: 10 }, (_, id) => ({ id, type: "scene" }))), /10 个独立图片资产/);
});

test("H3 deduplicates asset IDs and excludes unselected assets, storyboard, audio and video", () => {
  const slots = expandH3AssetSlots([
    role(1, "艾娃"), role(1, "艾娃"), { id: 1, type: "audio" },
    { id: 2, type: "scene", _reference: false }, { id: 3, _type: "storyboard" },
    { id: 4, type: "tool", _fileType: "audio" }, { id: 5, type: "tool", fileType: "video" },
    { id: 6, type: "tool", referenceType: "audioReference" }, { id: 7, type: "tool", _slotType: "videoReference" },
  ]);
  assert.equal(slots.length, 2); assert.ok(slots.every(item => item.id === 1));
});

test("directions apply only to the named character within each action clause", () => {
  const slots = expandH3AssetSlots([role(1, "艾娃"), role(2, "麦迪逊")], "艾娃侧身推门；麦迪逊站稳后，背对镜头。");
  assert.deepEqual(views(slots, 1), ["FACE", "FULL_BODY_FRONT", "FULL_BODY_SIDE"]);
  assert.deepEqual(views(slots, 2), ["FACE", "FULL_BODY_FRONT", "FULL_BODY_BACK"]);
});

test("shared named subjects can request the same rear view but anonymous multi-role directions cannot", () => {
  const named = expandH3AssetSlots([role(1, "艾娃"), role(2, "麦迪逊")], "艾娃和麦迪逊背对镜头。");
  assert.ok(views(named, 1).includes("FULL_BODY_BACK")); assert.ok(views(named, 2).includes("FULL_BODY_BACK"));
  const anonymous = expandH3AssetSlots([role(1, "艾娃"), role(2, "麦迪逊")], "侧身后退，背对镜头。");
  assert.equal(anonymous.length, 4);
});

test("single-role unnamed side/back actions remain supported", () => {
  assert.deepEqual(views(expandH3AssetSlots([role(1, "艾娃")], "侧面转身后背对镜头"), 1), ["FACE", "FULL_BODY_FRONT", "FULL_BODY_SIDE", "FULL_BODY_BACK"]);
});

test("asset lists, character-sheet layout, negation, and named object views do not add role crops", () => {
  const slots = expandH3AssetSlots([role(1, "艾娃"), { id: 2, type: "tool", name: "海洋基建系统手机" }], [
    "【关联资产】艾娃侧面参考、艾娃背面参考、海洋基建系统手机",
    "艾娃四视图包含脸部、正面、侧面、背面。",
    "艾娃不要背对镜头，也不显示侧脸。",
    "艾娃检查手机背面；镜头从侧面拍摄手机。",
    "艾娃检查海洋基建系统手机，背面是红色。",
  ].join("\n"));
  assert.deepEqual(views(slots, 1), ["FACE", "FULL_BODY_FRONT"]);
});

test("English actor directions, negation and object names are scoped consistently", () => {
  const slots = expandH3AssetSlots([role(1, "Ava"), role(2, "Madison")], "Ava in profile. Madison seen from behind. No side view of Madison. Rear view of the phone.");
  assert.deepEqual(views(slots, 1), ["FACE", "FULL_BODY_FRONT", "FULL_BODY_SIDE"]);
  assert.deepEqual(views(slots, 2), ["FACE", "FULL_BODY_FRONT", "FULL_BODY_BACK"]);
});

test("face references take budget priority over optional side/back views", () => {
  const slots = expandH3AssetSlots([role(1, "艾娃"), role(2, "麦迪逊"), role(3, "科尔"), { id: 4, type: "scene" }, { id: 5, type: "tool" }], "艾娃侧身转为背对镜头；麦迪逊侧身。");
  assert.equal(slots.length, 9);
  for (const id of [1, 2, 3]) assert.ok(views(slots, id).includes("FACE"));
  assert.deepEqual(views(slots, 1), ["FACE", "FULL_BODY_FRONT", "FULL_BODY_SIDE"]);
  assert.deepEqual(views(slots, 2), ["FACE", "FULL_BODY_FRONT"]);
});
