import assert from "node:assert/strict";
import test from "node:test";
import { latestAssetImageAttempts } from "../src/utils/latestAssetImageAttempts";

test("asset image polling follows the newest attempt instead of the last adopted image", () => {
  const rows = [
    { id: 12, assetsId: 2, state: "已完成", filePath: "/new-2.jpg" },
    { id: 11, assetsId: 1, state: "生成中", filePath: null },
    { id: 10, assetsId: 1, state: "已完成", filePath: "/old-1.jpg" },
    { id: 9, assetsId: 2, state: "已完成", filePath: "/old-2.jpg" },
  ];

  assert.deepEqual(latestAssetImageAttempts(rows), [rows[0], rows[1]]);
});

test("asset image polling ignores rows without an owning asset", () => {
  const rows = [
    { id: 3, assetsId: null, state: "已完成" },
    { id: 2, assetsId: 7, state: "生成失败" },
  ];

  assert.deepEqual(latestAssetImageAttempts(rows), [rows[1]]);
});
