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
const { normalizeScriptIds, normalizeScriptIdsForBatch } = module.exports;

test("资产提取 scriptIds 兼容数组、单个数字和字符串，并限制为当前批次", () => {
  const allowed = [11, 12, 13];
  assert.deepEqual(normalizeScriptIds([11, 12, 12, 999], allowed), [11, 12]);
  assert.deepEqual(normalizeScriptIds(13, allowed), [13]);
  assert.deepEqual(normalizeScriptIds("11, 12，999", allowed), [11, 12]);
  assert.deepEqual(normalizeScriptIds('[11, "13"]', allowed), [11, 13]);
  assert.deepEqual(normalizeScriptIds(null, allowed), []);
});

test("单剧本批次自动修复模型遗漏或幻觉的 scriptIds，多剧本仍保持严格校验", () => {
  assert.deepEqual(normalizeScriptIdsForBatch([], [31]), [31]);
  assert.deepEqual(normalizeScriptIdsForBatch([999], [31]), [31]);
  assert.deepEqual(normalizeScriptIdsForBatch(null, [31]), [31]);
  assert.deepEqual(normalizeScriptIdsForBatch([999], [31, 32]), []);
  assert.deepEqual(normalizeScriptIdsForBatch([32], [31, 32]), [32]);
});

test("资产提取入库前必须归一化模型返回的 scriptIds，不能直接 for-of 未校验值", () => {
  assert.match(routeSource, /normalizeScriptIdsForBatch\(\(asset as \{ scriptIds\?: unknown \}\)\.scriptIds, allowedScriptIds\)/);
  assert.match(routeSource, /normalizeScriptIdsForBatch\(\(ref as \{ scriptIds\?: unknown \}\)\.scriptIds, allowedScriptIds\)/);
  assert.doesNotMatch(routeSource, /for \(const asset of newAssets\)[\s\S]{0,200}for \(const sid of asset\.scriptIds\)/);
  assert.match(routeSource, /AI 返回的资产关联剧本ID无效/);
});


test("资产批次大小必须就是 groupSize，5 不能膨胀成 25 集", () => {
  assert.match(routeSource, /export function chunkArray\(arr: number\[\], groupSize: number\): number\[\]\[\]/);
  assert.match(routeSource, /arr\.slice\(i, i \+ safeGroupSize\)/);
  assert.doesNotMatch(routeSource, /i \+= 5[\s\S]{0,300}i \+= groupSize/);
});

test("资产提取必须强制 resultTool，单步结束，并在空结果时自动重试一次", () => {
  const forcedCalls = routeSource.match(/toolChoice: \{ type: "tool", toolName: "resultTool" \}/g) ?? [];
  const oneStepStops = routeSource.match(/stopWhen: stepCountIs\(1\)/g) ?? [];
  assert.equal(forcedCalls.length, 2);
  assert.equal(oneStepStops.length, 2);
  assert.match(routeSource, /await invokeExtraction\(\);/);
  assert.match(routeSource, /AI 连续两次未调用资产结果工具或返回空资产/);
  assert.doesNotMatch(routeSource, /参考技能 script_assets_extract/);
});
