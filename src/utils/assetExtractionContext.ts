/** Conservative fallback until the effective model advertises its actual input/context limits. */
export const ASSET_EXTRACTION_INPUT_TOKEN_BUDGET = 14_000;
export const ASSET_EXTRACTION_RETRY_TOKEN_RESERVE = 1_000;
const SHARED_SYSTEM_TOKEN_RESERVE = 1_800;
const MODEL_CONTEXT_HEADROOM = 1_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 6_144;

export interface AssetExtractionBudgetPolicy {
  inputTokenBudget: number;
  retryTokenReserve: number;
  maxOutputTokens: number;
}

/** Model names are deliberately not used to guess limits. Explicit configuration is authoritative. */
export function resolveAssetExtractionBudgetPolicy(model?: {
  contextWindowTokens?: number; maxInputTokens?: number; maxOutputTokens?: number;
}, override?: number): AssetExtractionBudgetPolicy {
  const validLimit = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : undefined;
  const context = validLimit(model?.contextWindowTokens), maxInput = validLimit(model?.maxInputTokens);
  const configuredOutput = validLimit(model?.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = context === undefined ? configuredOutput : Math.min(configuredOutput, context);
  const safeContextInput = context === undefined ? undefined : Math.max(0, context - maxOutputTokens - MODEL_CONTEXT_HEADROOM);
  let inputTokenBudget = validLimit(override) ?? maxInput ?? safeContextInput ?? ASSET_EXTRACTION_INPUT_TOKEN_BUDGET;
  if (maxInput !== undefined) inputTokenBudget = Math.min(inputTokenBudget, maxInput);
  if (safeContextInput !== undefined) inputTokenBudget = Math.min(inputTokenBudget, safeContextInput);
  return { inputTokenBudget, retryTokenReserve: Math.min(ASSET_EXTRACTION_RETRY_TOKEN_RESERVE, inputTokenBudget), maxOutputTokens };
}

export type AssetSourceCatalog = { id: number; name?: string; excerpts: { sourceRef: string; quote: string }[] }[];

export function estimateAssetExtractionRequestTokens(system: string, input: unknown, wireSchema: unknown): number {
  // JSON keys/tool framing also consume context. The shared AI entry point adds
  // global content constraints after this function, accounted for by the reserve.
  const text = system + JSON.stringify(input) + JSON.stringify(wireSchema);
  let ascii = 0, other = 0;
  for (const character of text) character.codePointAt(0)! <= 127 ? ascii++ : other++;
  return Math.ceil(ascii / 3 + other * 1.1) + SHARED_SYSTEM_TOKEN_RESERVE + 256;
}

/** Only the wire enum is compacted; callers must retain their original schema for execute validation. */
export function compactSourceRefSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(compactSourceRefSchema);
  if (!schema || typeof schema !== "object") return schema;
  const copy: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "sourceRef" && value && typeof value === "object" &&
      Array.isArray((value as any).enum) && (value as any).enum.every((ref: unknown) => typeof ref === "string" && /^\d+:\d+$/u.test(ref))) {
      const { enum: _enum, ...reference } = value as any;
      copy[key] = { ...compactSourceRefSchema(reference), type: "string", pattern: "^[0-9]+:[0-9]+$" };
    } else copy[key] = compactSourceRefSchema(value);
  }
  return copy;
}

export function assertAssetExtractionRequestBudget(system: string, input: unknown, wireSchema: unknown, stage: string,
  policy: AssetExtractionBudgetPolicy = resolveAssetExtractionBudgetPolicy()) {
  const estimated = estimateAssetExtractionRequestTokens(system, input, wireSchema);
  if (estimated > policy.inputTokenBudget) {
    throw new Error(`${stage}输入超过安全上下文预算（估算 ${estimated} tokens，预算 ${policy.inputTokenBudget}）；未截断原文或事实，请减少单次设计约束或检查模型上下文配置`);
  }
  return estimated;
}

/**
 * Trim only optional peer/reference candidates, in priority order. All source, fact, user and prior
 * design fields survive untouched. The schema here is the wire JSON schema used by the estimator.
 * If required content still cannot fit, return it intact so the caller can collect/merge facts in
 * smaller stages instead of silently truncating the evidence.
 */
export function planAssetDesignInput<T extends Record<string, any>>(wireSchema: unknown, system: string, input: T,
  policy: AssetExtractionBudgetPolicy = resolveAssetExtractionBudgetPolicy()): T {
  const fields = ["siblingDesigns", "candidateCards", "cardCandidates", "referenceCandidates", "referenceCards"] as const;
  const planned = { ...input };
  for (const field of fields) if (Array.isArray(input[field])) (planned as Record<string, any>)[field] = [...input[field]];
  const fits = () => estimateAssetExtractionRequestTokens(system, planned, wireSchema) <= Math.max(0, policy.inputTokenBudget - policy.retryTokenReserve);
  for (const field of fields) {
    const candidates = planned[field];
    if (!Array.isArray(candidates)) continue;
    while (candidates.length && !fits()) candidates.pop();
    if (fits()) break;
  }
  return planned;
}

/** Contiguous slices preserve every code point, including whitespace and punctuation. */
export function splitAssetExtractionText(text: string, fits: (part: string) => boolean): string[] {
  if (fits(text)) return [text];
  if (!fits("")) throw new Error("资产提取固定规则或已有资产列表已超过上下文预算，无法安全分批");
  const characters = Array.from(text);
  const pieces: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = 1, high = characters.length - offset, length = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(characters.slice(offset, offset + middle).join(""))) { length = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (!length) throw new Error("资产提取原文无法放入安全上下文预算，未截断原文");
    // Prefer a sentence/line boundary, without discarding the separator or any text.
    if (offset + length < characters.length) {
      for (let index = length - 1; index >= Math.floor(length / 2); index--) {
        if (/[\r\n。！？!?]/u.test(characters[offset + index])) { length = index + 1; break; }
      }
    }
    pieces.push(characters.slice(offset, offset + length).join(""));
    offset += length;
  }
  return pieces;
}

/** Partition all evidence, retaining original reference numbers even when one very long span needs slices. */
export function splitAssetExtractionCatalog(catalog: AssetSourceCatalog, fits: (batch: AssetSourceCatalog) => boolean): AssetSourceCatalog[] {
  const batches: AssetSourceCatalog[] = [];
  let batch: AssetSourceCatalog = [];
  const appended = (current: AssetSourceCatalog, script: AssetSourceCatalog[number], excerpt: AssetSourceCatalog[number]["excerpts"][number]) => {
    const next = current.map(item => ({ ...item, excerpts: [...item.excerpts] }));
    const tail = next[next.length - 1];
    if (tail?.id === script.id) tail.excerpts.push({ ...excerpt });
    else next.push({ id: script.id, name: script.name, excerpts: [{ ...excerpt }] });
    return next;
  };
  for (const script of catalog) for (const excerpt of script.excerpts) {
    const next = appended(batch, script, excerpt);
    if (fits(next)) { batch = next; continue; }
    if (batch.length) { batches.push(batch); batch = []; }
    const pieces = splitAssetExtractionText(excerpt.quote, quote => fits(appended([], script, { ...excerpt, quote })));
    for (const quote of pieces) {
      const item = appended(batch, script, { ...excerpt, quote });
      if (!fits(item)) { batches.push(batch); batch = appended([], script, { ...excerpt, quote }); }
      else batch = item;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}
