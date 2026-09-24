export function normalizeScriptIds(value: unknown, allowedIds: Iterable<number>): number[] {
  const allowed = new Set([...allowedIds].filter((id) => Number.isInteger(id) && id > 0));
  let raw: unknown[] = [];

  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "number") {
    raw = [value];
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      raw = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      raw = text.split(/[\s,，;；]+/).filter(Boolean);
    }
  }

  const result: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const id = typeof item === "number" ? item : Number(String(item).trim());
    if (!Number.isInteger(id) || id <= 0 || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** A single-script extraction has only one valid owner, so repair missing or hallucinated IDs deterministically. */
export function normalizeScriptIdsForBatch(value: unknown, allowedIds: Iterable<number>): number[] {
  const allowed = [...allowedIds].filter((id) => Number.isInteger(id) && id > 0);
  const normalized = normalizeScriptIds(value, allowed);
  if (normalized.length) return normalized;
  return allowed.length === 1 ? [allowed[0]] : [];
}
