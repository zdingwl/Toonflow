import { h3AssetType, type H3SlotItem } from "./h3ReferenceSlots";

export function h3BindingSlots(slots: H3SlotItem[]) {
  return slots.map(item => ({ assetId: Number(item.assetId ?? item.id), assetType: h3AssetType(item), kind: item._referenceRole ?? item.referenceKind }));
}

/** Describe what this uploaded image can define without promoting its source pose or camera. */
export function h3ReferenceRoleText(item: H3SlotItem): string {
  switch (h3AssetType(item)) {
    case "role":
      return "complete character sheet for ONE person; identity, facial/body proportions and wardrobe authority. Starting pose, support and action come from the storyboard.";
    case "scene":
      return "location and recognisable local features. Target framing, camera and visible action come from the storyboard; the source view is not an establishing-shot instruction.";
    case "tool":
      return "object or creature design. Its use, contact and action come from the storyboard; incidental people or limbs do not define another character.";
    default:
      return "visible design reference. Use only the features needed for the supplied shot; framing and action come from the storyboard.";
  }
}

/** A character display board occupies one Picture and defines one Subject. */
export function buildH3ReferenceSubjects(slots: H3SlotItem[]) {
  const groups = new Map<number, { subject: string; assetId: number; assetType: string; name: string; identityName?: string; parentAssetId?: number; pictures: { picture: string; view?: string }[] }>();
  slots.forEach((item, index) => {
    const id = Number(item.assetId ?? item.id);
    let group = groups.get(id);
    if (!group) {
      group = {
        subject: `<Subject ${groups.size + 1}>`, assetId: id, assetType: h3AssetType(item),
        name: String(item._assetName || item.name || item.label || `asset ${id}`).replace(/(?:脸部身份参考|正面全身参考|侧面全身参考|背面全身参考)$/, ""),
        ...(item._identityName ? { identityName: String(item._identityName) } : {}),
        ...(item.assetsId || item.parentAssetId ? { parentAssetId: Number(item.assetsId || item.parentAssetId) } : {}), pictures: [],
      };
      groups.set(id, group);
    }
    group.pictures.push({ picture: `<Picture ${index + 1}>`, ...(item._referenceRole || item.referenceKind ? { view: item._referenceRole || item.referenceKind } : h3AssetType(item) === "role" ? { view: "CHARACTER_SHEET" } : {}) });
  });
  return [...groups.values()];
}

export type H3PromptStoryboard = { id?: number; duration?: unknown; videoDesc?: string | null };
export type H3CameraPlanRow = {
  storyboardId?: number;
  sourceRow: number;
  startSeconds: number;
  endSeconds: number;
  framing: string;
  camera: string;
};

function positiveSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** Extract existing camera cells only when a board's rows and execution window are known. */
export function buildH3CameraPlan(storyboards: H3PromptStoryboard[], targetDuration: number): H3CameraPlanRow[] {
  if (positiveSeconds(targetDuration) === undefined) return [];
  const plan: H3CameraPlanRow[] = [];
  let cursor: number | undefined = 0;
  const roundSeconds = (seconds: number) => Math.round(seconds * 1000) / 1000;
  for (const board of storyboards) {
    const boardDuration = positiveSeconds(board.duration);
    if (boardDuration === undefined) { cursor = undefined; continue; }
    if (cursor === undefined) continue;
    const start = cursor;
    cursor += boardDuration;
    const lines = (board.videoDesc || "").split(/\r?\n/).filter(line => /^\s*\|\s*\d+\s*\|/.test(line));
    const rows: { sourceRow: number; duration: number; framing: string; camera: string }[] = [];
    let valid = lines.length > 0;
    for (const line of lines) {
      const trimmed = line.trim();
      const cells = trimmed.endsWith("|") ? trimmed.slice(1, -1).split("|").map(cell => cell.trim()) : [];
      const seconds = positiveSeconds(cells[2]);
      if (cells.length !== 7 || !/^\d+$/.test(cells[0]) || !Number.isSafeInteger(Number(cells[0])) || seconds === undefined) { valid = false; break; }
      rows.push({ sourceRow: Number(cells[0]), duration: seconds, framing: cells[3], camera: cells[4] });
    }
    if (!valid || Math.abs(rows.reduce((sum, row) => sum + row.duration, 0) - boardDuration) > 0.05 + 1e-9 || cursor > targetDuration + 1e-9) continue;
    let elapsed = 0;
    const window: H3CameraPlanRow[] = rows.map((row, index) => {
      const startSeconds = roundSeconds(start + elapsed);
      elapsed += row.duration;
      // Within the accepted rounding tolerance, keep the last endpoint on the
      // declared board boundary so consecutive boards cannot overlap or drift.
      const endSeconds = roundSeconds(index === rows.length - 1 ? cursor! : start + elapsed);
      return {
        ...(board.id === undefined ? {} : { storyboardId: board.id }), sourceRow: row.sourceRow,
        startSeconds, endSeconds, framing: row.framing, camera: row.camera,
      };
    });
    if (window.some(row => row.startSeconds < 0 || row.endSeconds <= row.startSeconds || row.endSeconds > targetDuration)) continue;
    plan.push(...window);
  }
  return plan;
}

export function buildH3PromptInput(slots: H3SlotItem[], storyboards: H3PromptStoryboard[], duration: number, otherReferences: unknown[] = []): string {
  const subjects = buildH3ReferenceSubjects(slots);
  const cameraPlan = buildH3CameraPlan(storyboards, duration);
  // Keep IDs and uploaded order explicit, but send each asset definition and storyboard only once.
  const references = slots.map((item, index) => `<reference slot="${index + 1}" sources="assets" id="${Number(item.assetId ?? item.id)}" />`).join("\n");
  return `Mode: MiniMax H3 Ref2VA. target_duration: ${duration}s.
appearanceAuthority=the actual attached current image for identity, facial/body proportions and wardrobe.
renderingAuthority=the selected project video rendering guide for medium, material treatment and cinematic lighting; retain those identity and design attributes.
storyboardAuthority=the supplied framing, initial state, actions, speakers, complete dialogue, timing and event order.
Fixed actor bindings (never renumber by order of speaking): ${subjects.filter(item => item.assetType === "role").map(item => `${JSON.stringify(item.identityName || item.name)}${item.identityName ? ` (selected state ${JSON.stringify(item.name)})` : ""}, asset ID ${item.assetId} = ${item.subject} from ${item.pictures.map(source => source.picture).join(" and ")}`).join("; ") || "no character references"}.
Resolve every storyboard actor and speaker through that name-to-Subject assignment before writing its action or dialogue; the attached image for that Subject is its visual identity. Use Subject labels in output, not non-English asset metadata names.
Each character uses ONE complete reference sheet in ONE Picture slot. Its visible face, front, side and back panels depict the SAME person in ONE current state, not multiple people or separate uploaded Pictures. Preserve identity and outfit; the panel layout, repeated figures and display background are not video content.
In referenceSubjects, role assets supply character design, scene assets supply the location's relevant local features, and tool assets supply object or creature design. Source poses, incidental contacts and wide source compositions do not determine the target shot. Each selected image asset consumes one of the nine available image slots.
<referenceSlots>
${references}
</referenceSlots>
<referenceSubjects>
${JSON.stringify(subjects)}
</referenceSubjects>
${otherReferences.length ? `<otherReferences>${JSON.stringify(otherReferences)}</otherReferences>\n` : ""}<cameraPlan>
${JSON.stringify(cameraPlan)}
</cameraPlan>
cameraPlan lists only validated seven-column table rows and their execution windows. Each listed row is one supplied source shot, even when adjacent rows share framing, a fixed camera or continuous action. In detailed_description, start a new sequential Shot for every listed row at its startSeconds; the opening shot at 0 uses [Shot 1] without a timestamp, and every later row uses [Shot N] At MM:SS.mmm, with that row's startSeconds. Preserve each row's non-empty framing and camera over its startSeconds/endSeconds window; do not merge rows or replace a supplied micro-move or slow push with a generic fixed shot. Blank cells impose no camera or framing instruction and must not be filled by inference; they do not remove a supplied row boundary. A legacy explicit cut inside a row still needs its own Shot heading within that row's window: preserve a supplied cut time, or use only a clear supplied action boundary that fits the window, never an arbitrary new event or extra duration. A word such as “hard cut” quoted as dialogue or visible text is not a camera instruction. For unlisted rows, boards whose timing is unknown and legacy natural-language descriptions, preserve the original facts and only their explicit cuts; do not invent row timing or cut boundaries. Number all actual shots in full source playback order.
<storyboardFacts>
${JSON.stringify(storyboards.map(item => ({ id: item.id, duration: item.duration, videoDesc: item.videoDesc || "" })))}
</storyboardFacts>
Compile these facts using the system's complete six-section format and exact Subject/Picture bindings. Include only details needed to identify a reference or execute a supplied shot. Preserve supplied cause and effect, speaker, exact dialogue, timing and event order. Do not replace an intentional action with an accident. Do not invent cuts, camera moves or secondary events to enrich the description.
Output only the complete prompt. Do not explain reasoning.`;
}

export function h3PromptWordCounts(prompt: string) {
  const words = (text: string) => (text.replace(/<(?:Subject|Picture|Video|Audio)\s+\d+>/g, "reference").match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  const headings = [...prompt.matchAll(/^(?:#{1,6}\s+([^\r\n]+)|([A-Za-z][A-Za-z0-9 _-]{1,80}):)\s*(?:\r?\n)?/gm)];
  return { total: words(prompt), sections: Object.fromEntries(headings.map((entry, index) => {
    const name = (entry[1] || entry[2]).trim();
    return [name, words(prompt.slice(entry.index! + entry[0].length, headings[index + 1]?.index ?? prompt.length))];
  })) };
}
