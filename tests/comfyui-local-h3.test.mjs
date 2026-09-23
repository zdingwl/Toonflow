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
