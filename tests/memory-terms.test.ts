import assert from "node:assert/strict";
import { test } from "node:test";
import { searchTerms } from "../src/utils/agent/retrieval/terms";

test("中文角色名和英文术语可进入词项索引，结果去重且有上限", () => {
  assert.deepEqual(searchTerms("海洋女王在海洋中，Scene_A scene_a"), ["scene_a", "海洋", "洋女", "女王", "王在", "在海", "洋中"]);
  assert.equal(searchTerms("电视剧".repeat(100), 2).length, 2);
});
