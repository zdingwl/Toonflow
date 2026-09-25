import type { H3ReferencePlanSlot } from "./h3ReferencePlan";

export type H3ReferenceBindingSlot = Pick<H3ReferencePlanSlot, "assetId" | "assetType" | "kind">;
const hasDefinitions = (prompt: string) => /^subject_definitions:\s*/m.test(prompt);
const fail = (reason: string): never => { throw new Error(`H3 参考图绑定：${reason}，请重新生成视频提示词`); };

function subjectAssets(prompt: string, slots: readonly H3ReferenceBindingSlot[]): Map<string, number> {
  const section = /^subject_definitions:[ \t]*(?:\r?\n)?([\s\S]*?)(?=^summary:)/m.exec(prompt)?.[1];
  if (section == null) fail("缺少完整的 subject_definitions 定义");
  const definitions = [...section!.matchAll(/^<(Subject|Picture|Video|Audio)\s+(\d+)>[ \t]+/gm)];
  const owners = new Map<number, string>();
  const byAsset = new Map<number, string>();
  const bySubject = new Map<string, number>();
  const seenSubjects = new Set<string>();
  const subjects: { subject: string; assetId: number; assetType: string; pictures: number[] }[] = [];

  // First establish each Subject's primary asset from its first source Picture.
  // Only that asset's own views count toward the required slot coverage.
  for (let index = 0; index < definitions.length; index++) {
    const definition = definitions[index];
    if (definition[1] !== "Subject") continue;
    const subject = "<Subject " + Number(definition[2]) + ">";
    if (seenSubjects.has(subject)) fail(subject + " 重复定义");
    seenSubjects.add(subject);
    const body = section!.slice(definition.index! + definition[0].length, definitions[index + 1]?.index ?? section!.length);
    const pictures = [...new Set([...body.matchAll(/<Picture\s+(\d+)>/g)].map(match => Number(match[1])))];
    for (const picture of pictures) {
      if (!slots[picture - 1]) fail(subject + " 引用了不存在的 <Picture " + picture + ">");
    }
    if (!pictures.length) continue; // Subjects sourced only from video are valid.
    const primary = slots[pictures[0] - 1];
    for (const picture of pictures) {
      const slot = slots[picture - 1];
      if (slot.assetId === primary.assetId) continue;
      const canHaveSceneContext = ["role", "character", "tool", "prop", "creature"].includes(primary.assetType.toLowerCase());
      const isScene = ["scene", "environment"].includes(slot.assetType.toLowerCase());
      if (!canHaveSceneContext || !isScene) fail(subject + " 混用了不同资产的参考图");
    }
    for (const picture of pictures) {
      if (slots[picture - 1].assetId !== primary.assetId) continue;
      const owner = owners.get(picture);
      if (owner && owner !== subject) fail("<Picture " + picture + "> 被多个 Subject 重复引用");
      owners.set(picture, subject);
    }
    const previous = byAsset.get(primary.assetId);
    if (previous && previous !== subject) fail("同一资产 " + primary.assetId + " 的多张参考图被拆成多个 Subject");
    byAsset.set(primary.assetId, subject);
    bySubject.set(subject, primary.assetId);
    subjects.push({ subject, assetId: primary.assetId, assetType: primary.assetType.toLowerCase(), pictures });
  }

  // A person/prop/creature can also be visible in an independently bound scene.
  // Resolve these contextual mentions after every primary binding is known.
  for (const { assetId, pictures } of subjects) {
    for (const picture of pictures) {
      const slot = slots[picture - 1];
      if (slot.assetId !== assetId && !byAsset.has(slot.assetId)) fail("<Picture " + picture + "> 作为背景场景仍需独立 Subject 定义");
    }
  }
  for (let index = 0; index < slots.length; index++) {
    if (!owners.has(index + 1)) fail("<Picture " + (index + 1) + "> 必须在唯一 Subject 定义中绑定资产，不能只在正文、背景引用或独立画面锚点中出现");
  }
  return bySubject;
}

/** Keep every asset's crops under one Subject and preserve that binding during edits/translations. */
export function assertH3ReferenceBindings(prompt: string, slots: readonly H3ReferenceBindingSlot[], sourcePrompt?: string): void {
  if (!slots.length) return;
  // Historical plain-text plans predate the six-section contract; copying them stays compatible.
  if (sourcePrompt !== undefined && !hasDefinitions(sourcePrompt)) return;
  const target = subjectAssets(prompt, slots);
  if (sourcePrompt === undefined) return;
  const source = subjectAssets(sourcePrompt, slots);
  if (source.size !== target.size || [...source].some(([subject, assetId]) => target.get(subject) !== assetId)) {
    fail("Subject 与资产的对应关系已变化");
  }
}