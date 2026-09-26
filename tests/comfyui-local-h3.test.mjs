import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transform } from "sucrase";
import test from "node:test";

const source = await readFile(new URL("../data/vendor/comfyui_local.ts", import.meta.url), "utf8");

test("H3 submission preserves spoken Picture labels without mistaking them for uploaded sources", () => {
  const body = source.match(/function compileReferencePrompt\([\s\S]*?(?=\/\/ Same native)/)?.[0];
  assert.ok(body);
  const compile = vm.runInNewContext(`${transform(body, { transforms: ["typescript"] }).code}; compileReferencePrompt`, { referenceLabel: () => "character" });
  const prompt = 'subject_definitions:\n<Subject 1> is the character in <Picture 1>.\ndetailed_description:\n[Shot 1] <Subject 1> (S1) says <d>[English] The label is <Picture 99>.</d>';
  const config = { prompt, referenceList: [{ type: "image", path: "character.png" }] };
  assert.equal(compile(config), prompt);
  assert.throws(() => compile({ ...config, prompt: prompt.replace("in <Picture 1>", "in <Picture 2>") }), /槽位/);
});

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

test("H3 only offers 768p and keeps native dimensions on the 32-pixel grid", () => {
  assert.match(source, /resolution:\s*\["768p"\]/);
  const body = source.match(/function sizeForVideo\([\s\S]*?(?=function referenceLabel)/)?.[0].trim();
  assert.ok(body, "H3 size calculator is present");
  const sizeForVideo = vm.runInNewContext(`${transform(body, { transforms: ["typescript"] }).code}; sizeForVideo`);
  assert.deepEqual(JSON.parse(JSON.stringify(sizeForVideo("768p", "16:9"))), { width: 1344, height: 768 });
  assert.deepEqual(JSON.parse(JSON.stringify(sizeForVideo("768p", "9:16"))), { width: 768, height: 1344 });
  for (const ratio of ["1:1", "4:3", "3:4", "21:9"]) {
    const size = sizeForVideo("768p", ratio);
    assert.equal(size.width % 32, 0);
    assert.equal(size.height % 32, 0);
    assert.ok(size.width * size.height <= 1344 * 768);
  }
  for (const resolution of ["480p", "720p"]) assert.throws(() => sizeForVideo(resolution, "16:9"), /分辨率无效/);
  assert.match(source, /config = \{ \.\.\.config, resolution: "768p" \}/);
  assert.throws(() => sizeForVideo("1080p", "16:9"), /分辨率无效/);
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
