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
  assert.match(visual, /每套衣装具备清楚的大轮廓和合理功能结构/);
  assert.match(visual, /不因姓名、亲属称呼、驾驶或交易推断成年/);
  assert.match(visual, /不为了凑数量新增腕表、饰品、痣疤、纹样或精确左右位置/);
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

// Prompt-source regression contracts only; live model results still require direct review.
test('derive analysis reads the full current director plan before deciding state changes', () => {
  const skill = read('data/skills/production_execution_derive_assets.md');
  for (const key of ['script', 'scriptPlan', 'assets']) {
    assert.ok(skill.includes(`get_flowData({key:"${key}"})`), `missing mandatory ${key} read`);
  }
  assert.match(skill, /nextOffset.*null/);
  assert.match(skill, /不能仅凭摘要、首段或旧记忆判断/);
  assert.match(skill, /用户明确改编优先于原文对应字段/);
  assert.match(skill, /导演设计可确定原文未限定的外观/);
  assert.match(skill, /旧衍生描述、旧生成图和状态名称不是独立证据/);
  assert.doesNotMatch(skill, /科尔|海兽王|艾娃|麦迪逊|424|428/);
});

test('derive states inherit default clothing and footwear unless a source authorizes a change', () => {
  const skill = read('data/skills/production_execution_derive_assets.md');
  assert.match(skill, /服装类别、剪裁、颜色、鞋履、发型和配饰继承父资产已确认的默认设计/);
  assert.match(skill, /受伤、湿衣、落水、逃生或床上惊醒不能凭空增加包扎、治疗痕迹、救援装备、新服装或脱鞋/);
  assert.match(skill, /不能把默认裙装写成裤管破损/);
  assert.match(skill, /确有明确换装或变身设计时逐项落实/);
  assert.match(skill, /不能伪称原文/);
  assert.match(skill, /禁止用“赤脚或低跟鞋”等互斥多选/);
});

test('reusable derive references exclude interactions, transient lighting and scene UI', () => {
  const skill = read('data/skills/production_execution_derive_assets.md');
  assert.match(skill, /不包含另一资产、互动对象、剧情动作、屏幕文字或一次性光效/);
  assert.match(skill, /系统光映脸及白光转场交给分镜/);
  assert.match(skill, /明确持续附着于角色的形变或发光纹路可作为状态/);
  assert.match(skill, /纯机位变化、局部特写、系统面板、倒计时或屏幕内容变化不创建场景衍生/);
  assert.match(skill, /动态UI不烘焙进场景参考/);
});

test('authorized derive repairs update real IDs and verify readback without generating media', () => {
  const skill = read('data/skills/production_execution_derive_assets.md');
  assert.match(skill, /用户具体要求修复或更新已有项时.*以真实衍生ID修正/);
  assert.match(skill, /更新已存在项须传真实衍生 ID/);
  assert.match(skill, /写入后再次调用 `get_flowData\(\{key:"assets"\}\)`/);
  assert.match(skill, /工具回执与回读一致才计入完成数/);
  assert.match(skill, /无新增、无获准修复项/);
  assert.match(skill, /不执行图片、音频或视频生成/);
  assert.match(skill, /不得因可用工具较多而调用其他副作用工具/);
  assert.match(skill, /不得将描述修正宣称为图片已经修复/);
});

test('derive receipt IDs distinguish identical failed retries from a new revision', () => {
  const skill = read('data/skills/production_execution_derive_assets.md');
  assert.match(skill, /仅完全同参数的失败或超时重试才复用/);
  assert.match(skill, /修改 `name`、`desc`、父ID或目标ID，就是新的写操作/);
  assert.match(skill, /省略 `requestId` 让后端生成新标识/);
  assert.match(skill, /不能把上次成功回执或错误给出的旧 `requestId` 用于不同参数/);
  assert.match(skill, /不为匹配旧回执把内容改回旧稿/);
});

test('global asset design requires an explicit source before separating evacuation gear from default clothing', () => {
  const skill = read('data/skills/asset_visual_design.md');
  assert.match(skill, /只有剧本、用户或当前明确采用的视觉设计要求新增撤离装备时，才与默认衣装分态设计/);
  assert.match(skill, /逃生情境本身不授权新增装备，未明确改变的衣装与鞋履沿用已确认默认设计/);
  assert.doesNotMatch(skill, /灾前默认时装与暴雨撤离装备分别设计/);
});

test('non-graphic injury staging preserves source facts without inventing treatment or rescue gear', () => {
  const skill = read('data/skills/asset_visual_design.md');
  assert.match(skill, /优先现有衣物与构图遮挡、疼痛和行动后果/);
  assert.match(skill, /仅明确有包扎来源时保留包扎，不能为非血腥表现新增治疗或救援装备/);
  assert.doesNotMatch(skill, /优先衣物遮挡、干净包扎、疼痛动作/);
  assert.match(skill, /必要的少量血迹明确为绿色或黑色/);
  assert.match(skill, /已指定绿色或黑色时沿用；未指定且必须表现时统一低饱和深绿色/);
  assert.match(skill, /红衣、红灯、红瞳、锈蚀、自然唇色等非血液特征保持原设定/);
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
