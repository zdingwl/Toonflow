import type { RoleReferenceKind } from "@/utils/assetReferenceMedia";

export type H3SlotItem = Record<string, any> & { _referenceRole?: RoleReferenceKind };

export function h3AssetType(item: H3SlotItem): string {
  const type = String(item.assetType || item.type || "").toLowerCase();
  if (type === "character") return "role";
  if (type === "environment") return "scene";
  if (type === "prop" || type === "creature") return "tool";
  return type;
}

/** Only image assets consume Picture slots; audio/video and storyboard guides stay separate. */
export function h3ImageAssetItems(items: H3SlotItem[]): H3SlotItem[] {
  const seen = new Set<string>();
  return items.filter((item, index) => {
    const mediaType = String(item.fileType || item._fileType || "").toLowerCase();
    const referenceType = String(item.referenceType || item._slotType || "").toLowerCase();
    const source = item.sourceType || item.sources || item._type;
    if (item._reference === false || item.reference === false || source === "storyboard" || h3AssetType(item) === "storyboard") return false;
    if (["audio", "video"].includes(mediaType) || ["audio", "video"].includes(h3AssetType(item)) || ["audioreference", "videoreference"].includes(referenceType)) return false;
    const id = item.assetId ?? item.id;
    const key = id == null ? `anonymous:${index}` : `asset:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One current asset image per Picture; character boards are never expanded into crops. */
export function expandH3AssetSlots(items: H3SlotItem[], _directionText = ""): H3SlotItem[] {
  const assets = h3ImageAssetItems(items);
  if (assets.length > 9) throw new Error(`MiniMax H3 最多支持 9 张参考图，当前有 ${assets.length} 个独立图片资产；请拆分镜头或减少可见资产后重新生成提示词`);
  return assets.map(({ _referenceRole, referenceKind, ...item }) => item);
}
