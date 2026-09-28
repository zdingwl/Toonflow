import test from "node:test";
import assert from "node:assert/strict";
import { assertH3PromptContract, h3FormatChecklist, normalizeH3DialogueLocales, normalizeH3PromptFormat } from "../src/utils/h3PromptContract";

const valid = `subject_definitions:
<Subject 1> is Ava from <Picture 1>, with long black hair and a beige outfit.
<Subject 2> is the stormy ocean liner environment from <Picture 2>.
summary:
[reference generation] <Subject 1> crosses the deck of <Subject 2> and calls for help.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - Identity and clothing remain stable.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - The deck layout and storm lighting remain stable.
detailed_description:
Cinematic semi-realistic 3D animation matching the supplied character and environment references.
[Shot 1] <Subject 1> runs across the tilted deck of <Subject 2> as the camera tracks beside her and waves strike the hull.
[Shot 2] At 00:04.500, the camera cuts close as <Subject 1> (S1) looks toward the rail and calls, <d>[English] Help me!</d>
overall_soundscape:
Storm wind, waves, wet footsteps and stressed metal continue across both shots.
non_diegetic_music:
Low tense strings rise softly beneath the storm.`;

test("official six-section Ref2VA prompt passes", () => {
  assert.doesNotThrow(() => assertH3PromptContract(valid, 11, 2));
});

test("source-language dialogue and explicitly quoted visible text remain valid before localization", () => {
  const localizedSource = valid
    .replace("calls for help.", "shows the visible screen text 『系统已绑定』.")
    .replace("<d>[English] Help me!</d>", "<d>[Chinese] 快跑.</d>");
  assert.doesNotThrow(() => assertH3PromptContract(localizedSource, 11, 2));
});

test("explicitly labelled standalone source-language title text remains valid before localization", () => {
  const localizedSource = valid.replace(
    "[Shot 1] <Subject 1>",
    "[Shot 1] Static title text appears on screen:\n第一集：重生。\n<Subject 1>",
  );
  assert.doesNotThrow(() => assertH3PromptContract(localizedSource, 11, 2));
});

test("missing, reordered, duplicated and prefaced sections are rejected", () => {
  assert.throws(() => assertH3PromptContract(valid.replace(/^subject_definitions:[\s\S]*?(?=^summary:)/m, ""), 11, 2), /六个章节不完整/);
  assert.throws(() => assertH3PromptContract(valid.replace("subject_definitions:", "Preamble\nsubject_definitions:"), 11, 2), /额外正文/);
  assert.throws(() => assertH3PromptContract(valid.replace("summary:", "__SUMMARY__:").replace("retention_analysis:", "summary:").replace("__SUMMARY__:", "retention_analysis:"), 11, 2), /官方顺序|章节/);
});

test("generation checklist requires official structure, shots and speaker IDs", () => {
  assert.match(h3FormatChecklist, /exactly six complete English sections/i);
  assert.match(h3FormatChecklist, /subject_definitions/);
  assert.match(h3FormatChecklist, /\(Sx\)/);
  assert.doesNotMatch(h3FormatChecklist, /Do not use a fixed section template/);
});

test("invalid Picture slots, shot times and dialogue speakers are rejected", () => {
  assert.throws(() => assertH3PromptContract(valid.replace(/<Picture 2>/g, "<Picture 3>"), 11, 2), /Picture 槽位/);
  assert.throws(() => assertH3PromptContract(valid.replace("[Shot 2] At 00:04.500,", "[Shot 2] At 00:11.000,"), 11, 2), /目标时长/);
  assert.throws(() => assertH3PromptContract(valid.replace("<Subject 1> (S1) looks", "<Subject 1> looks"), 11, 2), /说话人/);
  assert.throws(() => assertH3PromptContract(valid.replace("Help me!</d>", "Help me</d>"), 11, 2), /句号、问号或感叹号/);
});

test("empty, oversized and unsafe prompts are rejected", () => {
  assert.throws(() => assertH3PromptContract("  ", 11, 0), /内容不能为空/);
  assert.throws(() => assertH3PromptContract("x".repeat(30_001), 11, 0), /长度不能超过/);
  assert.throws(() => assertH3PromptContract("safe\u0000text", 11, 0), /非法控制字符/);
});

test("normalization changes locale placement and explicit cut-time spelling only", () => {
  assert.equal(normalizeH3DialogueLocales("<d>[English] (en-US) Hello.</d>"), "(spoken locale: en-US) <d>[English] Hello.</d>");
  assert.equal(
    normalizeH3PromptFormat("Free prose.\n[Shot 2] At 4.5: move.\n<d>[English] Keep “quoted” speech.</d>"),
    'Free prose.\n[Shot 2] At 00:04.500, move.\n<d>[English] Keep “quoted” speech.</d>',
  );
});
