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

// Extraction persistence, batching, ID validation and retry behavior are exercised
// against SQLite by asset-description-refresh.test.ts.

test("资产提取在 desc 源头完成差异化成年主角审美设计并保持场景为纯环境", () => {
  const skill = readFileSync(path.join(root, "data/skills/asset_visual_design.md"), "utf8");
  assert.match(routeSource, /资产 desc 不是剧情摘要/);
  assert.match(routeSource, /getAssetExtractionVisualDesignSkill/);
  assert.match(skill, /成年女性主角[\s\S]*健康协调的成熟曲线/);
  assert.match(skill, /成年男性主角[\s\S]*宽肩窄腰、运动型胸背/);
  assert.match(routeSource, /脸型、眉眼鼻唇、妆发轮廓、体型剪影和完整衣装/);
  assert.match(routeSource, /轮廓、材质对比与标志性细节/);
  assert.match(routeSource, /未成年、儿童或年龄无法确认/);
  assert.match(routeSource, /当前项目美术方向允许/);
  assert.match(routeSource, /具名人物、人影、动物、怪物、独立生物/);
  assert.match(routeSource, /assetExtractionDesignRules/);
});
