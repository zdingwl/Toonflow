import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withContentConstraints, withNonGraphicVisuals } from "../src/utils/contentConstraints";

test("global rules preserve existing system instructions and metadata without mutating callers", () => {
  const existing = [{ role: "system" as const, content: "Return JSON with unchanged reference slots", providerOptions: { test: { cache: true } } }];
  const result = withContentConstraints(existing);
  assert.equal(existing.length, 1);
  assert.equal(result[0], existing[0]);
  assert.match(result[1].content, /所有项目、风格和语言/);
  assert.match(result[1].content, /仅原文引用和事实核对的来源字段须忠实保留/);
  assert.match(result[1].content, /不全局禁用红色/);
  assert.equal(withContentConstraints("Original format")[0].content, "Original format");
  assert.equal(withContentConstraints(existing[0])[0], existing[0]);
  assert.equal(withContentConstraints().length, 1);
});

test("media boundary adds non-graphic injury direction while preserving identity and slot tokens", () => {
  const original = "<Picture 1> Ava wears a red jacket. <Subject 2> 帮她包扎。";
  const constrained = withNonGraphicVisuals(original);
  assert.ok(constrained.startsWith(original));
  assert.match(constrained, /Never depict red blood or red wounds/);
  assert.match(constrained, /GREEN or BLACK blood/);
  assert.match(constrained, /preserve an explicitly established green or black choice/);
  assert.match(constrained, /Preserve red clothing/);
  assert.deepEqual(constrained.match(/<(?:Picture|Subject) \d+>/g), original.match(/<(?:Picture|Subject) \d+>/g));
});

test("both text modes and both visual generation boundaries apply the shared policy", () => {
  const source = readFileSync(new URL("../src/utils/ai.ts", import.meta.url), "utf8");
  assert.equal(source.match(/system: withContentConstraints\(input.system\)/g)?.length, 2);
  for (const name of ["AiImage", "AiVideo"]) {
    const body = source.split(`class ${name} {`)[1].split("\nclass ")[0];
    assert.match(body, /prompt: withNonGraphicVisuals\(input.prompt\)/);
  }
});
