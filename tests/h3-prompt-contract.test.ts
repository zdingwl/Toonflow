import test from "node:test";
import assert from "node:assert/strict";
import { assertH3PromptContract, normalizeH3DialogueLocales, normalizeH3PromptFormat } from "../src/utils/h3PromptContract";

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

test("missing definitions are rejected for a complete rewrite, not synthesized from slot numbers", () => {
  const partial = valid.slice(valid.indexOf("summary:")).replace("<Subject 1> (appears in [Shot 1], [Shot 2]):", "<Subject 1> appears in [Shot 1], and [Shot 2]:");
  assert.throws(() => assertH3PromptContract(partial, 6, 1), /缺少：subject_definitions/);
  const normalized = normalizeH3PromptFormat(partial);
  assert.throws(() => assertH3PromptContract(normalized, 6, 1), /缺少：subject_definitions/);
  assert.match(normalized, /<Subject 1> \(appears in \[Shot 1\], and \[Shot 2\]\):/);
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

test("canonicalizes explicit cut formatting without changing the cut time or quoted speech", () => {
 for (const stamp of ["0:03.0，", "00:03:", "00:03.000,", "03.000,"]) {
 const input=valid.replace("00:03.000,",stamp);
 assert.equal(normalizeH3PromptFormat(input),valid);
 }
 const missing=valid.replace("At 00:03.000,", "Close-up:");
 assert.equal(normalizeH3PromptFormat(missing),missing);
 assert.throws(()=>assertH3PromptContract(missing,6,2),/Shot 2/);
 const visible=valid.replace("Wind and creaking metal.","The screen reads “确认”.");
 assert.doesNotThrow(()=>assertH3PromptContract(visible,6,2));
});

test("references must be used in detailed_description and retention cannot cite absent shots", () => {
  const unused = valid.replace("follows <Subject 1>", "follows Ava").replace("to <Subject 1> (S1)", "to Ava (S1)");
  assert.throws(() => assertH3PromptContract(unused, 6, 2), /未在 detailed_description 中使用/);
  assert.throws(() => assertH3PromptContract(unused.replace("Hello.", "<Subject 1> is a label."), 6, 2), /未在 detailed_description 中使用/);
  assert.throws(() => assertH3PromptContract(valid.replace("appears in [Shot 1], [Shot 2]", "appears in [Shot 1], [Shot 3]"), 6, 2), /不存在的 \[Shot 3\]/);
});

test("dialogue needs well-nested tags and an explicit speaker for every vocal event", () => {
  assert.throws(() => assertH3PromptContract(valid.replace(" (S1)", ""), 6, 2), /每次对白需要/);
  assert.throws(() => assertH3PromptContract(valid.replace("Hello.", "Hello. <d>[English] Again.</d>"), 6, 2), /不得嵌套/);
  assert.throws(() => assertH3PromptContract(valid.replace("<d>[English] Hello.</d>", "</d><d>[English] Hello."), 6, 2), /没有对应/);
  assert.throws(() => assertH3PromptContract(valid.replace("</d>", ""), 6, 2), /未闭合/);
  assert.throws(() => assertH3PromptContract(valid.replace("Hello.", ""), 6, 2), /对白必须/);
  assert.throws(() => assertH3PromptContract(valid.replace("Hello.</d>", "Hello.</d> Then she says <d>[English] Again.</d>"), 6, 2), /每次对白需要/);
});

test("spoken shot labels remain exact text rather than camera cuts", () => {
  const spoken = valid.replace("Hello.", "Read this:\n[Shot 9] At 0:03.0， then close the editor.");
  assert.equal(normalizeH3PromptFormat(spoken), spoken);
  assert.doesNotThrow(() => assertH3PromptContract(spoken, 6, 2));
});

test("spoken reference labels do not create visual sources or satisfy required image slots", () => {
  const spoken = valid.replace("Hello.", 'The label reads "<Subject 99> <Picture 99> <Video 99> <Audio 99>".');
  assert.doesNotThrow(() => assertH3PromptContract(spoken, 6, 2));
  const omittedSource = spoken.replace(" and <Picture 2> (body)", "").replace("<Picture 99>", "<Picture 2>");
  assert.throws(() => assertH3PromptContract(omittedSource, 6, 2), /槽位/);
});

test("speaker IDs form a contiguous set and stay bound to the same referenced subject", () => {
  assert.throws(() => assertH3PromptContract(valid.replace("(S1)", "(S2)"), 6, 2), /连续编号，不能缺号/);
  const secondLine = valid.replace("Hello.</d>", "Hello.</d> <Subject 1> (S2) adds, <d>[English] Stay.</d>");
  assert.throws(() => assertH3PromptContract(secondLine, 6, 2), /同一 Subject/);
  assert.doesNotThrow(() => assertH3PromptContract(secondLine.replace("<Subject 1> (S2)", "<Subject 1> (S1)"), 6, 2));
  const sharedId = valid.replace("summary:\n", "<Subject 2> is a second woman in <Picture 2>.\nsummary:\n")
    .replace("detailed_description:\n", "<Subject 2> (appears in [Shot 2]): fully_preserved - Her identity is preserved.\ndetailed_description:\n")
    .replace("Hello.</d>", "Hello.</d> <Subject 2> (S1) replies, <d>[English] Stay.</d>");
  assert.throws(() => assertH3PromptContract(sharedId, 6, 2), /不同 Subject 不能共用/);
  const narrator = valid.replace("Hello.</d>", "Hello.</d> An off-screen narrator (S2) says, <d>[English] She waits.</d>");
  assert.doesNotThrow(() => assertH3PromptContract(narrator, 6, 2));
  assert.doesNotThrow(() => assertH3PromptContract(narrator.replace("She waits.</d>", "She waits.</d> They speak together (S1,S2), <d>[English] Now.</d>"), 6, 2));
  assert.throws(() => assertH3PromptContract(valid.replace("(S1)", "(S1,S2)"), 6, 2), /之前已单独标明/);
});

test("a labeled scream establishes the speaker before a system line and the character's later reply", () => {
  const prompt = valid.replace("appears in [Shot 1], [Shot 2]", "appears in [Shot 1], [Shot 2], [Shot 3]")
    .replace("[Shot 1] A medium view follows <Subject 1> turning on deck.", "[Shot 1] A medium view follows <Subject 1> (S1) turning on deck. She gives a sharp wordless scream.")
    .replace("[Shot 2] At 00:03.000,", "[Shot 2] At 00:03.000, the camera cuts to the wet railing. An off-screen system voice (S2) says, <d>[English] Hold the railing.</d>\n[Shot 3] At 00:05.000,");
  assert.doesNotThrow(() => assertH3PromptContract(prompt, 8, 2));
  assert.throws(() => assertH3PromptContract(prompt.replace("system voice (S2)", "system voice (S3)"), 8, 2), /连续编号，不能缺号/);
  assert.throws(() => assertH3PromptContract(prompt.replace("<Subject 1> (S1) turning", "<Subject 1> (S2) turning"), 8, 2), /同一 Subject/);
});

test("speaker description order is not assumed to be actual vocal onset order", () => {
  const prompt = valid.replace("[Shot 1] A medium view follows <Subject 1> turning on deck.", "[Shot 1] A medium view follows <Subject 1> (S2) turning on deck. Before she speaks, an off-screen narrator (S1) says, <d>[English] She arrives.</d>")
    .replace("to <Subject 1> (S1)", "to <Subject 1> (S2)");
  assert.doesNotThrow(() => assertH3PromptContract(prompt, 6, 2));
});

test("a style Subject may take effect in the style opening and a standalone Picture may anchor a shot", () => {
  const style = valid.replace("summary:\n", "<Subject 2> is the restrained color palette of <Picture 1>.\nsummary:\n")
    .replace("detailed_description:\n", "<Subject 2>: fully_preserved - The palette guides all shots.\ndetailed_description:\n")
    .replace("Semi-realistic 3D", "The palette of <Subject 2> guides the semi-realistic 3D");
  assert.doesNotThrow(() => assertH3PromptContract(style, 6, 2));
  const anchor = valid.replace("<Subject 1>", "<Picture 1>").replace("<Picture 1> is the woman in <Picture 1> (face) and <Picture 2> (body), wearing the red sweater and black skirt from the references.", "<Picture 1> is the first frame of [Shot 1].")
    .replaceAll("<Subject 1>", "<Picture 1>").replace("[reference generation]", "[keyframe completion]");
  assert.doesNotThrow(() => assertH3PromptContract(anchor, 6, 1));
});

test("copied soundtrack lyric cues use Audio without inventing a speaker", () => {
  const audio = valid.replace("summary:\n", "<Audio 1> is the complete directly reused soundtrack.\nsummary:\n")
    .replace("[reference generation]", "[reference generation + audio reuse]")
    .replace("detailed_description:\n", "<Audio 1>: fully_copy - The soundtrack is reused unchanged.\ndetailed_description:\n")
    .replace("to <Subject 1> (S1), who says with an American accent,", "to <Subject 1>. When <Audio 1> reaches the phrase");
  assert.doesNotThrow(() => assertH3PromptContract(audio, 6, 2));
  assert.throws(() => assertH3PromptContract(audio.replace(": fully_copy -", ": reference -"), 6, 2), /每次对白需要/);
});

test("explicit definitions in one paragraph normalize to separate lines without inventing content", () => {
  const prompt = valid.replace("summary:\n", "<Subject 2> is a blue interface from <Picture 2>.\nsummary:\n")
    .replace("detailed_description:\n", "<Subject 2> (appears in [Shot 2]): fully_preserved - Blue UI retained.\ndetailed_description:\n")
    .replace("the camera cuts to <Subject 1>", "the camera cuts to <Subject 2> beside <Subject 1>");
  const inline = prompt.replace("references.\n<Subject 2>", "references. <Subject 2>");
  assert.equal(normalizeH3PromptFormat(inline), prompt);
  assert.doesNotThrow(() => assertH3PromptContract(normalizeH3PromptFormat(inline), 6, 2));
  const quoted = valid.replace("Hello.</d>", '“Hello.”</d>').replace("Wind and creaking metal.", 'The screen displays “重生”.');
  const normalized = normalizeH3PromptFormat(quoted);
  assert.match(normalized, /<d>\[English\] “Hello.”<\/d>/);
  assert.match(normalized, /displays "重生"/);
});

test("official source-only video Subjects and separately tracked timbre Audio are valid", () => {
  // Mirrors the source/reference structure of the official ref-en.txt complete example:
  // https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt
  const example = `subject_definitions:
<Subject 1> is the cafe in <Picture 1>, with brick walls and a wooden table.
<Subject 2> is the white dog in <Picture 2>, <Picture 3>, and <Picture 4>, with pointed ears and a curved tail.
<Subject 3> is the blonde woman in <Video 1>, wearing a pink shirt.
<Subject 4> is the man in <Video 2>, wearing a grey hoodie.
<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing an English vocal layer.
summary:
[reference generation + audio reference] In <Subject 1>, <Subject 3> holds a cookie while <Subject 4> enters with <Subject 2>. <Audio 1> guides <Subject 3>'s voice.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - Brick walls and the table are retained.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - White fur and pointed ears are retained.
<Subject 3> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - Blonde hair and the pink shirt are retained.
<Subject 4> (appears in [Shot 1], [Shot 2]): fully_preserved - The grey hoodie is retained.
<Audio 1>: reference - Its timbre guides the woman's delivery without copying the original signal.
detailed_description:
Warm indoor lighting creates soft shadows across the cafe.
[Shot 1] A medium view establishes <Subject 1>. <Subject 3> (S1), the blonde woman in a pink shirt, holds a cookie at the table. <Subject 4>, the man in a grey hoodie, enters from the left holding <Subject 2>, the white dog, by its leash. The dog jumps toward the cookie. <Subject 3> (S1) jerks her hand back and says in the clear voice timbre referenced from <Audio 1>, <d>[English] Careful!</d> She closes her mouth and guards the cookie.
[Shot 2] At 00:03.000, the camera cuts to <Subject 4> (S2) holding <Subject 2> beside <Subject 3>. <Subject 4> (S2) says in a quiet young male voice, <d>[English] Sorry about that.</d> He pulls the leash closer.
[Shot 3] At 00:05.000, the camera cuts to <Subject 3> (S1), who smiles and replies using the voice timbre of <Audio 1>, <d>[English] It's fine.</d> She lowers the cookie to the table.
overall_soundscape:
Low cafe room tone and soft chair scrapes continue throughout.
non_diegetic_music:
N/A`;
  assert.doesNotThrow(() => assertH3PromptContract(example, 8, 4));
  assert.throws(() => assertH3PromptContract(example.replace("In <Subject 1>,", "Continuing <Video 1>, in <Subject 1>,"), 8, 4), /未定义引用 <Video 1>/);
  assert.throws(() => assertH3PromptContract(example.replace("Low cafe room tone", "The sound of <Video 2> and low cafe room tone"), 8, 4), /未定义引用 <Video 2>/);
});
