import type { H3ReferencePlanSlot } from "./h3ReferencePlan";
import { assertH3PictureSlots } from "./h3VisualStateGuard";

export type H3ReferenceBindingSlot = Pick<H3ReferencePlanSlot, "assetId" | "assetType" | "kind">;

const fail = (reason: string): never => {
  throw new Error(`H3 参考图绑定：${reason}，请重新生成视频提示词`);
};

/** Optional semantic anchors: free-form prompts may use Subject labels anywhere. */
function subjectPictureBindings(prompt: string, pictureCount: number): Map<number, number[]> {
  const bindings = new Map<number, number[]>();
  const mentions = [...prompt.matchAll(/<Subject\s+(\d+)>/gi)];
  for (let index = 0; index < mentions.length; index++) {
    const subject = Number(mentions[index][1]);
    const start = mentions[index].index!;
    const end = mentions[index + 1]?.index ?? prompt.length;
    const pictures = [...new Set([...prompt.slice(start, end).matchAll(/<Picture\s+(\d+)>/gi)].map(match => Number(match[1])))].sort((a, b) => a - b);
    for (const picture of pictures) {
      if (picture < 1 || picture > pictureCount) fail(`<Subject ${subject}> 引用了不存在的 <Picture ${picture}>`);
    }
    if (!pictures.length) continue;
    const previous = bindings.get(subject);
    if (previous && previous.join(",") !== pictures.join(",")) fail(`<Subject ${subject}> 的 Picture 对应关系不一致`);
    bindings.set(subject, pictures);
  }
  return bindings;
}

/**
 * The persisted reference plan owns upload order and asset identity.
 * Prompt text is free-form; only explicit Picture tags must match real slots.
 */
export function assertH3ReferenceBindings(prompt: string, slots: readonly H3ReferenceBindingSlot[], sourcePrompt?: string): void {
  assertH3PictureSlots(prompt, slots.length);
  const targetBindings = subjectPictureBindings(prompt, slots.length);
  if (sourcePrompt !== undefined) {
    assertH3PictureSlots(sourcePrompt, slots.length);
    const sourceBindings = subjectPictureBindings(sourcePrompt, slots.length);
    for (const [subject, pictures] of sourceBindings) {
      const target = targetBindings.get(subject);
      if (target && target.join(",") !== pictures.join(",")) fail(`<Subject ${subject}> 在翻译前后对应了不同的 Picture`);
    }
  }
}
