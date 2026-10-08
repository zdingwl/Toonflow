import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'sucrase';
import { VM } from 'vm2';

const root = path.resolve(import.meta.dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// Static contracts: these tests do not claim to measure model fidelity or video temporal quality.
test('Qwen four-view provider is asset-driven rather than hardcoded to the sample Kor character', () => {
  const vendor = read('data/vendor/comfyui_qwen21_fourview.ts');
  assert.doesNotMatch(vendor, /科尔|海兽王|red irises|wet dark hair/);
  assert.match(vendor, /CURRENT ASSET FACTS/);
  assert.match(vendor, /SINGLE-VIEW/);
  assert.match(vendor, /identityFactsOnly/);
  assert.match(vendor, /ImageStitch/);
  assert.match(vendor, /loraName/);
});

test('character prompt and code use the same four canonical positions', () => {
  const skill = read('data/skills/art_skills/realistic_3d_anime/art_prompt/art_character.md');
  const code = read('src/utils/assetPrompt.ts');
  assert.match(skill, /四栏/);
  assert.match(skill, /脸部特写/);
  assert.match(skill, /正面全身/);
  assert.match(skill, /90°左侧面全身/);
  assert.match(skill, /正后方全身/);
  assert.match(code, /exactly four panels/);
  assert.match(code, /head-and-shoulders portrait/);
  assert.match(code, /full-body front view/);
  assert.match(code, /full-body strict 90-degree left side view/);
  assert.match(code, /full-body straight back view/);
});

test('scene prompt contracts keep reusable environment plates free of independent subjects', () => {
  const visual = read('data/skills/asset_visual_design.md');
  const scene = read('data/skills/art_skills/realistic_3d_anime/art_prompt/art_scene.md');
  const runtime = read('src/utils/assetPrompt.ts');
  for (const text of [visual, scene]) {
    assert.match(text, /纯环境/);
    assert.match(text, /独立(?:资产|生物)/);
  }
  assert.match(runtime, /EMPTY ENVIRONMENT PLATE/);
  assert.match(runtime, /Internal project preset id/);
});

test('asset design skill applies differentiated adult lead aesthetics without sexualizing unknown ages', () => {
  const visual = read('data/skills/asset_visual_design.md');
  const character = read('data/skills/art_skills/realistic_3d_anime/art_prompt/art_character.md');
  assert.match(visual, /胸部丰满但自然承托/);
  assert.match(visual, /腰臀比清楚/);
  assert.match(visual, /宽肩窄腰/);
  assert.match(visual, /运动型胸背与腹部轮廓/);
  assert.match(visual, /冷静强势型/);
  assert.match(visual, /冷峻精英型/);
  assert.match(visual, /每套衣装至少具备一个清楚的大轮廓、一个功能结构和一个克制的识别点/);
  assert.match(visual, /年龄无法确认/);
  assert.match(character, /大众审美设计补全/);
  assert.match(character, /至少有两项稳定外观差异/);
  assert.match(character, /不为展示身材擅自裸露/);
});

test('realistic_3d_anime asset manuals use the project 3D medium and Qwen observable-description structure', () => {
  const prefix = read('data/skills/art_skills/realistic_3d_anime/prefix.md');
  const character = read('data/skills/art_skills/realistic_3d_anime/art_prompt/art_character.md');
  const scene = read('data/skills/art_skills/realistic_3d_anime/art_prompt/art_scene.md');
  for (const text of [prefix, character, scene]) {
    assert.match(text, /半写实三维国漫/);
    assert.doesNotMatch(text, /polished illustration rendering|clean premium shading/);
  }
  assert.match(prefix, /成片描述/);
  assert.match(prefix, /体型、姿态、视线、表情/);
  assert.match(prefix, /灯光必须有明确来源、方向、软硬、阴影与高光结果/);
  assert.match(character, /自然次表面透光/);
  assert.match(scene, /PBR 材质/);
});

test('Qwen four-view provider removes layout sentences from every single-view prompt', () => {
  const source = read('data/vendor/comfyui_qwen21_fourview.ts');
  const exports = {};
  const code = transform(source, { transforms: ['typescript'] }).code.replace(/export\s*\{\s*\};?/g, '');
  new VM({ sandbox: { exports, Buffer }, eval: false, wasm: false }).run(code);
  const prompts = [
    '同一角色的四栏角色设定图，电影级 CGI。艾娃，黑发，灰色机能服。四栏从左到右：脸部特写、正面全身、侧面全身、背面全身；四栏为同一人。纯净浅灰背景。',
    '同一角色的四栏角色设定图，电影级 CGI。麦迪逊，棕色卷发。四栏从左到右固定为：第一栏脸部，第二栏正面，第三栏侧面，第四栏背面；四个视角均为同一人。纯净浅灰背景。',
  ];
  for (const prompt of prompts) {
    const cleaned = exports.identityFactsOnly(prompt);
    assert.match(cleaned, /电影级 CGI/);
    assert.match(cleaned, /纯净浅灰背景/);
    assert.doesNotMatch(cleaned, /四栏|四个视角|从左到右|第一栏|第二栏|第三栏|第四栏/);
  }
});

test('Qwen route sends per-asset facts and optional style reference without the generic layout contract', () => {
  const route = read('src/routes/assetsGenerate/generateAssets.ts');
  assert.match(route, /isQwenFourView/);
  assert.match(route, /styleBase64/);
  assert.match(route, /Authoritative visible identity/);
  assert.match(route, /asset\.assetsId && !base64/);
  assert.match(route, /aspectRatio: isQwenFourView \? "2:3"/);
});

test('scripted changed eye color is allowed as a derivative state', () => {
  const skill = read('data/skills/art_skills/realistic_3d_anime/art_prompt/art_character_derivative.md');
  assert.match(skill, /目标状态中的变化优先于基础态默认值/);
  assert.match(skill, /普通虹膜可以在觉醒态变红/);
});

test('H3 prompt and storyboard skill require state-safe references and duration preflight', () => {
  const h3 = read('data/modelPrompt/video/minimaxH3Multi-referenceMode.md');
  const storyboard = read('data/skills/production_execution_storyboard_table.md');
  assert.match(h3, /complete character sheet occupies ONE Picture/);
  assert.doesNotMatch(h3, /optional FACE\/SIDE\/BACK/);
  assert.match(h3, /ONE character in ONE state/);
  assert.match(h3, /target_duration/);
  // The current reference-role template deliberately has no fixed word quota.
  assert.match(h3, /do not impose a fixed total-prompt word count/);
  assert.match(h3, /visible features and reference role/);
  assert.match(h3, /Remove redundant prose,\s+not story facts/);
  assert.match(storyboard, /minimum_duration > target_duration/);
  assert.match(storyboard, /PLAN_CHANGED/);
});
