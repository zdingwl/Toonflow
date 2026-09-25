import type { RoleReferenceKind } from "@/utils/assetReferenceMedia";

export type H3SlotItem = Record<string, any> & { _referenceRole?: RoleReferenceKind };
const labels: Record<RoleReferenceKind, string> = {
  FACE: "脸部身份参考", FULL_BODY_FRONT: "正面全身参考",
  FULL_BODY_SIDE: "侧面全身参考", FULL_BODY_BACK: "背面全身参考",
};

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

function directionalKinds(items: H3SlotItem[], directionText: string): Map<H3SlotItem, Set<RoleReferenceKind>> {
  const roles = items.filter(item => h3AssetType(item) === "role");
  const needed = new Map(roles.map(item => [item, new Set<RoleReferenceKind>()]));
  const entities = items.flatMap(item => Array.from(new Set([item.name, item.label, item.characterName].filter(value => typeof value === "string" && value.trim()))).map(name => ({ name: String(name), role: h3AssetType(item) === "role" ? item : null })));
  // Unnamed single-role camera directions may refer to that role, but named objects never do.
  for (const name of ["手机", "屏幕", "道具", "箱子", "盒子", "桌子", "椅子", "船体", "邮轮", "建筑", "门板", "巨鲨", "鲨鱼", "phone", "screen", "box", "ship", "shark"]) entities.push({ name, role: null });
  const visualText = String(directionText || "").split(/\r?\n/).filter(line => !/^\s*(?:【?关联资产】?|assets?\s*list|reference\s*assets)\s*[:：]?/i.test(line)).join("\n");
  for (const sentence of visualText.split(/[。.!！？?\n;；｜|]/)) {
    if (/四视图|三视图|四栏|角色设定图|人物设定图|character\s+sheet|four[- ](?:view|panel)|front\s*[,/]\s*side/i.test(sentence)) continue;
    if (/^\s*(?:台词|音效|关联资产)\s*[:：]/.test(sentence)) continue;
    let active: H3SlotItem[] | null = null;
    for (const clause of sentence.split(/[，,]/)) {
      const mentions: { index: number; end: number; role: H3SlotItem | null; name: string }[] = [];
      const lowered = clause.toLowerCase();
      for (const entity of entities) {
        let start = 0, index: number;
        while ((index = lowered.indexOf(entity.name.toLowerCase(), start)) >= 0) {
          // Do not match short English names inside unrelated words.
          const isLatin = /^[a-z ]+$/i.test(entity.name);
          if (!isLatin || (!/[a-z]/i.test(clause[index - 1] || "") && !/[a-z]/i.test(clause[index + entity.name.length] || ""))) mentions.push({ index, end: index + entity.name.length, ...entity });
          start = index + entity.name.length;
        }
      }
      mentions.sort((a, b) => a.index - b.index || b.name.length - a.name.length);
      const distinct = mentions.filter((mention, index) => !mentions.slice(0, index).some(previous => previous.index <= mention.index && previous.end >= mention.end));
      const groupAt = (index: number): H3SlotItem[] => {
        const last = distinct[index];
        if (!last?.role) return [];
        const group = [last.role];
        for (let before = index - 1; before >= 0; before--) {
          const previous = distinct[before];
          if (!previous.role || !/^\s*(?:和|与|及|、|and|&)\s*$/i.test(clause.slice(previous.end, distinct[before + 1].index))) break;
          group.unshift(previous.role);
        }
        return group;
      };
      const direction = /侧面|侧身|侧脸|\bprofile\b|\bside view\b|\bfrom the side\b|背面|背影|背对|背向|后背|\bback view\b|\brear view\b|\bfrom behind\b/gi;
      for (const match of clause.matchAll(direction)) {
        const at = match.index!;
        const before = clause.slice(Math.max(0, at - 24), at);
        if (/不(?:要|应|能|得|允许)?[^，,。;；]{0,16}$|避免[^，,。;；]{0,16}$|禁止[^，,。;；]{0,16}$|无需[^，,。;；]{0,16}$|\b(?:no|not|never|without|avoid)\b[^,.;]{0,18}$/i.test(before)) continue;
        const preceding = distinct.map((mention, index) => ({ mention, index })).filter(({ mention }) => mention.index <= at).at(-1);
        const following = distinct.findIndex(mention => mention.index > at && mention.index - at < match[0].length + 14);
        const targets = preceding ? groupAt(preceding.index) : following >= 0 ? groupAt(following) : active !== null ? active : roles.length === 1 && !distinct.length ? roles : [];
        const kind: RoleReferenceKind = /侧|profile|side/i.test(match[0]) ? "FULL_BODY_SIDE" : "FULL_BODY_BACK";
        for (const target of targets) needed.get(target)?.add(kind);
      }
      if (distinct.length) active = groupAt(distinct.length - 1);
    }
  }
  return needed;
}

/** One slot per distinct asset first, then faces, then explicitly requested role views. */
export function expandH3AssetSlots(items: H3SlotItem[], directionText = ""): H3SlotItem[] {
  const assets = h3ImageAssetItems(items);
  if (assets.length > 9) throw new Error(`MiniMax H3 最多支持 9 张参考图，当前有 ${assets.length} 个独立图片资产；请拆分镜头或减少可见资产后重新生成提示词`);
  const roles = assets.filter(item => h3AssetType(item) === "role");
  const allocation = new Map(roles.map(item => [item, new Set<RoleReferenceKind>(["FULL_BODY_FRONT"])]));
  let remaining = 9 - assets.length;
  for (const role of roles) if (remaining > 0) { allocation.get(role)!.add("FACE"); remaining--; }
  const directions = directionalKinds(assets, directionText);
  for (const role of roles) for (const kind of ["FULL_BODY_SIDE", "FULL_BODY_BACK"] as RoleReferenceKind[]) {
    if (remaining > 0 && directions.get(role)?.has(kind)) { allocation.get(role)!.add(kind); remaining--; }
  }
  const order: RoleReferenceKind[] = ["FACE", "FULL_BODY_FRONT", "FULL_BODY_SIDE", "FULL_BODY_BACK"];
  return assets.flatMap(item => h3AssetType(item) !== "role" ? [item] : order.filter(kind => allocation.get(item)!.has(kind)).map(kind => ({
    ...item, _referenceRole: kind, name: `${item.name || item.label || "角色"}${labels[kind]}`,
  })));
}
