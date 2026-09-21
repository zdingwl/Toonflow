/** 中文使用相邻双字，英文使用完整词；只用于候选召回，最终仍按向量排序。 */
export function searchTerms(text: string, limit = 80): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  for (const word of normalized.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(word);
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (segment.length === 1) terms.add(segment);
    for (let i = 0; i < segment.length - 1; i++) terms.add(segment.slice(i, i + 2));
  }
  return [...terms].slice(0, limit);
}
