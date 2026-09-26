export interface H3SubmissionImage {
  id?: number | null;
  sources?: string;
  fileType?: string;
  type?: string;
  slotType?: string;
  reference?: boolean;
}

export interface H3SubmissionEntry {
  label: string;
  prompt: string;
  uploadData: readonly H3SubmissionImage[];
}

function isH3MultiReference(model: string, mode: unknown): boolean {
  if (!/minimax/i.test(model) || !/h3/i.test(model)) return false;
  let modes: unknown = mode;
  if (typeof modes === "string") {
    try { modes = JSON.parse(modes); }
    catch { modes = [modes]; }
  }
  return Array.isArray(modes) && modes.some(value => typeof value === "string" && /^imageReference(?::\d+)?$/i.test(value));
}

/** Check the actual submitted selection locally; this does not certify a backend's runtime plan. */
export function getH3ReferenceGuardError(model: string, mode: unknown, entries: readonly H3SubmissionEntry[]): string | null {
  if (!isH3MultiReference(model, mode)) return null;
  for (const entry of entries) {
    const images = entry.uploadData.filter(item => {
      const mediaType = (item.fileType || "").toLowerCase();
      const slotType = (item.type || item.slotType || "").toLowerCase();
      return item.sources === "assets" && item.reference !== false && Number.isSafeInteger(item.id)
        && !["audio", "video"].includes(mediaType) && !["audioreference", "videoreference"].includes(slotType);
    });
    const imageIds = new Set<number>();
    for (const image of images) {
      if (imageIds.has(image.id!)) return `${entry.label}：图片资产（ID ${image.id}）重复选择。请移除重复参考图，每张图片资产只保留一次。`;
      imageIds.add(image.id!);
    }
    const visualPrompt = entry.prompt.replace(/<d\b[^>]*>[\s\S]*?<\/d\s*>/gi, "");
    const pictures = [...new Set([...visualPrompt.matchAll(/<Picture\s+(\d+)>/gi)].map(match => Number(match[1])))].sort((a, b) => a - b);
    const count = imageIds.size;
    if (count >= 1 && count <= 9 && pictures.length === count && pictures.every((value, index) => value === index + 1)) continue;
    const expected = count > 9 ? "H3 最多支持 9 张完整参考图" : count === 0 ? "至少需要 1 张图片资产" : `图片编号应连续为 1–${count}`;
    return `${entry.label}：当前实际上传 ${count} 张独立图片，提示词引用 ${pictures.length} 张（编号：${pictures.join("、") || "无"}）；${expected}。请重新生成提示词。若旧服务仍将人物整图拆为多张，请等待正在运行的任务结束后重启后端，再重新生成提示词。`;
  }
  return null;
}
