import test from "node:test";
import assert from "node:assert/strict";
import { assertH3PromptContract, normalizeH3DialogueLocales } from "../src/utils/h3PromptContract";

const valid = `subject_definitions:
<Subject 1> is the woman in <Picture 1> (face) and <Picture 2> (body), wearing the red sweater and black skirt from the references.
summary:
[reference generation] <Subject 1> turns and speaks on deck.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - Face, hair, red sweater and black skirt remain consistent.
detailed_description:
Semi-realistic 3D with restrained eye proportions, fine hair strands and textured skin and cloth.
[Shot 1] A medium view follows <Subject 1> turning on deck.
[Shot 2] At 00:03.000, the camera cuts to <Subject 1> (S1), who says with an American accent, <d>[English] Hello.</d>
overall_soundscape:
Wind and creaking metal.
non_diegetic_music:
N/A`;

test("official Ref2VA tracks the subject formed by two images, not two source-image retention rows", () => {
  assert.doesNotThrow(() => assertH3PromptContract(valid, 6, 2));
  assert.throws(() => assertH3PromptContract(valid.replace('<Subject 1> (appears in', '<Picture 1> (appears in'), 6, 2), /保留分析/);
});
test("rejects the observed locale attribute dialogue and malformed timelines", () => {
  assert.throws(() => assertH3PromptContract(valid.replace('<d>[English]', '<d en-US>'), 6, 2), /对白必须/);
  assert.throws(() => assertH3PromptContract(valid.replace('00:03.000', '00:06.000'), 6, 2), /目标时长/);
  assert.throws(() => assertH3PromptContract(valid.replace('[Shot 1] A', '[Shot 1] At 00:00.000, A'), 6, 2), /Shot 1/);
});
test("rejects undefined subjects, missing style opening, reordered sections and wrong source slots", () => {
  assert.throws(() => assertH3PromptContract(valid.replace('follows <Subject 1>', 'follows <Subject 2>'), 6, 2), /未定义/);
  assert.throws(() => assertH3PromptContract(valid.replace(/Semi-realistic[^\n]+\n/, ''), 6, 2), /画风/);
  assert.throws(() => assertH3PromptContract(valid.replace('summary:', 'summary_wrong:'), 6, 2), /六个章节/);
  assert.throws(() => assertH3PromptContract(valid, 6, 3), /槽位/);
  assert.throws(() => assertH3PromptContract(valid.replace('Semi-realistic 3D', '半写实3D'), 6, 2), /英文/);
  assert.doesNotThrow(() => assertH3PromptContract(valid.replace('[English] Hello.', '[Chinese] 你好。'), 6, 2));
});

for (const { language, locale, dialogue } of [
  { language: "English", locale: "en-US", dialogue: "Ocean Infrastructure System binding complete. Your first raft has been credited." },
  { language: "Chinese", locale: "zh-CN", dialogue: "海洋基建系统已绑定，第一块木筏已到账。" },
  { language: "Chinese", locale: "zh-Hant-TW", dialogue: "海洋基建系統已綁定。" },
]) {
  test("moves only the leading " + locale + " dialogue metadata outside the spoken text", () => {
    const originalDialogue = "<d>[English] Hello.</d>";
    const spoken = "<d>[" + language + "] " + dialogue + "</d>";
    const input = valid.replace(originalDialogue, "<d>[" + language + "] (" + locale + ") " + dialogue + "</d>");
    const expected = valid.replace(originalDialogue, "(spoken locale: " + locale + ") " + spoken);
    assert.throws(() => assertH3PromptContract(input, 6, 2), /地区标记必须写在标签外/);
    const result = normalizeH3DialogueLocales(input);
    // Full-string equality also protects Subject/Picture labels, shot timing and all prose.
    assert.equal(result, expected);
    assert.doesNotThrow(() => assertH3PromptContract(result, 6, 2));
    assert.equal(normalizeH3DialogueLocales(result), result);
  });
}

test("keeps metadata already outside dialogue and ordinary locale mentions inside speech unchanged", () => {
  for (const dialogue of [
    "(spoken locale: en-US) <d>[English] Hello.</d>",
    "<d>[English] The setting is (en-US), as printed.</d>",
    "<d>[English] (in-law) is the word on the card.</d>",
    "<d>[Chinese] 请保留设置中的 (zh-CN) 字样。</d>",
  ]) {
    const input = valid.replace("<d>[English] Hello.</d>", dialogue);
    assert.equal(normalizeH3DialogueLocales(input), input);
    assert.doesNotThrow(() => assertH3PromptContract(input, 6, 2));
  }
});
