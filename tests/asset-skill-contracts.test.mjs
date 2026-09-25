import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// Static contracts: these tests do not claim to measure model fidelity or video temporal quality.
test('Qwen four-view provider is asset-driven rather than hardcoded to the sample Kor character', () => {
  const vendor = read('data/vendor/comfyui_qwen21_fourview.ts');
  assert.doesNotMatch(vendor, /科尔|海兽王|red irises|wet dark hair/);
  assert.match(vendor, /CURRENT ASSET FACTS/);
  assert.match(vendor, /SINGLE-VIEW/);
  assert.match(vendor, /identityFactsOnly/);
  assert.match(vendor, /四栏从左到右固定为/);
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
  assert.match(h3, /FACE and FULL_BODY_FRONT/);
  assert.match(h3, /current state/);
  assert.match(h3, /target_duration/);
  assert.match(storyboard, /minimum_duration > target_duration/);
  assert.match(storyboard, /PLAN_CHANGED/);
});
