import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(root, "src/utils/storyboardScenes.ts"), "utf8");
const parsed = ts.transpileModule(source, {
  fileName: "storyboardScenes.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual((parsed.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error), []);
const exports = {};
new Function("exports", parsed.outputText)(exports);
const { mergeStoryboardScene } = exports;
const scene = (number, text = `内容${number}`) => `## 场${number}：场景名 ｜ 参演角色：甲\n### 片段一（约5s）\n${text}`;
const save = (table, state, number, total = 3, text = scene(number), task = "storyboard_run_01") =>
  mergeStoryboardScene(table, state, task, number, total, text);

test("乱序分场保存后按场次排列，所有场次齐全才完成", () => {
  const second = save("", undefined, 2);
  assert.deepEqual(second.savedScenes, [2]);
  assert.deepEqual(second.missingScenes, [1, 3]);
  assert.equal(second.storyboardTableProgress.complete, false);
  const first = save(second.storyboardTable, second.storyboardTableProgress, 1);
  const last = save(first.storyboardTable, first.storyboardTableProgress, 3);
  assert.deepEqual(last.savedScenes, [1, 2, 3]);
  assert.deepEqual(last.missingScenes, []);
  assert.equal(last.storyboardTableProgress.complete, true);
  assert.ok(last.storyboardTable.indexOf("## 场1") < last.storyboardTable.indexOf("## 场2"));
  assert.ok(last.storyboardTable.indexOf("## 场2") < last.storyboardTable.indexOf("## 场3"));
});

test("相同场次与相同内容重试不重复写入或递增版本", () => {
  const first = save("", undefined, 1);
  const again = save(first.storyboardTable, first.storyboardTableProgress, 1);
  assert.equal(again.storyboardTable, first.storyboardTable);
  assert.equal(again.storyboardTableProgress.revision, first.storyboardTableProgress.revision);
});

test("不同内容、不同任务、不同总场次及人工修改不可覆盖", () => {
  const first = save("", undefined, 1);
  assert.throws(() => save(first.storyboardTable, first.storyboardTableProgress, 1, 3, scene(1, "新内容")), /不能自动覆盖/);
  assert.throws(() => save(first.storyboardTable, first.storyboardTableProgress, 2, 3, scene(2), "another_task"), /任务标识/);
  assert.throws(() => save(first.storyboardTable, first.storyboardTableProgress, 2, 4), /总场次数/);
  assert.throws(() => save(first.storyboardTable + "人工补充", first.storyboardTableProgress, 2), /人工修改/);
  assert.throws(() => save("已有人写的分镜表", undefined, 1), /已有分镜表/);
});

test("截断、不匹配或混入第二场的单场内容被拒绝", () => {
  assert.throws(() => save("", undefined, 1, 3, "### 片段一（约5s）"), /必须以/);
  assert.throws(() => save("", undefined, 1, 3, scene(2)), /必须以/);
  assert.throws(() => save("", undefined, 1, 3, scene(1) + "\n" + scene(2)), /不能包含其他场次/);
  assert.throws(() => save("", undefined, 1, 3, scene(1) + "</storyboardTable>"), /嵌套 XML/);
  assert.throws(() => save("", undefined, 1, 3, scene(1), "a"), /任务标识无效/);
});
