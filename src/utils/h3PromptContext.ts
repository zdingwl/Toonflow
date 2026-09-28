import { h3AssetType, type H3SlotItem } from "./h3ReferenceSlots";

export function h3BindingSlots(slots: H3SlotItem[]) {
  return slots.map(item => ({ assetId: Number(item.assetId ?? item.id), assetType: h3AssetType(item), kind: item._referenceRole ?? item.referenceKind }));
}

/** A character display board occupies one Picture and defines one Subject. */
export function buildH3ReferenceSubjects(slots: H3SlotItem[]) {
  const groups = new Map<number, { subject: string; assetId: number; assetType: string; name: string; parentAssetId?: number; pictures: { picture: string; view?: string }[] }>();
  slots.forEach((item, index) => {
    const id = Number(item.assetId ?? item.id);
    let group = groups.get(id);
    if (!group) {
      group = {
        subject: `<Subject ${groups.size + 1}>`, assetId: id, assetType: h3AssetType(item),
        name: String(item._assetName || item.name || item.label || `asset ${id}`).replace(/(?:脸部身份参考|正面全身参考|侧面全身参考|背面全身参考)$/, ""),
        ...(item.assetsId || item.parentAssetId ? { parentAssetId: Number(item.assetsId || item.parentAssetId) } : {}), pictures: [],
      };
      groups.set(id, group);
    }
    group.pictures.push({ picture: `<Picture ${index + 1}>`, ...(item._referenceRole || item.referenceKind ? { view: item._referenceRole || item.referenceKind } : h3AssetType(item) === "role" ? { view: "CHARACTER_SHEET" } : {}) });
  });
  return [...groups.values()];
}

export function buildH3PromptInput(slots: H3SlotItem[], storyboards: { id?: number; duration?: unknown; videoDesc?: string | null }[], duration: number, otherReferences: unknown[] = []): string {
  const subjects = buildH3ReferenceSubjects(slots);
  // Keep IDs and uploaded order explicit, but send each asset definition and storyboard only once.
  const references = slots.map((item, index) => `<reference slot="${index + 1}" sources="assets" id="${Number(item.assetId ?? item.id)}" />`).join("\n");
  return `Mode: MiniMax H3 Ref2VA. target_duration: ${duration}s.
appearanceAuthority=the actual attached current image. Images establish appearance; storyboard facts establish events, dialogue and timing.
The grouped sources below are authoritative. Each character uses ONE complete reference sheet in ONE Picture slot. Its face, front, side and back panels depict the SAME person in ONE current state, not multiple people or separate uploaded Pictures. Treat each asset as one consistent subject and cite its actual Picture where it affects the video. Describe only views visible in the attached sheet. Preserve identity and outfit; never render the panel layout, repeated figures or display background in the video. Each selected image asset consumes one of the nine available image slots.
<referenceSlots>
${references}
</referenceSlots>
<referenceSubjects>
${JSON.stringify(subjects)}
</referenceSubjects>
${otherReferences.length ? `<otherReferences>${JSON.stringify(otherReferences)}</otherReferences>\n` : ""}<storyboardFacts>
${JSON.stringify(storyboards.map(item => ({ id: item.id, duration: item.duration, videoDesc: item.videoDesc || "" })))}
</storyboardFacts>
Write the complete MiniMax H3 Ref2VA generation prompt using exactly these six non-empty sections in this order:
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:

Define every reusable visible asset as one stable <Subject N> and cite the actual source <Picture N> in its definition. Use the same Subject/Picture meaning everywhere. summary must start with the applicable official task-type prefix. retention_analysis must contain exactly one valid preservation entry for every definition.

In detailed_description, establish the requested rendering style before [Shot 1]. [Shot 1] has no timestamp. Every later explicit cut uses [Shot N] At MM:SS.mmm, with sequential numbers and increasing times inside target_duration. Give every vocal source a stable consecutive (S1), (S2), etc.; a referenced speaker is written <Subject N> (Sx). Dialogue uses <d>[Language] complete sentence.</d> and stays in the requested spoken language.

Analyze the attached reference images and describe composition, appearance, position, environment and lighting, actions and state changes, camera movement, synchronized physical sound and reference usage. Preserve supplied cause and effect, speaker, exact dialogue, timing and event order. Do not replace an intentional action with an accident.

Output only the complete six-section prompt. Do not explain reasoning.`;
}

export function h3PromptWordCounts(prompt: string) {
  const words = (text: string) => (text.replace(/<(?:Subject|Picture|Video|Audio)\s+\d+>/g, "reference").match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  const headings = [...prompt.matchAll(/^(?:#{1,6}\s+([^\r\n]+)|([A-Za-z][A-Za-z0-9 _-]{1,80}):)\s*(?:\r?\n)?/gm)];
  return { total: words(prompt), sections: Object.fromEntries(headings.map((entry, index) => {
    const name = (entry[1] || entry[2]).trim();
    return [name, words(prompt.slice(entry.index! + entry[0].length, headings[index + 1]?.index ?? prompt.length))];
  })) };
}
