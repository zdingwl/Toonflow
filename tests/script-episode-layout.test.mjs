import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(root, "Toonflow-web-master/src/utils/parseScript.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  fileName: "parseScript.ts",
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual((compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error), []);
const module = { exports: {} };
new Function("module", "exports", compiled.outputText)(module, module.exports);
const parseScript = module.exports.default;

const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const zh = (n) => n < 10 ? digits[n] : n === 10 ? "十" : n < 20 ? `十${digits[n - 10]}` : `${digits[Math.floor(n / 10)]}十${n % 10 ? digits[n % 10] : ""}`;

test("三十集格式：结尾字幕、预告及正文提及集数都不能再次拆集", () => {
  const paragraphs = ["片名候选：", "1、备选片名", "2、另一个片名"];
  for (let i = 1; i <= 30; i++) {
    const title = `章节标题${i}`;
    paragraphs.push(`第${zh(i)}集：${title}`, "时长：九十秒", "场景一：甲板", `对白：第${i}集的独立正文`);
    if (i === 7) paragraphs.push("第七集那晚发生的事仍在继续。");
    paragraphs.push(`结尾字幕：第${zh(i)}集：${title}。`);
    paragraphs.push(i === 28 ? "下集预告：第二十九集：一段预告。" : i === 29 ? "下集预告：第三十集：一段预告。" : "下集预告：下一集的故事。", "互动点：选择。", "");
  }
  const episodes = parseScript(paragraphs.join("\n"));
  assert.equal(episodes.length, 30);
  assert.deepEqual(episodes.map((episode) => episode.index), Array.from({ length: 30 }, (_, i) => i + 1));
  for (let i = 0; i < episodes.length; i++) {
    assert.equal(episodes[i].chapter, `章节标题${i + 1}`, "标题不能带冒号或误读结尾字幕");
    assert.equal(episodes[i].text.match(/结尾字幕：/g)?.length, 1, "每集正文应包含且仅包含自己的结尾字幕");
  }
  assert.match(episodes[6].text, /第七集那晚/);
  assert.match(episodes[29].text, /第三十集：章节标题30/);
});

test("兼容无冒号的空格分隔和无标题集头，但不把“第七集那晚”当集头", () => {
  const episodes = parseScript("第1集 起点\n第七集那晚发生的事\n第2集\n正文结束");
  assert.deepEqual(episodes.map((episode) => episode.index), [1, 2]);
  assert.equal(episodes[0].chapter, "起点");
  assert.equal(episodes[1].chapter, "");
  assert.match(episodes[0].text, /第七集那晚/);
});
