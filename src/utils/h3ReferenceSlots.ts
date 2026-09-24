export type H3RoleView = "BOARD" | "FACE" | "FRONT" | "SIDE" | "BACK";
export type H3ReferenceMode = "board" | "auto" | "manual";
export type H3SlotItem = Record<string, any> & {
  _referenceRole?: H3RoleView;
  h3ReferenceMode?: H3ReferenceMode;
  h3Views?: H3RoleView[];
  h3ShotView?: "front" | "side" | "back" | "turn" | "closeup";
};

/** Exactly the same view planner must be used before prompt creation and before uploading images. */
export function selectedH3Views(item: H3SlotItem): H3RoleView[] {
  const mode = item.h3ReferenceMode || "board";
  if (mode === "board") return ["BOARD"];
  if (mode === "manual") {
    const views = item.h3Views || [];
    if (!views.length || views.includes("BOARD") && views.length > 1 || new Set(views).size !== views.length || views.some(v => !["BOARD", "FACE", "FRONT", "SIDE", "BACK"].includes(v))) {
      throw new Error("H3 手动参考视图无效：请选完整四视图或至少一个独立视图，不能重复或混合 BOARD");
    }
    return views;
  }
  if (mode !== "auto") throw new Error(`未知 H3 参考模式：${mode}`);
  switch (item.h3ShotView) {
    case "side": return ["SIDE", "FACE"];
    case "back": return ["BACK", "FRONT"];
    case "turn": return ["BACK", "SIDE", "FACE"];
    case "closeup": return ["FACE", "FRONT"];
    case "front": return ["FRONT", "FACE"];
    default: return ["BOARD"]; // no reliable shot angle: do not guess
  }
}

/** The source layout is FACE / FRONT / SIDE / BACK, approved manually by the user. */
export function expandH3AssetSlots(items: H3SlotItem[]): H3SlotItem[] {
  const expanded = items.flatMap(item => {
    const type = String(item.type || item.assetType || "").toLowerCase();
    if (type !== "role" && type !== "character") return [item];
    return selectedH3Views(item).map(view => ({
      ...item,
      _referenceRole: view,
      // Keep the asset's original identity and current state; only change view label.
      name: `${item.name || "角色"}（${({ BOARD: "完整四视图", FACE: "脸部", FRONT: "正面全身", SIDE: "侧面全身", BACK: "背面全身" } as Record<H3RoleView, string>)[view]}）`,
    }));
  });
  if (expanded.length > 9) throw new Error(`MiniMax H3 最多支持 9 张参考图；本镜头需要 ${expanded.length} 张，请减少视图或主体`);
  return expanded;
}
