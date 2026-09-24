export type H3SlotItem = Record<string, any> & { _referenceRole?: "FACE" | "FULL_BODY_FRONT" };

/** Mirrors the runtime order: every role contributes FACE then FULL_BODY_FRONT. */
export function expandH3AssetSlots(items: H3SlotItem[]): H3SlotItem[] {
  const expanded = items.flatMap((item) => {
    const type = String(item.type || item.assetType || "").toLowerCase();
    if (type !== "role" && type !== "character") return [item];
    return [
      { ...item, _referenceRole: "FACE", name: `${item.name || "角色"}脸部身份参考` },
      { ...item, _referenceRole: "FULL_BODY_FRONT", name: `${item.name || "角色"}正面全身参考` },
    ];
  });
  if (expanded.length > 9) {
    throw new Error(`MiniMax H3 最多支持 9 张参考图，当前人物身份、场景和道具共需要 ${expanded.length} 张；请减少当前镜头的可见资产`);
  }
  return expanded;
}
