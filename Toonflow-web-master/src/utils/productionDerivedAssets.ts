import type { AssetItem } from "../views/production/utils/flowBuilder";

export interface CommittedDerivedAsset {
  assetsId: number;
  id: number;
  name: string;
  describe: string;
}

/** Synchronize a committed description without replacing existing generated media. */
export function syncCommittedDerivedAsset(
  assets: AssetItem[],
  data: CommittedDerivedAsset,
): "missing" | "updated" | "added" {
  const parent = assets.find((asset) => asset.id === data.assetsId);
  if (!parent) return "missing";

  const derive = (parent.derive ??= []);
  const existing = derive.find((asset) => asset.id === data.id);
  if (existing) {
    existing.name = data.name;
    existing.type = parent.type;
    existing.desc = data.describe;
    return "updated";
  }

  derive.push({
    assetsId: data.assetsId,
    id: data.id,
    name: data.name,
    type: parent.type,
    desc: data.describe,
    prompt: "",
    state: "未生成",
    src: "",
  });
  return "added";
}
