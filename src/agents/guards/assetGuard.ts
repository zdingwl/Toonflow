export interface GuardResult {
  pass: boolean;
  errors: string[];
}

export function validateAssetConflict(assetIds: number[]): GuardResult {
  const errors: string[] = [];
  const unique = new Set(assetIds);

  if (unique.size !== assetIds.length) {
    errors.push("duplicate asset reference");
  }

  return {
    pass: errors.length === 0,
    errors,
  };
}
