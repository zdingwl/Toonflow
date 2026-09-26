import { assertH3PictureSlots } from "./h3VisualStateGuard";

const MAX_H3_PROMPT_LENGTH = 30_000;

// Only a locale directly after the language label is metadata; later speech stays untouched.
const dialogueLocalePrefix = /(<d>\[[A-Za-z][A-Za-z -]*\])\s*\(([a-z]{2,3}-(?:[A-Z][a-z]{3}(?:-(?:[A-Z]{2}|\d{3}))?|[A-Z]{2}|\d{3}))\)\s*/g;

export function normalizeH3DialogueLocales(prompt: string): string {
  return prompt.replace(dialogueLocalePrefix, (_, label: string, locale: string) => "(spoken locale: " + locale + ") " + label + " ");
}

/** Canonicalize explicit cut times only; never impose headings or a section layout. */
export function normalizeH3PromptFormat(prompt: string): string {
  return normalizeH3DialogueLocales(prompt).split(/(<d>[\s\S]*?<\/d>)/g).map((part, index) => index % 2 ? part : part.replace(
    /^(\[Shot ([2-9]|[1-9]\d+)\])\s+At\s+(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?\s*[,，:：]/gm,
    (_, shot, _number, minutes, seconds, fraction) => `${shot} At ${minutes.padStart(2, "0")}:${seconds}.${(fraction || "").padEnd(3, "0")},`,
  ).replace(/^(\[Shot (?:[2-9]|[1-9]\d+)\])\s+At\s+([0-5]?\d)\.(\d{1,3})\s*[,，:：]/gm,
    (_, shot, seconds, fraction) => `${shot} At 00:${seconds.padStart(2, "0")}.${fraction.padEnd(3, "0")},`)
    .replace(/[“”]/g, '"')).join("");
}

export const h3FormatChecklist = `Generate the final MiniMax H3 cinematic video prompt.

Analyze all reference images, videos and audio.

Prioritize:
- character identity preservation
- reference consistency
- cinematic camera movement
- realistic physics
- temporal continuity
- synchronized audio

Output only the final generation prompt.
Do not explain reasoning.
Do not use a fixed section template.`;

/** Basic runtime checks only. The final H3 prompt may use any structure or Markdown style. */
export function assertH3PromptContract(prompt: string, _duration: number, pictureCount: number): void {
  const fail = (reason: string): never => { throw new Error(`H3 提示词：${reason}`); };
  const value = String(prompt || "");
  if (!value.trim()) fail("内容不能为空");
  if (value.length > MAX_H3_PROMPT_LENGTH) fail(`长度不能超过 ${MAX_H3_PROMPT_LENGTH} 个字符`);
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail("包含非法控制字符");

  let openDialogue = false;
  for (const tag of value.matchAll(/<\/?d\b[^>]*>/gi)) {
    if (tag[0].toLowerCase() === "<d>") {
      if (openDialogue) fail("对白标签不得嵌套");
      openDialogue = true;
    } else if (tag[0].toLowerCase() === "</d>") {
      if (!openDialogue) fail("对白结束标签没有对应的开始标签");
      openDialogue = false;
    } else fail("对白标签必须使用 <d>...</d>");
  }
  if (openDialogue) fail("对白标签未闭合");

  assertH3PictureSlots(value, pictureCount);
}
