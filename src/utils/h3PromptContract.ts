import { assertH3PictureSlots } from "./h3VisualStateGuard";

const sections = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
const maskDialogue = (text: string) => text.replace(/<d>[\s\S]*?<\/d>/g, content => content.replace(/[^\r\n]/g, " "));

// Only a locale directly after the language label is metadata; later speech stays untouched.
const dialogueLocalePrefix = /(<d>\[[A-Za-z][A-Za-z -]*\])\s*\(([a-z]{2,3}-(?:[A-Z][a-z]{3}(?:-(?:[A-Z]{2}|\d{3}))?|[A-Z]{2}|\d{3}))\)\s*/g;

export function normalizeH3DialogueLocales(prompt: string): string {
  return prompt.replace(dialogueLocalePrefix, (_, label: string, locale: string) => "(spoken locale: " + locale + ") " + label + " ");
}

/** Canonicalize explicit cut times only; never infer a missing cut or alter dialogue. */
export function normalizeH3PromptFormat(prompt: string): string {
  const normalized = normalizeH3DialogueLocales(prompt).split(/(<d>[\s\S]*?<\/d>)/g).map((part, index) => index % 2 ? part : part.replace(
    /^(\[Shot ([2-9]|[1-9]\d+)\])\s+At\s+(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?\s*[,，:：]/gm,
    (_, shot, _number, minutes, seconds, fraction) => `${shot} At ${minutes.padStart(2, "0")}:${seconds}.${(fraction || "").padEnd(3, "0")},`,
  ).replace(/^(\[Shot (?:[2-9]|[1-9]\d+)\])\s+At\s+([0-5]?\d)\.(\d{1,3})\s*[,，:：]/gm,
    (_, shot, seconds, fraction) => `${shot} At 00:${seconds.padStart(2, "0")}.${fraction.padEnd(3, "0")},`)
    .replace(/[“”]/g, '"')).join("").replace(
    /(^subject_definitions:\s*\n)([\s\S]*?)(?=^summary:)/m,
    (_, heading, body) => heading + body.replace(/([.!?;])[^\S\r\n]+(?=<(?:Subject|Picture|Video|Audio) \d+> (?:is|are|represents|defines|provides)\b)/g, "$1\n"),
  );
  // Only repair the retention section's explicit appearance clause, never spoken text.
  return normalized.replace(/(^retention_analysis:\s*\n)([\s\S]*?)(?=^detailed_description:)/m, (_, heading, body) =>
    heading + body.replace(/^(<(?:Subject|Picture|Video|Audio) \d+>) (appears in \[Shot \d+\](?:,? (?:and )?\[Shot \d+\])*):/gm, "$1 ($2):"));
}

export const h3FormatChecklist = `Mandatory H3 output syntax: return all six complete English sections, except speech inside <d> and explicitly quoted visible screen/sign text. Translate visual-manual terms into English. summary starts with the applicable official task prefix and uses defined reference labels. Use Subject labels where they take effect in detailed_description, not only in definitions and retention. Put every shot heading on a new line: [Shot 1] without time; later [Shot N] At MM:SS.mmm, with sequential numbers and increasing cut times inside target_duration. Preserve specified timings; when cuts are needed without specified times, plan feasible times from the supplied events and speech. Return LANGUAGE_TIMING_REVIEW if these cannot fit. Retention shot lists must agree with the timeline. Give each vocal event its stable (Sx) and use <Subject N> (Sx) for referenced speakers; copied soundtrack cues use their Audio source. Keep actual image bindings, spoken lines and event order. Return the whole prompt on correction, never a partial patch.`;

/** Deterministic Ref2VA structure and reference checks; not a visual or narrative quality assessment. */
export function assertH3PromptContract(prompt: string, duration: number, pictureCount: number): void {
  const fail = (reason: string): never => { throw new Error(`H3 提示词格式：${reason}`); };
  const headings = [...prompt.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):\s*/gm)];
  const missing = sections.filter(section => !headings.some(m => m[1] === section));
  if (missing.length) fail(`六个章节不完整，缺少：${missing.join(", ")}。请返回完整提示词`);
  if (new Set(headings.map(m => m[1])).size !== headings.length) fail("章节不能重复");
  const body = Object.fromEntries(headings.map((m, i) => [m[1], prompt.slice(m.index! + m[0].length, headings[i + 1]?.index ?? prompt.length).trim()]));
  if (Object.values(body).some(value => !value)) fail("章节内容不能为空");
  // Parse tags before masking spoken content. Equal open/close counts do not detect nesting.
  const dialogueRanges: { start: number; end: number }[] = [];
  let dialogueStart: number | undefined;
  for (const tag of body.detailed_description.matchAll(/<\/?d\b[^>]*>/g)) {
    if (tag[0] === "<d>") {
      if (dialogueStart !== undefined) fail("对白标签不得嵌套");
      dialogueStart = tag.index!;
    } else if (tag[0] === "</d>") {
      if (dialogueStart === undefined) fail("对白结束标签没有对应的开始标签");
      const content = body.detailed_description.slice(dialogueStart! + 3, tag.index!);
      if (!/^\[[A-Za-z][A-Za-z -]*\]\s*\S/.test(content)) fail("对白必须使用 <d>[English] ...</d> 格式，地区/口音写在标签外");
      dialogueRanges.push({ start: dialogueStart!, end: tag.index! + tag[0].length });
      dialogueStart = undefined;
    } else fail("对白必须使用 <d>[English] ...</d> 格式，地区/口音写在标签外");
  }
  if (dialogueStart !== undefined) fail("对白标签未闭合");
  if (sections.filter(s => s !== "detailed_description").some(s => /<\/?d\b/.test(body[s]))) fail("完整对白只能出现在 detailed_description");
  // Keep offsets stable so literal [Shot N] and <Subject N> spoken by a character are not structure.
  const shotDescription = maskDialogue(body.detailed_description);
  // Dialogue and explicitly quoted visible scene text retain their source language.
  // Explanatory text before the first section is not part of the H3 prompt contract.
  const structuredPrompt = sections.map(section => body[section]).join("\n");
  const prose = structuredPrompt.replace(/<d\b[^>]*>[\s\S]*?<\/d>/g, "").replace(/"[^"\n]*"|“[^”\n]*”/g, "");
  if (/[\u3400-\u9fff]/.test(prose)) fail("六段说明必须用英文；中文仅可保留在对白或明确引用的可见文字中，画风手册也要译成英文");
  assertH3PictureSlots(maskDialogue(structuredPrompt), pictureCount);
  const label = /<(Subject|Picture|Video|Audio)\s+\d+>/g;
  const definitionLines = [...body.subject_definitions.matchAll(/^(<(?:Subject|Picture|Video|Audio) \d+>)\s+.+$/gm)];
  const definitions = definitionLines.map(m => m[1]);
  if (!definitions.length || new Set(definitions).size !== definitions.length) fail("引用定义缺失或重复");
  // Like source-only Pictures, Videos may supply a Subject without being tracked separately.
  // That exemption applies only inside definitions, not to independent use in later sections.
  const sourceVideos = new Set(definitionLines.flatMap(line => [...line[0].matchAll(/<Video \d+>/g)].map(match => match[0])));
  for (const [section, text] of Object.entries(body)) {
    for (const m of maskDialogue(text).matchAll(label)) {
      if (m[1] === "Picture" || definitions.includes(m[0])) continue;
      if (section === "subject_definitions" && m[1] === "Video" && sourceVideos.has(m[0])) continue;
      fail(`未定义引用 ${m[0]}`);
    }
  }
  const rows = body.retention_analysis.split(/\r?\n/).filter(line => line.trim());
  const retained: string[] = [];
  for (const row of rows) {
    const m = /^(<(Subject|Picture|Video|Audio) \d+>)(?:\s*\([^\n]*\))?\s*:\s*(\w+)\s*[-–—]/.exec(row);
    if (!m || !definitions.includes(m[1])) fail("保留分析必须对应已定义的 Subject 或独立锚点；不能为仅作来源的 Picture 建立条目");
    const entry = m!;
    const allowed = entry[2] === "Audio" ? ["fully_copy", "partially_copy", "reference", "weak_reference"] : ["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"];
    if (!allowed.includes(entry[3]) || /\(S\d+(?:\s*,\s*S\d+)*\)/.test(row)) fail("保留关系标记或说话人标记不符合规范");
    retained.push(entry[1]);
  }
  if (retained.length !== definitions.length || new Set(retained).size !== definitions.length) fail("每个定义需要且只能有一条保留分析");
  if (!/^\[(?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference)(?: \+ (?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference))*\]/.test(body.summary)) fail("summary 缺少官方任务类型前缀");
  if (definitions.some(d => d.startsWith("<Subject ")) && !/<Subject \d+>/.test(body.summary)) fail("summary 应使用已定义的 Subject 标签描述主体关系");
  const shots = [...shotDescription.matchAll(/\[Shot (\d+)\]/g)];
  if (!shots.length || !shotDescription.slice(0, shots[0].index).trim()) fail("第一镜之前需要具体画风描述");
  let previousTime = 0;
  shots.forEach((shot, i) => {
    if (Number(shot[1]) !== i + 1) fail("镜头编号必须连续");
    const tail = shotDescription.slice(shot.index! + shot[0].length);
    const time = /^\s*At (\d{2}):([0-5]\d)\.(\d{3}),/.exec(tail);
    if (i === 0) { if (/^\s*At\s+\d/.test(tail)) fail("Shot 1 不能带时间戳"); return; }
    if (!time) fail(`Shot ${i + 1} 应以 [Shot ${i + 1}] At MM:SS.mmm, 开始，当前开头：${tail.trim().slice(0, 100)}`);
    const seconds = Number(time![1]) * 60 + Number(time![2]) + Number(time![3]) / 1000;
    if (seconds <= previousTime || seconds >= duration) fail("切镜时间必须递增且在目标时长以内");
    previousTime = seconds;
  });
  for (const definition of definitions.filter(item => item.startsWith("<Subject "))) {
    if (!shotDescription.includes(definition)) fail(`${definition} 已定义但未在 detailed_description 中使用，请在参考实际生效的位置引用标签`);
  }
  const shotNumbers = new Set(shots.map(shot => Number(shot[1])));
  for (const row of rows) {
    for (const mention of row.matchAll(/\[Shot (\d+)\]/g)) {
      if (!shotNumbers.has(Number(mention[1]))) fail(`保留分析引用了不存在的 ${mention[0]}`);
    }
  }
  if (normalizeH3DialogueLocales(prompt) !== prompt) fail("对白开头的地区标记必须写在标签外");
  const copiedAudio = new Set(rows.flatMap(row => /^(<Audio \d+>)(?:\s*\([^\n]*\))?\s*:\s*(?:fully_copy|partially_copy)\s*[-–—]/.exec(row)?.slice(1, 2) ?? []));
  const introducedSpeakers = new Set<number>();
  const subjectSpeakers = new Map<string, number>();
  const speakerSubjects = new Map<number, string>();
  const shotProse = shotDescription.slice(shots[0].index);
  // IDs can accompany screams, laughter and other vocal events without a <d> block.
  // Check explicit numbering/bindings in all shot prose; prose order alone cannot prove
  // the order of actual vocal onset, which remains a writing/semantic-review rule.
  for (const speaker of shotProse.matchAll(/\(S\d+(?:\s*,\s*S\d+)*\)/g)) {
    const ids = [...speaker[0].matchAll(/S(\d+)/g)].map(match => Number(match[1]));
    if (new Set(ids).size !== ids.length) fail("组合说话人标记不能重复同一编号");
    if (ids.length > 1 && ids.some(id => !introducedSpeakers.has(id))) fail("组合说话人标记只能使用之前已单独标明的说话人编号");
    for (const id of ids) introducedSpeakers.add(id);
    const subject = /(<Subject \d+>)\s*$/.exec(shotProse.slice(0, speaker.index))?.[1];
    if (subject && ids.length === 1) {
      const id = ids[0];
      if ((subjectSpeakers.has(subject) && subjectSpeakers.get(subject) !== id) || (speakerSubjects.has(id) && speakerSubjects.get(id) !== subject)) fail("同一 Subject 必须保持同一说话人编号，不同 Subject 不能共用同一编号");
      subjectSpeakers.set(subject, id);
      speakerSubjects.set(id, subject);
    }
  }
  if ([...introducedSpeakers].sort((a, b) => a - b).some((id, index) => id !== index + 1)) fail("说话人编号必须从 (S1) 连续编号，不能缺号");
  let previousDialogueEnd = 0;
  for (const dialogue of dialogueRanges) {
    const currentShot = shots.filter(shot => shot.index! < dialogue.start).at(-1);
    if (!currentShot) fail("对白必须位于实际镜头中");
    const prelude = shotDescription.slice(Math.max(previousDialogueEnd, currentShot!.index! + currentShot![0].length), dialogue.start);
    previousDialogueEnd = dialogue.end;
    const speaker = [...prelude.matchAll(/\(S\d+(?:\s*,\s*S\d+)*\)/g)].at(-1);
    if (!speaker) {
      // Copied soundtrack lyric cues have an Audio source, not a newly invented speaker.
      const audio = [...prelude.matchAll(/<Audio \d+>/g)].at(-1)?.[0];
      if (audio && copiedAudio.has(audio)) continue;
      fail("每次对白需要明确的 (Sx) 说话人标记；直接复用音轨中的歌词提示应引用对应 Audio");
    }
  }
}
