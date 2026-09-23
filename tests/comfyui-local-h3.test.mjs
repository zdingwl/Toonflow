import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../data/vendor/comfyui_local.ts", import.meta.url), "utf8");

test("Ref2VA uses the MiniMax H3 four-step Turbo LoRA", () => {
  assert.match(source, /h3RefLora:\s*"minimax_h3_ref2v_turbo_4step_v0\.1_comfyui_bf16\.safetensors"/);
  assert.match(source, /h3RefLoraStrength:\s*"1\.0",\s*h3RefSteps:\s*"4"/);
  assert.match(source, /graph\["15"\]\s*=\s*\{\s*class_type:\s*"LoraLoaderModelOnly"/);
  assert.match(source, /"7":\s*\{\s*class_type:\s*"BasicGuider",\s*inputs:\s*\{\s*model:\s*referenceMode\s*\?\s*\["15", 0\]\s*:\s*\["1", 0\]/);
  assert.match(source, /"9":\s*\{\s*class_type:\s*"BasicScheduler",\s*inputs:\s*\{\s*model:\s*referenceMode\s*\?\s*\["15", 0\]\s*:\s*\["1", 0\]/);
});

test("FL2VA retains its independent non-LoRA step setting", () => {
  assert.match(source, /setting\(referenceMode\s*\?\s*"h3RefSteps"\s*:\s*"h3Steps",\s*referenceMode\s*\?\s*"4"\s*:\s*"20"\)/);
});
