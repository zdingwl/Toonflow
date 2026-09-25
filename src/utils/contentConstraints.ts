import fs from "node:fs";
import getPath from "./getPath";
import type { SystemModelMessage } from "ai";

/** Read on each request so all styles use the same current creative constraint. */
export function withContentConstraints(system?: string | SystemModelMessage | SystemModelMessage[]): SystemModelMessage[] {
  const existing = typeof system === "string" ? [{ role: "system" as const, content: system }] : system ? (Array.isArray(system) ? system : [system]) : [];
  return [...existing, { role: "system", content: fs.readFileSync(getPath(["skills", "global_content_constraints.md"]), "utf8") }];
}

/** Also applies when submitting an old or manually edited prompt directly to a media model. */
export function withNonGraphicVisuals(prompt: string): string {
  return `${prompt}\n\nVisual content constraint: Prefer non-graphic, bloodless injury depiction using clothing or clean bandages covering the affected area, restrained pain reactions, protective gestures, silhouette, occlusion or a cutaway. Preserve story consequences, character identity, timing and reference slots. Never depict red blood or red wounds, including bright red, dark red, crimson or scarlet. Only when blood is necessary to the story, allow a small amount of GREEN or BLACK blood; preserve an explicitly established green or black choice, otherwise use muted dark green, consistently across the continuous scene. Never leave blood color unspecified or mix in red. Keep injuries covered; any necessary surface traces must be green or black. Avoid blood spray, blood mist, pools, large stained areas, open-wound close-ups, exposed tissue or gore. If a healed mark is necessary, use a subtle muted gray-brown closed scar. Preserve red clothing, lights, props and other non-injury colors. Apply this constraint to conflicting details in the supplied prompt and references.`;
}
