import { assertH3PictureSlots } from "./h3VisualStateGuard";

const sections = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"] as const;
const MAX_H3_PROMPT_LENGTH = 30_000;
const maskDialogue = (text: string) => text.replace(/<d>[\s\S]*?<\/d>/g, content => content.replace(/[^\r\n]/g, " "));
const dialogueLocalePrefix = /(<d>\[[A-Za-z][A-Za-z -]*\])\s*\(([a-z]{2,3}-(?:[A-Z][a-z]{3}(?:-(?:[A-Z]{2}|\d{3}))?|[A-Z]{2}|\d{3}))\)\s*/g;

export function normalizeH3DialogueLocales(prompt: string): string {
  return prompt.replace(dialogueLocalePrefix, (_, label: string, locale: string) => "(spoken locale: " + locale + ") " + label + " ");
}

/** Canonicalize explicit cut times and harmless line layout only; never invent cuts or alter dialogue. */
export function normalizeH3PromptFormat(prompt: string): string {
  const normalized = normalizeH3DialogueLocales(prompt)
    .replace(/(<(?:Subject|Picture|Video|Audio)\s+\d+>)\{=html\}/g, "$1")
    .split(/(<d>[\s\S]*?<\/d>)/g).map((part, index) => index % 2
    ? part.replace(/。(?=<\/d>)/g, ".").replace(/！(?=<\/d>)/g, "!").replace(/？(?=<\/d>)/g, "?")
    : part.replace(
    /^(\[Shot ([2-9]|[1-9]\d+)\])\s+At\s+(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?\s*[,，:：]/gm,
    (_, shot, _number, minutes, seconds, fraction) => `${shot} At ${minutes.padStart(2, "0")}:${seconds}.${(fraction || "").padEnd(3, "0")},`,
  ).replace(/^(\[Shot (?:[2-9]|[1-9]\d+)\])\s+At\s+([0-5]?\d)\.(\d{1,3})\s*[,，:：]/gm,
    (_, shot, seconds, fraction) => `${shot} At 00:${seconds.padStart(2, "0")}.${fraction.padEnd(3, "0")},`)
    .replace(/[“”]/g, '"')).join("").replace(
    /(^subject_definitions:\s*\n)([\s\S]*?)(?=^summary:)/m,
    (_, heading, body) => heading + body.replace(/([.!?;])[^\S\r\n]+(?=<(?:Subject|Picture|Video|Audio) \d+> (?:is|are|represents|defines|provides)\b)/g, "$1\n"),
  );
  return normalized.replace(/(^retention_analysis:\s*\n)([\s\S]*?)(?=^detailed_description:)/m, (_, heading, body) =>
    heading + body.replace(/^(<(?:Subject|Picture|Video|Audio) \d+>) (appears in \[Shot \d+\](?:,? (?:and )?\[Shot \d+\])*):/gm, "$1 ($2):"));
}

export const h3FormatChecklist = `Mandatory MiniMax H3 Ref2VA output syntax: return exactly six complete English sections in this order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. In subject_definitions, put each definition on its own unbulleted line beginning exactly <Subject N> is ... <Picture N> ...; never emit {=html}. summary must begin exactly with an official bracketed task prefix such as [reference generation]. retention_analysis must use one unbulleted line per definition in the form <Subject N> (appears in [Shot 1]): fully_preserved - ... using an official marker. Put each shot heading on a new line: [Shot 1] without a timestamp; later cuts use [Shot N] At MM:SS.mmm, with sequential numbers and increasing times inside target_duration. Give every vocal event a stable consecutive (Sx); put that source marker immediately before its dialogue, and write a referenced speaker as <Subject N> (Sx). Dialogue uses <d>[Language] complete sentence.</d>. Enclose every non-English visible screen, title, sign, subtitle or interface string in straight double quotation marks, including a string placed on its own line. Keep actual image bindings, spoken lines, event order and cause/effect. Return the whole prompt on correction, never a partial patch.`;

/** Deterministic official Ref2VA structure, timeline, speaker and reference checks. */
export function assertH3PromptContract(prompt: string, duration: number, pictureCount: number): void {
  const fail = (reason: string): never => { throw new Error(`H3 提示词格式：${reason}`); };
  const value = String(prompt || "");
  if (!value.trim()) fail("内容不能为空");
  if (value.length > MAX_H3_PROMPT_LENGTH) fail(`长度不能超过 ${MAX_H3_PROMPT_LENGTH} 个字符`);
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail("包含非法控制字符");

  const headings = [...value.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):\s*/gm)];
  const missing = sections.filter(section => !headings.some(m => m[1] === section));
  if (missing.length) fail(`六个章节不完整，缺少：${missing.join(", ")}。请返回完整提示词`);
  if (headings.length !== sections.length || headings.some((heading, index) => heading[1] !== sections[index])) fail("六个章节必须各出现一次并按官方顺序排列");
  if (value.slice(0, headings[0].index).trim()) fail("subject_definitions 之前不能出现额外正文");
  const body = Object.fromEntries(headings.map((m, i) => [m[1], value.slice(m.index! + m[0].length, headings[i + 1]?.index ?? value.length).trim()])) as Record<(typeof sections)[number], string>;
  if (Object.values(body).some(section => !section)) fail("章节内容不能为空");

  const dialogueRanges: { start: number; end: number }[] = [];
  let dialogueStart: number | undefined;
  for (const tag of body.detailed_description.matchAll(/<\/?d\b[^>]*>/g)) {
    if (tag[0] === "<d>") {
      if (dialogueStart !== undefined) fail("对白标签不得嵌套");
      dialogueStart = tag.index!;
    } else if (tag[0] === "</d>") {
      if (dialogueStart === undefined) fail("对白结束标签没有对应的开始标签");
      const start = dialogueStart as number;
      const content = body.detailed_description.slice(start + 3, tag.index!).trim();
      if (!/^\[[A-Za-z][A-Za-z -]*\]\s*\S/.test(content)) fail("对白必须使用 <d>[English] ...</d> 格式，地区/口音写在标签外");
      if (!/[.?!][\"']?$/.test(content)) fail("完整对白必须在 </d> 前使用句号、问号或感叹号结尾");
      dialogueRanges.push({ start, end: tag.index! + tag[0].length });
      dialogueStart = undefined;
    } else fail("对白必须使用 <d>[English] ...</d> 格式，地区/口音写在标签外");
  }
  if (dialogueStart !== undefined) fail("对白标签未闭合");
  if (sections.filter(s => s !== "detailed_description").some(s => /<\/?d\b/.test(body[s]))) fail("完整对白只能出现在 detailed_description");

  const shotDescription = maskDialogue(body.detailed_description);
  const structuredPrompt = sections.map(section => body[section]).join("\n");
  const prose = structuredPrompt
    .replace(/<d\b[^>]*>[\s\S]*?<\/d>/g, "")
    .replace(/"[^"\n]*"|“[^”\n]*”|『[^』\n]*』|「[^」\n]*」/g, "")
    // A standalone non-English title/caption immediately introduced by an
    // English visible-text label is explicit screen content, not prose.
    .replace(/^([^\n]*(?:text|title|caption|subtitle|label|screen|display|card)[^\n]*:\s*\r?\n)[^\n]*\p{Script=Han}[^\n]*$/gimu, "$1");
  if (/[\u3400-\u9fff]/.test(prose)) fail("六段说明必须用英文；中文仅可保留在对白或明确引用的可见文字中");
  assertH3PictureSlots(maskDialogue(structuredPrompt), pictureCount);

  const label = /<(Subject|Picture|Video|Audio)\s+\d+>/g;
  const definitionLines = [...body.subject_definitions.matchAll(/^(<(?:Subject|Picture|Video|Audio) \d+>)\s+.+$/gm)];
  const definitions = definitionLines.map(m => m[1]);
  if (!definitions.length || new Set(definitions).size !== definitions.length) fail("引用定义缺失或重复");
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
    if (!m) fail("保留分析必须逐条对应已定义的 Subject 或独立锚点");
    if (!definitions.includes(m![1])) fail("保留分析必须逐条对应已定义的 Subject 或独立锚点");
    const allowed = m![2] === "Audio" ? ["fully_copy", "partially_copy", "reference", "weak_reference"] : ["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"];
    if (!allowed.includes(m![3]) || /\(S\d+(?:\s*,\s*S\d+)*\)/.test(row)) fail("保留关系标记或说话人标记不符合规范");
    retained.push(m![1]);
  }
  if (retained.length !== definitions.length || new Set(retained).size !== definitions.length) fail("每个定义需要且只能有一条保留分析");
  if (!/^\[(?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference)(?: \+ (?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference))*\]/.test(body.summary)) fail("summary 缺少官方任务类型前缀");
  if (definitions.some(d => d.startsWith("<Subject ")) && !/<Subject \d+>/.test(body.summary)) fail("summary 应使用已定义的 Subject 标签描述主体关系");

  const shots = [...shotDescription.matchAll(/\[Shot (\d+)\]/g)];
  if (!shots.length || !shotDescription.slice(0, shots[0].index).trim()) fail("第一镜之前需要具体画风描述");
  let previousTime = 0;
  shots.forEach((shot, index) => {
    if (Number(shot[1]) !== index + 1) fail("镜头编号必须连续");
    const tail = shotDescription.slice(shot.index! + shot[0].length);
    const time = /^\s*At (\d{2}):([0-5]\d)\.(\d{3}),/.exec(tail);
    if (index === 0) {
      if (/^\s*At\s+\d/.test(tail)) fail("Shot 1 不能带时间戳");
      return;
    }
    if (!time) fail(`Shot ${index + 1} 应以 [Shot ${index + 1}] At MM:SS.mmm, 开始`);
    const matchedTime = time!;
    const seconds = Number(matchedTime[1]) * 60 + Number(matchedTime[2]) + Number(matchedTime[3]) / 1000;
    if (seconds <= previousTime || seconds >= duration) fail("切镜时间必须递增且在目标时长以内");
    previousTime = seconds;
  });
  for (const definition of definitions.filter(item => item.startsWith("<Subject "))) {
    if (!shotDescription.includes(definition)) fail(`${definition} 已定义但未在 detailed_description 中使用`);
  }
  const shotNumbers = new Set(shots.map(shot => Number(shot[1])));
  for (const row of rows) {
    for (const mention of row.matchAll(/\[Shot (\d+)\]/g)) {
      if (!shotNumbers.has(Number(mention[1]))) fail(`保留分析引用了不存在的 ${mention[0]}`);
    }
  }

  if (normalizeH3DialogueLocales(value) !== value) fail("对白开头的地区标记必须写在标签外");
  const copiedAudio = new Set(rows.flatMap(row => /^(<Audio \d+>)(?:\s*\([^\n]*\))?\s*:\s*(?:fully_copy|partially_copy)\s*[-–—]/.exec(row)?.slice(1, 2) ?? []));
  const introducedSpeakers = new Set<number>();
  const subjectSpeakers = new Map<string, number>();
  const speakerSubjects = new Map<number, string>();
  const shotProse = shotDescription.slice(shots[0].index);
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
    const activeShot = currentShot!;
    const prelude = shotDescription.slice(Math.max(previousDialogueEnd, activeShot.index! + activeShot[0].length), dialogue.start);
    previousDialogueEnd = dialogue.end;
    const speaker = [...prelude.matchAll(/\(S\d+(?:\s*,\s*S\d+)*\)/g)].at(-1);
    if (!speaker) {
      const audio = [...prelude.matchAll(/<Audio \d+>/g)].at(-1)?.[0];
      if (audio && copiedAudio.has(audio)) continue;
      fail("每次对白需要明确的 (Sx) 说话人标记；直接复用音轨中的歌词提示应引用对应 Audio");
    }
  }
}
