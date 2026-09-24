import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssetImagePrompt,
  buildFluxPromptTranslationRequest,
  needsFluxPromptTranslation,
} from "../src/utils/assetPrompt";

test("role runtime prompt only enforces the front/back layout", () => {
  const result = buildAssetImagePrompt(
    "role",
    "写实国风",
    "顾清寒",
    "头顶到锁骨的人像特写，面部占主体；全身从头顶到脚底完整展示",
  );

  assert.match(result, /^CHARACTER TURNAROUND SHEET/);
  assert.match(result, /exactly two panels in one horizontal row/);
  assert.match(result, /Panel 1: full-body front view/);
  assert.match(result, /Panel 2: full-body back view/);
  assert.doesNotMatch(result, /phone camera|DSLR photography|not a photograph/);
  assert.match(result, /layout contract above has priority/);
  assert.match(result, /顾清寒/);
});

test("Chinese FLUX prompts are detected and translated with a strict visual-fact contract", () => {
  assert.equal(needsFluxPromptTranslation("深棕色低马尾，黑色短靴"), true);
  assert.equal(needsFluxPromptTranslation("deep brown low ponytail, black ankle boots"), false);

  const request = buildFluxPromptTranslationRequest("左眼下一颗泪痣，四栏角色设定图");
  assert.match(request.system, /Preserve every concrete visual fact/);
  assert.match(request.system, /contains no Chinese characters/);
  assert.equal(request.user, "左眼下一颗泪痣，四栏角色设定图");
});

test("scene and prop prompts do not receive a character turnaround contract", () => {
  const scene = buildAssetImagePrompt("scene", "电影感", "庭院", "雨夜石板路");
  const prop = buildAssetImagePrompt("tool", "写实", "长剑", "黑色剑鞘");

  assert.doesNotMatch(scene, /CHARACTER TURNAROUND SHEET/);
  assert.doesNotMatch(prop, /CHARACTER TURNAROUND SHEET/);
  assert.match(scene, /production-ready scene design reference render/);
  assert.match(prop, /production-ready prop design reference render/);
  assert.doesNotMatch(scene, /phone camera|DSLR photography|not a photograph/);
  assert.doesNotMatch(prop, /phone camera|DSLR photography|not a photograph/);
});
