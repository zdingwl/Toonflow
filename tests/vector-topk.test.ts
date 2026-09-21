import assert from "node:assert/strict";
import { test } from "node:test";
import { VectorTopK } from "../src/utils/agent/retrieval/vectorTopK";

test("分页加入向量候选时只保留全局 Top-K", () => {
  const top = new VectorTopK<any>([1, 0], 3);
  top.add([
    { id: "a", embedding: JSON.stringify([0.1, 0.9]) },
    { id: "b", embedding: JSON.stringify([0.7, 0.3]) },
  ]);
  top.add([
    { id: "c", embedding: JSON.stringify([1, 0]) },
    { id: "d", embedding: JSON.stringify([0.5, 0.5]) },
  ]);
  assert.deepEqual(top.values().map((item) => item.id), ["c", "b", "d"]);
});

test("关键词候选在向量尚未生成时仍可进入候选集且不会重复", () => {
  const top = new VectorTopK<any>([1, 0], 2, new Set(["lex"]));
  top.add([{ id: "lex", embedding: null }, { id: "other", embedding: JSON.stringify([0.9, 0.1]) }]);
  top.add([{ id: "lex", embedding: JSON.stringify([0.8, 0.2]) }]);
  const result = top.values();
  assert.equal(result.filter((item) => item.id === "lex").length, 1);
  assert.ok(result.some((item) => item.id === "lex"));
});
