import fs from "node:fs";
import getPath from "./getPath";
import type { SystemModelMessage } from "ai";

/** Read on each request so all styles use the same current creative constraint. */
export function withContentConstraints(system?: string | SystemModelMessage | SystemModelMessage[]): SystemModelMessage[] {
  const existing = typeof system === "string" ? [{ role: "system" as const, content: system }] : system ? (Array.isArray(system) ? system : [system]) : [];
  return [...existing, { role: "system", content: fs.readFileSync(getPath(["skills", "global_content_constraints.md"]), "utf8") }];
}

const visualConstraint = "Visual content constraint: Prefer non-graphic, bloodless injury depiction using clothing or clean bandages covering the affected area, restrained pain reactions, protective gestures, silhouette, occlusion or a cutaway. Preserve story consequences, character identity, timing and reference slots. Never depict red blood or red wounds, including bright red, dark red, crimson or scarlet. Only when blood is necessary to the story, allow a small amount of GREEN or BLACK blood; preserve an explicitly established green or black choice, otherwise use muted dark green, consistently across the continuous scene. Never leave blood color unspecified or mix in red. Keep injuries covered; any necessary surface traces must be green or black. Avoid blood spray, blood mist, pools, large stained areas, open-wound close-ups, exposed tissue or gore. If a healed mark is necessary, use a subtle muted gray-brown closed scar. Preserve red clothing, lights, props and other non-injury colors. Apply this constraint to conflicting details in the supplied prompt and references.";
const maskSpeech = (text: string) => text.replace(/<d\b[^>]*>[\s\S]*?<\/d>/g, speech => speech.replace(/[^\r\n]/g, " "));
const h3Sections = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];

function h3Headings(text: string) {
  const masked = maskSpeech(text);
  const headings = [...masked.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):[ \t]*(?:\r?\n)?/gm)];
  if (headings.map(heading => heading[1]).join() !== h3Sections.join() || masked.slice(0, headings[0]?.index).trim()) return null;
  if (headings.some((heading, index) => !text.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? text.length).trim())) return null;
  return headings;
}

/** Also applies to old/manual prompts. Structured H3 keeps global visuals out of its audio fields. */
export function withNonGraphicVisuals(prompt: string): string {
  const masked = maskSpeech(prompt);
  const positions: number[] = [];
  for (let index = masked.indexOf(visualConstraint); index !== -1; index = masked.indexOf(visualConstraint, index + visualConstraint.length)) positions.push(index);
  const headings = h3Headings(prompt);
  if (headings) {
    const descriptionStart = headings[3].index! + headings[3][0].length;
    const firstShot = masked.indexOf("[Shot 1]", descriptionStart);
    if (positions.length === 1 && positions[0] >= descriptionStart && positions[0] < firstShot && firstShot < headings[4].index!) return prompt;
  } else if (positions.length === 1) return prompt;
  // Relocate a legacy trailing copy, and collapse repeated copies, without editing spoken words.
  let cleaned = prompt;
  for (const position of [...positions].reverse()) cleaned = cleaned.slice(0, position) + cleaned.slice(position + visualConstraint.length);
  const cleanHeadings = headings ? h3Headings(cleaned) : null;
  if (cleanHeadings) {
    const start = cleanHeadings[3].index! + cleanHeadings[3][0].length;
    const prefix = cleaned.slice(0, start);
    return `${prefix}${/[\r\n]$/.test(prefix) ? "" : "\n"}${visualConstraint}\n\n${cleaned.slice(start)}`;
  }
  return `${cleaned}\n\n${visualConstraint}`;
}
