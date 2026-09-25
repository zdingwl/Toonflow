import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssetImagePrompt,
  buildFluxPromptTranslationRequest,
  needsFluxPromptTranslation,
} from "../src/utils/assetPrompt";

test("role runtime prompt enforces the canonical four-view layout", () => {
  const result = buildAssetImagePrompt(
    "role",
    "写实国风",
    "顾清寒",
    "头顶到锁骨的人像特写，面部占主体；全身从头顶到脚底完整展示",
  );

  assert.match(result, /^CHARACTER TURNAROUND SHEET/);
  assert.match(result, /exactly four panels in one horizontal row/);
  assert.match(result, /Panel 1: straight-on head-and-shoulders portrait/);
  assert.match(result, /Panel 2: full-body front view/);
  assert.match(result, /Panel 3: full-body strict 90-degree left side view/);
  assert.match(result, /Panel 4: full-body straight back view/);
  assert.doesNotMatch(result, /phone camera|DSLR photography|not a photograph/);
  assert.match(result, /layout contract above has priority/);
  assert.match(result, /顾清寒/);
});

test("Chinese FLUX prompts are detected and translated with a strict visual-fact contract", () => {
  assert.equal(needsFluxPromptTranslation("深棕色低马尾，黑色短靴"), true);
  assert.equal(needsFluxPromptTranslation("deep brown low ponytail, black ankle boots"), false);

  const request = buildFluxPromptTranslationRequest("左眼下一颗泪痣，四栏角色设定图");
  assert.match(request.system, /Preserve concrete visual facts, identity markers, outfits, hairstyles/);
  assert.match(request.system, /Apply global content constraints/);
  assert.match(request.system, /Preserve unrelated red clothing/);
  assert.match(request.system, /contains no Chinese characters/);
  assert.equal(request.user, "左眼下一颗泪痣，四栏角色设定图");
});

test("scene and prop prompts do not receive a character turnaround contract", () => {
  const scene = buildAssetImagePrompt("scene", "电影感", "庭院", "雨夜石板路");
  const prop = buildAssetImagePrompt("tool", "写实", "长剑", "黑色剑鞘");

  assert.doesNotMatch(scene, /CHARACTER TURNAROUND SHEET/);
  assert.doesNotMatch(prop, /CHARACTER TURNAROUND SHEET/);
  assert.match(scene, /production-ready scene design reference render/);
  assert.match(prop, /production-ready prop or creature design reference render/);
  assert.doesNotMatch(scene, /phone camera|DSLR photography|not a photograph/);
  assert.doesNotMatch(prop, /phone camera|DSLR photography|not a photograph/);
});


test("scene, ordinary prop and creature references keep full design facts with a single-view default", () => {
  const sceneFacts = "东侧入口通向木桥，桥北为仓库，傍晚暖光照亮潮湿木纹。";
  const scene = buildAssetImagePrompt("scene", "半写实国漫3D", "码头", sceneFacts);
  assert.ok(scene.includes(sceneFacts));
  assert.match(scene, /one coherent scene image with readable spatial relationships and access paths/);
  for (const facts of [
    "银色手机，蓝色屏幕，三摄像头与窄边框。",
    "巨鲨，蓝灰色背部、白色腹部、高背鳍，完整鱼尾与自然游动姿态。",
    "用户明确要求四视图，展示同一巨鲨的正面、侧面、背面和细节。",
  ]) {
    const result = buildAssetImagePrompt("tool", "半写实国漫3D", "参考主体", facts);
    assert.ok(result.includes(facts));
    assert.match(result, /Default to one clear main view of a single subject/);
    assert.match(result, /multi-view layout only when explicitly required by the design facts/);
    assert.match(result, /living creatures preserve natural anatomy and posture/);
    assert.doesNotMatch(result, /inanimate|still life|held in a hand/);
  }
});
