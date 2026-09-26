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
  assert.equal(withNonGraphicVisuals(constrained), constrained);
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

test("H3 receives global visual constraints before its first shot while audio, dialogue and references stay intact", () => {
  const constrained = withNonGraphicVisuals(h3Prompt);
  const constraintIndex = constrained.indexOf("Visual content constraint:");
  assert.ok(constraintIndex > constrained.indexOf("detailed_description:"));
  assert.ok(constraintIndex < constrained.indexOf("Soft light"));
  assert.ok(constraintIndex < constrained.indexOf("[Shot 1] <Subject"));
  assert.equal(constrained.slice(constrained.indexOf("overall_soundscape:")), h3Prompt.slice(h3Prompt.indexOf("overall_soundscape:")));
  assert.equal(constrained.slice(constrained.indexOf("non_diegetic_music:") + "non_diegetic_music:".length).trim(), "N/A");
  assert.deepEqual(constrained.match(/<d>[\s\S]*?<\/d>/g), h3Prompt.match(/<d>[\s\S]*?<\/d>/g));
  assert.deepEqual(constrained.match(/<(?:Picture|Subject) \d+>/g), h3Prompt.match(/<(?:Picture|Subject) \d+>/g));
  assert.equal(withNonGraphicVisuals(constrained), constrained);
});

test("H3 chapter detection ignores literal headings inside spoken text", () => {
  const spoken = h3Prompt.replace("Keep this exact wording.", "Read the next labels:\nsummary:\nnon_diegetic_music:\nThese are the spoken words.");
  const constrained = withNonGraphicVisuals(spoken);
  assert.ok(constrained.indexOf("Visual content constraint:") < constrained.indexOf("[Shot 1] <Subject"));
  assert.equal(constrained.slice(constrained.lastIndexOf("non_diegetic_music:") + "non_diegetic_music:".length).trim(), "N/A");
  assert.deepEqual(constrained.match(/<d>[\s\S]*?<\/d>/g), spoken.match(/<d>[\s\S]*?<\/d>/g));
  assert.equal(withNonGraphicVisuals(constrained), constrained);
});

test("legacy trailing H3 constraints are relocated and repeated copies collapse to one", () => {
  const constraint = withNonGraphicVisuals("").trim();
  const legacy = `${h3Prompt}\n\n${constraint}\n\n${constraint}`;
  const constrained = withNonGraphicVisuals(legacy);
  assert.equal(constrained.split("Visual content constraint:").length - 1, 1);
  assert.ok(constrained.indexOf("Visual content constraint:") < constrained.indexOf("[Shot 1] <Subject"));
  assert.equal(constrained.slice(constrained.indexOf("non_diegetic_music:") + "non_diegetic_music:".length).trim(), "N/A");
  assert.equal(withNonGraphicVisuals(constrained), constrained);
});

test("both text modes and both visual generation boundaries apply the shared policy", () => {
  const source = readFileSync(new URL("../src/utils/ai.ts", import.meta.url), "utf8");
  assert.equal(source.match(/system: withContentConstraints\(input.system\)/g)?.length, 2);
  for (const name of ["AiImage", "AiVideo"]) {
    const body = source.split(`class ${name} {`)[1].split("\nclass ")[0];
    assert.match(body, /prompt: withNonGraphicVisuals\(input.prompt\)/);
  }
});
