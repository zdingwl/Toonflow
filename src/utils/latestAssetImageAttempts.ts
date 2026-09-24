type ImageAttempt = {
  id: number;
  assetsId?: number | null;
  state?: string | null;
};

/** Rows must be ordered newest-first. Keeps one current attempt per asset. */
export function latestAssetImageAttempts<T extends ImageAttempt>(attempts: T[]): T[] {
  const latestByAsset = new Map<number, T>();
  attempts.forEach((item) => {
    if (item.assetsId != null && !latestByAsset.has(item.assetsId)) latestByAsset.set(item.assetsId, item);
  });
  return Array.from(latestByAsset.values());
}
