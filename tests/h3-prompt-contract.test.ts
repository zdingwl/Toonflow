import test from "node:test";
import assert from "node:assert/strict";
import {
  assertH3PromptContract,
  h3FormatChecklist,
  normalizeH3DialogueLocales,
  normalizeH3PromptFormat,
} from "../src/utils/h3PromptContract";

const freePrompt = `A cinematic storm sequence using <Picture 1> for Ava and <Picture 2> for the ocean liner.

The camera tracks Ava across the tilted deck while cloth, hair and spray react naturally to the wind.
<Subject 1> (S1) says <d>[English] Hold on.</d>
Synchronized waves, stressed metal and dialogue continue under the shot.`;

test("free-form H3 prompts pass without six named sections", () => {
  assert.doesNotThrow(() => assertH3PromptContract(freePrompt, 11, 2));
});

test("Markdown headings, prefaces and code fences are not format errors", () => {
  const prompt = `Final generation prompt\n\n## Opening\n\`\`\`text\n${freePrompt}\n\`\`\``;
  assert.doesNotThrow(() => assertH3PromptContract(prompt, 11, 2));
});

test("the generation instruction explicitly rejects a fixed section template", () => {
  assert.match(h3FormatChecklist, /Generate the final MiniMax H3 cinematic video prompt/);
  assert.match(h3FormatChecklist, /Do not use a fixed section template/);
  assert.doesNotMatch(h3FormatChecklist, /six sections|subject_definitions|retention_analysis/i);
});

test("empty, oversized and unsafe prompts are rejected", () => {
  assert.throws(() => assertH3PromptContract("  ", 11, 0), /内容不能为空/);
  assert.throws(() => assertH3PromptContract("x".repeat(30_001), 11, 0), /长度不能超过/);
  assert.throws(() => assertH3PromptContract("safe\u0000text", 11, 0), /非法控制字符/);
});

test("Picture references still have to match the actual uploaded slots", () => {
  assert.throws(() => assertH3PromptContract("Use <Picture 1> only.", 11, 2), /Picture 槽位/);
  assert.throws(() => assertH3PromptContract("Use <Picture 1> and <Picture 3>.", 11, 2), /Picture 槽位/);
});

test("basic dialogue tag safety remains without restricting prompt layout", () => {
  assert.throws(() => assertH3PromptContract("Use <Picture 1>. <d>hello", 11, 1), /未闭合/);
  assert.throws(() => assertH3PromptContract("Use <Picture 1>. </d>", 11, 1), /没有对应/);
});

test("normalization changes locale placement and explicit cut-time spelling only", () => {
  assert.equal(
    normalizeH3DialogueLocales("<d>[English] (en-US) Hello.</d>"),
    "(spoken locale: en-US) <d>[English] Hello.</d>",
  );
  assert.equal(
    normalizeH3PromptFormat("Free prose.\n[Shot 2] At 4.5: move.\n<d>[English] Keep “quoted” speech.</d>"),
    'Free prose.\n[Shot 2] At 00:04.500, move.\n<d>[English] Keep “quoted” speech.</d>',
  );
});
