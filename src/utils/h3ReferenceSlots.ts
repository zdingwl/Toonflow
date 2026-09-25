import { requestedRoleReferenceKinds, type RoleReferenceKind } from "@/utils/assetReferenceMedia";

export type H3SlotItem = Record<string, any> & { _referenceRole?: RoleReferenceKind };

/** Mirrors the runtime order: every role contributes FACE then FULL_BODY_FRONT. */
export function expandH3AssetSlots(items: H3SlotItem[], directionText = ""): H3SlotItem[] {
  const expanded = items.flatMap((item) => {
    const type = String(item.type || item.assetType || "").toLowerCase();
    if (type !== "role" && type !== "character") return [item];
    const labels: Record<RoleReferenceKind, string> = {
      FACE: "脸部身份参考", FULL_BODY_FRONT: "正面全身参考",
      FULL_BODY_SIDE: "侧面全身参考", FULL_BODY_BACK: "背面全身参考",
    };
    return requestedRoleReferenceKinds(directionText).map(kind => ({
      ...item,
      _referenceRole: kind,
      name: `${item.name || "角色"}${labels[kind]}`,
    }));
  });
  if (expanded.length > 9) {
    throw new Error(`MiniMax H3 最多支持 9 张参考图，当前人物身份、场景和道具共需要 ${expanded.length} 张；请减少当前镜头的可见资产`);
  }
  return expanded;
}
