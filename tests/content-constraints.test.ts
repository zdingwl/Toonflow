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
  assert.equal(withContentConstraints().length, 2);
});

test("media boundary leaves the final prompt untouched; visual direction is system context", () => {
  const original = "<Picture 1> Ava wears a red jacket. <Subject 2> 帮她包扎。";
  const constrained = withNonGraphicVisuals(original);
  assert.equal(constrained, original);
  assert.equal(withNonGraphicVisuals(constrained), constrained);
  assert.match(withContentConstraints().at(-1)?.content || "", /Never depict red blood or red wounds/);
});

const h3Prompt = `subject_definitions:
<Subject 1> is the woman in <Picture 1>, with black hair and a red jacket.
summary:
[reference generation] <Subject 1> turns toward the doorway.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - Identity and clothes remain consistent.
detailed_description:
Soft light falls across textured fabric and natural skin.
[Shot 1] <Subject 1> (S1) turns and says, <d>[English] Keep this exact wording.</d>
overall_soundscape:
Wind passes through the doorway.
non_diegetic_music:
N/A`;

test("free-form H3 is not rewritten with a trailing global visual constraint", () => {
  const constrained = withNonGraphicVisuals(h3Prompt);
  assert.equal(constrained, h3Prompt);
  assert.equal(withNonGraphicVisuals(constrained), constrained);
});

test("literal headings inside spoken text are ignored when detecting an existing constraint", () => {
  const spoken = h3Prompt.replace("Keep this exact wording.", "Read the next labels:\nsummary:\nnon_diegetic_music:\nThese are the spoken words.");
  assert.equal(withNonGraphicVisuals(spoken), spoken);
});

test("legacy inline constraints are not added to new prompts", () => {
  assert.equal(withNonGraphicVisuals(h3Prompt), h3Prompt);
});

test("both text modes and both visual generation boundaries apply the shared policy", () => {
  const source = readFileSync(new URL("../src/utils/ai.ts", import.meta.url), "utf8");
  assert.equal(source.match(/system: withContentConstraints\(input.system\)/g)?.length, 2);
  for (const name of ["AiImage", "AiVideo"]) {
    const body = source.split(`class ${name} {`)[1].split("\nclass ")[0];
    assert.match(body, /prompt: withNonGraphicVisuals\(input.prompt\)/);
  }
});
