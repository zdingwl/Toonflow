import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildAssetExtractionArtContext } from "../src/utils/assetPrompt";
import { buildAssetExtractionVisualDesignSkill } from "../src/utils/assetVisualDesignSkill";

const selectedPrefix = readFileSync(path.resolve("data/skills/art_skills/realistic_3d_anime/prefix.md"), "utf8");
const syntheticPrefix = `---
name: FRONTMATTER_ONLY_MARKER
description: metadata is not an asset design instruction
---
# 项目美术方向
SELECTED_DESIGN_MARKER：水彩纸张的暖灰色调、简化面部体积与清楚的服装轮廓。
## 人物设计
DESIGN_DETAIL_MARKER：身份识别点保持清楚；人物年龄、时代与衣装服从剧本明确设定。
## 资产展示
LAYOUT_TEMPLATE_MARKER：四栏从左到右依次安排脸部、正面、侧面与背面，展示板统一背景。
## 输出格式
OUTPUT_TEMPLATE_MARKER：返回字段表格与生成参数。
## 视频模板
VIDEO_TEMPLATE_MARKER：使用 Subject 绑定 Picture，加入人物动作与镜头。
`;

test("the selected real 3D prefix contributes design rather than image/video output templates", () => {
  const context = buildAssetExtractionArtContext(selectedPrefix);
  assert.match(context, /cinematic semi-realistic Chinese 3D animation/);
  assert.match(context, /国漫式美型骨相/);
  assert.match(context, /年龄|既定年龄/);
  assert.doesNotMatch(context, /Qwen-Image 2\.1 描述格式|最终提示词|四栏|四宫格|portrait、front|Picture|Subject/);
  assert.doesNotMatch(context, /SELECTED_DESIGN_MARKER|FRONTMATTER_ONLY_MARKER/);
  // This verifies the context's precedence instruction, not model compliance.
  assert.match(context, /剧本明确的[^\n]*年龄[^\n]*时代[^\n]*衣装[^\n]*状态[^\n]*优先/);
});

test("synthetic prefix retains its design while discarding metadata, layout and output/video sections", () => {
  const context = buildAssetExtractionArtContext(syntheticPrefix);
  for (const marker of ["SELECTED_DESIGN_MARKER", "DESIGN_DETAIL_MARKER"]) {
    assert.ok(context.includes(marker), `missing selected design: ${marker}`);
  }
  for (const marker of ["FRONTMATTER_ONLY_MARKER", "LAYOUT_TEMPLATE_MARKER", "OUTPUT_TEMPLATE_MARKER", "VIDEO_TEMPLATE_MARKER"]) {
    assert.ok(!context.includes(marker), `template or metadata leaked into design: ${marker}`);
  }
  assert.doesNotMatch(context, /^---|^name:|^description:|四栏|Subject|Picture|返回字段表格/m);
  assert.match(context, /人物年龄、时代与衣装服从剧本明确设定/);
  assert.match(context, /剧本明确的[^\n]*年龄[^\n]*时代[^\n]*衣装[^\n]*优先/);
});

test("separate selections do not reuse another style's design context", () => {
  const synthetic = buildAssetExtractionArtContext(syntheticPrefix);
  const current = buildAssetExtractionArtContext(selectedPrefix);
  assert.doesNotMatch(synthetic, /cinematic semi-realistic Chinese 3D animation|国漫式美型骨相/);
  assert.doesNotMatch(current, /SELECTED_DESIGN_MARKER|水彩纸张/);
  assert.equal(buildAssetExtractionArtContext(syntheticPrefix), synthetic);
});

test("empty or template-only input adds no invented design context", () => {
  assert.equal(buildAssetExtractionArtContext(""), "");
  assert.equal(buildAssetExtractionArtContext(`---\nname: metadata\n---\n## 输出格式\nOUTPUT_ONLY\n## 视频模板\nVIDEO_ONLY`), "");
});

test("extraction loads stable design and state guidance without downstream image protocols", () => {
  const skill = readFileSync("data/skills/asset_visual_design.md", "utf8");
  const selected = buildAssetExtractionVisualDesignSkill(skill);
  assert.match(selected, /大众审美设计补全/);
  assert.match(selected, /身份 identity/);
  assert.match(selected, /场景保存固定空间结构/);
  assert.match(selected, /年龄未知时不写精确年龄/);
  // Extraction must not prime unconfirmed ages with concrete adult body defaults.
  assert.doesNotMatch(selected, /胸部丰满但自然承托|腰臀比清楚|运动型胸背与腹部轮廓/);
  assert.match(skill, /胸部丰满但自然承托/);
  assert.match(skill, /本节只在后续绘制阶段/);
  assert.doesNotMatch(selected, /actualReference|parentReference|四栏角色设定图|## 输出验收/);
  assert.ok(selected.length < skill.length * 0.65);
  assert.match(buildAssetExtractionVisualDesignSkill("## 自定义设计要求\n保留这条用户造型约束"), /保留这条用户造型约束/);
});
