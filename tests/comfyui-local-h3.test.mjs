import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../data/vendor/comfyui_local.ts", import.meta.url), "utf8");

test("native MiniMax H3 workflows do not load Turbo LoRA", () => {
  assert.doesNotMatch(source, /LoraLoaderModelOnly/);
  assert.doesNotMatch(source, /h3RefLora|h3RefSteps|turbo_4step/i);
  assert.match(source, /"7":\s*\{\s*class_type:\s*"BasicGuider",\s*inputs:\s*\{\s*model:\s*\["1", 0\]/);
  assert.match(source, /"9":\s*\{\s*class_type:\s*"BasicScheduler",\s*inputs:\s*\{\s*model:\s*\["1", 0\]/);
});

test("Ref2VA and FL2VA use the standard 20-step setting", () => {
  assert.match(source, /h3Steps:\s*"20"/);
  assert.match(source, /setting\("h3Steps",\s*"20"\)/);
});

test("Qwen Image 2.1 uses the official native ComfyUI text-to-image graph", () => {
  assert.match(source, /modelName:\s*"qwen-image-2\.1-local"/);
  assert.match(source, /class_type:\s*"TextEncodeQwenImage21"/);
  assert.match(source, /type:\s*"qwen_image"/);
  assert.match(source, /qwen_image_2\.1_int8_convrot\.safetensors/);
  assert.match(source, /qwen3vl_8b_int8_convrot\.safetensors/);
  assert.match(source, /qwen_image_2\.1_vae_bf16\.safetensors/);
  assert.match(source, /steps, cfg:\s*1, sampler_name:\s*"euler", scheduler:\s*"simple"/);
});

test("Qwen Image 2.1 supports native 2K output and keeps FLUX as a separate model", () => {
  assert.match(source, /const maxSide = config\.size === "1K" \? 1024 : 2048/);
  assert.match(source, /model\.modelName === "qwen-image-2\.1-local"/);
  assert.match(source, /model\.modelName === "flux-schnell-local"/);
});
