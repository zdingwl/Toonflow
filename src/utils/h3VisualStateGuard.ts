export interface H3SelectedAsset {
  assetId: number;
  parentAssetId?: number | null;
  assetType?: string | null;
  name?: string | null;
  filePath?: string | null;
}

/**
 * Reject simultaneous base and derivative role images. This compares database
 * relationships, not guessed names, descriptions or image similarity.
 */
export function assertH3ActiveStates(assets: H3SelectedAsset[]): void {
  const active = new Map<number, H3SelectedAsset>();
  for (const asset of assets) {
    if (!asset.filePath) throw new Error(`H3 参考图缺失：${asset.name || asset.assetId}（资产 ID ${asset.assetId}）`);
    if (!['role', 'character'].includes(String(asset.assetType || '').toLowerCase())) continue;
    const rootId = Number(asset.parentAssetId) > 0 ? Number(asset.parentAssetId) : Number(asset.assetId);
    const existing = active.get(rootId);
    if (existing) {
      if (existing.assetId !== asset.assetId) {
        throw new Error(`同一人物的互斥形态不可同时引用：${existing.name || existing.assetId}（${existing.assetId}）与 ${asset.name || asset.assetId}（${asset.assetId}）；请选择当前镜头唯一有效状态`);
      }
      throw new Error(`H3 人物资产重复引用：${asset.name || asset.assetId}（${asset.assetId}）；同一人物只选择一次，所需视角会按镜头和图片额度分配`);
    }
    active.set(rootId, asset);
  }
}

/** Picture tags refer to the actual allocated image slots, not the number of assets. */
export function assertH3PictureSlots(prompt: string, slotCount: number): void {
  if (!Number.isInteger(slotCount) || slotCount < 0 || slotCount > 9) throw new Error(`MiniMax H3 参考图数量无效：${slotCount}，最多9张`);
  const raw = [...prompt.matchAll(/<Picture\s*(\d+)\s*>/gi)];
  if (!slotCount) {
    if (raw.length) throw new Error('当前没有上传 H3 参考图，但提示词仍引用了 Picture 槽位');
    return;
  }
  const ids = new Set(raw.map(match => Number(match[1])));
  if (ids.size !== slotCount || [...ids].some(n => !Number.isInteger(n) || n < 1 || n > slotCount)) {
    throw new Error(`H3 提示词 Picture 槽位与实际上传图不一致：需要 1..${slotCount}，实际出现 ${[...ids].sort((a,b)=>a-b).join(',') || '无'}`);
  }
}
