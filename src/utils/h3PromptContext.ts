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
The grouped sources below are authoritative. Each character uses ONE complete reference sheet in ONE Picture slot. Its face, front, side and back panels depict the SAME person in ONE current state, not multiple people or separate uploaded Pictures. Define one Subject per asset and cite its actual Picture. Describe only views visible in the attached sheet. Preserve identity and outfit; never render the panel layout, repeated figures or display background in the video. Each selected image asset consumes one of the nine available image slots.
<referenceSlots>
${references}
</referenceSlots>
<referenceSubjects>
${JSON.stringify(subjects)}
</referenceSubjects>
${otherReferences.length ? `<otherReferences>${JSON.stringify(otherReferences)}</otherReferences>\n` : ""}<storyboardFacts>
${JSON.stringify(storyboards.map(item => ({ id: item.id, duration: item.duration, videoDesc: item.videoDesc || "" })))}
</storyboardFacts>
Write the full six-section Ref2VA prompt from these images and storyboard facts. Definitions must identify each source, its role and visible characteristics; preservation instructions alone are not an appearance description. In the shots, use the defined Subject labels at their first clear appearance and reuse them later. Establish composition, visible appearance and position, environment/light, actions and state changes, camera, synchronized sound and where each reference takes effect. Cross-check retention shot lists against this timeline. Preserve the supplied cause and effect, speaker, exact dialogue and event order. Do not replace an intentional action with an accident to simplify the prose.`;
}

export function h3PromptWordCounts(prompt: string) {
  const sections = [...prompt.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):\s*/gm)];
  const words = (text: string) => (text.replace(/<(?:Subject|Picture|Video|Audio)\s+\d+>/g, "reference").match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  return { total: words(prompt), sections: Object.fromEntries(sections.map((entry, index) => [entry[1], words(prompt.slice(entry.index! + entry[0].length, sections[index + 1]?.index ?? prompt.length))])) };
}
