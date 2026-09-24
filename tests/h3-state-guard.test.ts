import test from "node:test";
import assert from "node:assert/strict";
import { assertH3ActiveStates, assertH3PictureSlots } from "../src/utils/h3VisualStateGuard";

test("a single active derived role is allowed", () => {
  assert.doesNotThrow(() => assertH3ActiveStates([
    { assetId: 101, parentAssetId: 10, assetType: "role", name: "科尔·觉醒态", filePath: "/role/101.png" },
    { assetId: 88, assetType: "scene", name: "海啸场景", filePath: "/scene/88.png" },
  ]));
});

test("parent and derived role cannot be referenced simultaneously", () => {
  assert.throws(() => assertH3ActiveStates([
    { assetId: 10, assetType: "role", name: "普通科尔", filePath: "/role/10.png" },
    { assetId: 101, parentAssetId: 10, assetType: "role", name: "科尔·觉醒态", filePath: "/role/101.png" },
  ]), /互斥形态/);
});

test("different derived states of one role cannot be referenced simultaneously", () => {
  assert.throws(() => assertH3ActiveStates([
    { assetId: 101, parentAssetId: 10, assetType: "role", name: "形态甲", filePath: "/101.png" },
    { assetId: 102, parentAssetId: 10, assetType: "role", name: "形态乙", filePath: "/102.png" },
  ]), /互斥形态/);
});

test("a duplicated role is not expanded into four unwanted references", () => {
  assert.throws(() => assertH3ActiveStates([
    { assetId: 10, assetType: "role", name: "科尔", filePath: "/10.png" },
    { assetId: 10, assetType: "role", name: "科尔", filePath: "/10.png" },
  ]), /重复引用/);
});

test("a missing asset reference fails closed", () => {
  assert.throws(() => assertH3ActiveStates([
    { assetId: 10, assetType: "role", name: "科尔", filePath: null },
  ]), /参考图缺失/);
});

test("picture slots must exactly cover the expanded upload order", () => {
  assert.doesNotThrow(() => assertH3PictureSlots(
    "<Subject 1> uses <Picture 1> face and <Picture 2> body; environment <Picture 3>", 3));
  assert.throws(() => assertH3PictureSlots("<Picture 1> <Picture 3>", 3), /槽位/);
  assert.throws(() => assertH3PictureSlots("<Picture 1>", 0), /没有上传/);
  assert.throws(() => assertH3PictureSlots("<Picture 1>", 10), /最多9张/);
});
