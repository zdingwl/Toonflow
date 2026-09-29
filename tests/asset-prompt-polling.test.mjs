import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Exercise the page's actual polling handler without generating paid assets.
const source = readFileSync(new URL("../Toonflow-web-master/src/views/cornerScape/index.vue", import.meta.url), "utf8");
const handler = source.match(/async function pollingPromptAssets\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(handler);
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function poll(response, historyFails = false) {
  const row = { id: 1, promptState: "生成中", prompt: "旧提示词", descriptionNeedsPrompt: true,
    descriptionNeedsImage: true, filePath: "existing.png", historyImages: [] };
  const currentItem = { value: { ...row } };
  const editForm = { prompt: "旧提示词" };
  const calls = [];
  const axios = { post: async (url, body) => {
    calls.push({ url, body });
    if (url === "/assets/pollingPromptAssets") return { data: [response] };
    assert.equal(url, "/cornerScape/getAllAssets");
    if (historyFails) throw new Error("history temporarily unavailable");
    return { data: [{ id: 1, historyImages: [{ id: 9, filePath: "existing.png" }] }] };
  } };
  const run = new Function("notCompultedData", "axios", "dataList", "currentItem", "editForm", "project", "checkboxValue", "console",
    `${js}; return pollingPromptAssets;`)(
    { value: [row] }, axios, { value: [row] }, currentItem, editForm, { value: { id: 7 } }, { value: [] }, { error() {} });
  await run();
  assert.deepEqual(calls[0], { url: "/assets/pollingPromptAssets", body: { ids: [1] } });
  assert.equal(row.descriptionNeedsImage, true, "prompt completion must not approve an old image");
  assert.equal(row.filePath, "existing.png");
  return { row, drawer: currentItem.value, editForm };
}

test("completed prompt clears stale status in both card and open drawer without reload", async () => {
  const { row, drawer, editForm } = await poll({ id: 1, promptState: "已完成", prompt: "新提示词", descriptionVersion: 3, promptDescriptionVersion: 3 });
  for (const item of [row, drawer]) {
    assert.equal(item.promptState, "已完成");
    assert.equal(item.descriptionNeedsPrompt, false);
    assert.equal(item.prompt, "新提示词");
    assert.equal(item.historyImages.length, 1);
  }
  assert.equal(editForm.prompt, "新提示词");
});

test("completion updates immediately even if the subsequent history request fails", async () => {
  const { row, drawer } = await poll({ id: 1, promptState: "已完成", prompt: "新提示词", descriptionVersion: 2, promptDescriptionVersion: 2 }, true);
  assert.equal(row.descriptionNeedsPrompt, false);
  assert.equal(drawer.descriptionNeedsPrompt, false);
});

test("a failed or outdated generation retains the regeneration requirement", async () => {
  for (const promptState of ["生成失败", "待更新", "已完成"]) {
    const { row, drawer } = await poll({ id: 1, promptState, prompt: "旧提示词", promptErrorReason: "描述已变化", descriptionVersion: 4, promptDescriptionVersion: 3 });
    assert.equal(row.descriptionNeedsPrompt, true);
    assert.equal(drawer.descriptionNeedsPrompt, true);
    assert.equal(row.promptErrorReason, "描述已变化");
  }
});
