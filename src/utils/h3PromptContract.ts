import { assertH3PictureSlots } from "./h3VisualStateGuard";

const sections = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];

/** A repair model may return only changed sections. Retain omitted sections from this same attempt. */
export function completeH3Repair(candidate: string, previous: string): string {
  const split = (text: string) => {
    const matches = [...text.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):\s*/gm)];
    if (!matches.length || text.slice(0, matches[0].index).trim() || new Set(matches.map(m => m[1])).size !== matches.length) return null;
    return new Map(matches.map((m, i) => [m[1], text.slice(m.index! + m[0].length, matches[i + 1]?.index ?? text.length).trim()]));
  };
  if (/^\[(?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference)(?:\s*\+|\])/.test(candidate)) candidate = `summary:\n${candidate}`;
  const current = split(candidate), prior = split(previous);
  if (!current || !prior || sections.every(section => current.has(section))) return candidate;
  if (sections.some(section => !current.has(section) && !prior.has(section))) return candidate;
  return sections.map(section => `${section}:\n${current.get(section) ?? prior.get(section)}`).join("\n\n");
}

// Only a locale directly after the language label is metadata; later speech stays untouched.
const dialogueLocalePrefix = /(<d>\[[A-Za-z][A-Za-z -]*\])\s*\(([a-z]{2,3}-(?:[A-Z][a-z]{3}(?:-(?:[A-Z]{2}|\d{3}))?|[A-Z]{2}|\d{3}))\)\s*/g;

export function normalizeH3DialogueLocales(prompt: string): string {
  return prompt.replace(dialogueLocalePrefix, (_, label: string, locale: string) => "(spoken locale: " + locale + ") " + label + " ");
}

/** Canonicalize explicit cut times only; never infer a missing cut or alter dialogue. */
export function normalizeH3PromptFormat(prompt: string): string {
  return normalizeH3DialogueLocales(prompt).replace(
    /^(\[Shot ([2-9]|[1-9]\d+)\])\s+At\s+(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?\s*[,，:：]/gm,
    (_, shot, _number, minutes, seconds, fraction) => `${shot} At ${minutes.padStart(2, "0")}:${seconds}.${(fraction || "").padEnd(3, "0")},`,
  );
}

export const h3FormatChecklist = `Mandatory H3 output syntax: all six section bodies are English, except speech inside <d> and explicitly quoted visible screen/sign text. Translate Chinese style-manual terms into English; do not copy Chinese instructions. summary must start with [reference generation] (or the applicable task prefix) and use the defined <Subject N> labels. Put every shot heading at the start of a new line. [Shot 1] has no timestamp. Every later heading MUST begin exactly like [Shot 2] At 00:03.200, followed by the shot description. Use your actual cut time, two minute digits, two second digits and three millisecond digits. Do not put camera descriptions or duration ranges between the heading and At. Never invent a cut time when the storyboard timing is insufficient. Keep all Subject/Picture bindings, spoken lines and event order.`;

/** Official Ref2VA grammar only; visual fidelity still requires inspecting the result. */
export function assertH3PromptContract(prompt: string, duration: number, pictureCount: number): void {
  const fail = (reason: string): never => { throw new Error(`H3 提示词格式：${reason}`); };
  const headings = [...prompt.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):\s*/gm)];
  if (headings.map(m => m[1]).join() !== sections.join() || prompt.slice(0, headings[0]?.index).trim()) fail("必须按官方顺序输出六个章节，不能有前言或代码块");
  const body = Object.fromEntries(headings.map((m, i) => [m[1], prompt.slice(m.index! + m[0].length, headings[i + 1]?.index ?? prompt.length).trim()]));
  if (Object.values(body).some(value => !value)) fail("章节内容不能为空");
  // Dialogue and explicitly quoted visible scene text retain their source language.
  const prose = prompt.replace(/<d\b[^>]*>[\s\S]*?<\/d>/g, "").replace(/"[^"\n]*"|“[^”\n]*”/g, "");
  if (/[\u3400-\u9fff]/.test(prose)) fail("六段说明必须用英文；中文仅可保留在对白或明确引用的可见文字中，画风手册也要译成英文");
  assertH3PictureSlots(prompt, pictureCount);
  const label = /<(Subject|Picture|Video|Audio)\s+\d+>/g;
  const definitions = [...body.subject_definitions.matchAll(/^(<(?:Subject|Picture|Video|Audio) \d+>)\s+.+$/gm)].map(m => m[1]);
  if (!definitions.length || new Set(definitions).size !== definitions.length) fail("引用定义缺失或重复");
  for (const m of prompt.matchAll(label)) {
    if (m[1] !== "Picture" && !definitions.includes(m[0])) fail(`未定义引用 ${m[0]}`);
  }
  const rows = body.retention_analysis.split(/\r?\n/).filter(line => line.trim());
  const retained: string[] = [];
  for (const row of rows) {
    const m = /^(<(Subject|Picture|Video|Audio) \d+>)(?:\s*\([^\n]*\))?\s*:\s*(\w+)\s*[-–—]/.exec(row);
    if (!m || !definitions.includes(m[1])) fail("保留分析必须对应已定义的 Subject 或独立锚点；不能为仅作来源的 Picture 建立条目");
    const entry = m!;
    const allowed = entry[2] === "Audio" ? ["fully_copy", "partially_copy", "reference", "weak_reference"] : ["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"];
    if (!allowed.includes(entry[3]) || /\(S\d+\)/.test(row)) fail("保留关系标记或说话人标记不符合规范");
    retained.push(entry[1]);
  }
  if (retained.length !== definitions.length || new Set(retained).size !== definitions.length) fail("每个定义需要且只能有一条保留分析");
  if (!/^\[(?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference)(?: \+ (?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference))*\]/.test(body.summary)) fail("summary 缺少官方任务类型前缀");
  if (definitions.some(d => d.startsWith("<Subject ")) && !/<Subject \d+>/.test(body.summary)) fail("summary 应使用已定义的 Subject 标签描述主体关系");
  const shots = [...body.detailed_description.matchAll(/\[Shot (\d+)\]/g)];
  if (!shots.length || !body.detailed_description.slice(0, shots[0].index).trim()) fail("第一镜之前需要具体画风描述");
  let previousTime = 0;
  shots.forEach((shot, i) => {
    if (Number(shot[1]) !== i + 1) fail("镜头编号必须连续");
    const tail = body.detailed_description.slice(shot.index! + shot[0].length);
    const time = /^\s*At (\d{2}):([0-5]\d)\.(\d{3}),/.exec(tail);
    if (i === 0) { if (/^\s*At\s+\d/.test(tail)) fail("Shot 1 不能带时间戳"); return; }
    if (!time) fail(`Shot ${i + 1} 应以 [Shot ${i + 1}] At MM:SS.mmm, 开始，当前开头：${tail.trim().slice(0, 100)}`);
    const seconds = Number(time![1]) * 60 + Number(time![2]) + Number(time![3]) / 1000;
    if (seconds <= previousTime || seconds >= duration) fail("切镜时间必须递增且在目标时长以内");
    previousTime = seconds;
  });
  if (normalizeH3DialogueLocales(prompt) !== prompt) fail("对白开头的地区标记必须写在标签外");
  const dialogues = [...prompt.matchAll(/<d\b[^>]*>/g)];
  if (dialogues.length !== (prompt.match(/<\/d>/g) || []).length) fail("对白标签未闭合");
  for (const d of dialogues) {
    if (d[0] !== "<d>" || !/^\[[A-Za-z][A-Za-z -]*\]\s*\S/.test(prompt.slice(d.index! + d[0].length))) fail("对白必须使用 <d>[English] ...</d> 格式，地区/口音写在标签外");
  }
  if (sections.filter(s => s !== "detailed_description").some(s => /<d\b/.test(body[s]))) fail("完整对白只能出现在 detailed_description");
}
