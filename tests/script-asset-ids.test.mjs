import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const helperSource = readFileSync(path.join(root, "src/utils/scriptAssetIds.ts"), "utf8");
const routeSource = readFileSync(path.join(root, "src/routes/script/extractAssets.ts"), "utf8");
const js = ts.transpileModule(helperSource, {
  fileName: "scriptAssetIds.ts",
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", js)(module, module.exports);
const { normalizeScriptIds } = module.exports;

test("资产提取 scriptIds 兼容数组、单个数字和字符串，并限制为当前批次", () => {
  const allowed = [11, 12, 13];
  assert.deepEqual(normalizeScriptIds([11, 12, 12, 999], allowed), [11, 12]);
  assert.deepEqual(normalizeScriptIds(13, allowed), [13]);
  assert.deepEqual(normalizeScriptIds("11, 12，999", allowed), [11, 12]);
  assert.deepEqual(normalizeScriptIds('[11, "13"]', allowed), [11, 13]);
  assert.deepEqual(normalizeScriptIds(null, allowed), []);
});

test("资产提取入库前必须归一化模型返回的 scriptIds，不能直接 for-of 未校验值", () => {
  assert.match(routeSource, /normalizeScriptIds\(\(asset as \{ scriptIds\?: unknown \}\)\.scriptIds, allowedScriptIds\)/);
  assert.match(routeSource, /normalizeScriptIds\(\(ref as \{ scriptIds\?: unknown \}\)\.scriptIds, allowedScriptIds\)/);
  assert.doesNotMatch(routeSource, /for \(const asset of newAssets\)[\s\S]{0,200}for \(const sid of asset\.scriptIds\)/);
  assert.match(routeSource, /AI 返回的资产关联剧本ID无效/);
});
