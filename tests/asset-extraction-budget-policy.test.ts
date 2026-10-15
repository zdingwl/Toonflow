import test from "node:test";
import assert from "node:assert/strict";
import { assertAssetExtractionRequestBudget, ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, estimateAssetExtractionRequestTokens,
  planAssetDesignInput, resolveAssetExtractionBudgetPolicy } from "../src/utils/assetExtractionContext";

test("unknown effective model limits retain the conservative fallback without guessing provider capacity", () => {
  assert.deepEqual(resolveAssetExtractionBudgetPolicy(), { inputTokenBudget: 14000, retryTokenReserve: 1000, maxOutputTokens: 6144 });
  assert.deepEqual(resolveAssetExtractionBudgetPolicy({}), resolveAssetExtractionBudgetPolicy());
  assert.deepEqual(resolveAssetExtractionBudgetPolicy({ contextWindowTokens: Number.NaN, maxInputTokens: -1, maxOutputTokens: Infinity }),
    resolveAssetExtractionBudgetPolicy());
});

test("known context subtracts output and headroom and respects configured input and override caps", () => {
  assert.deepEqual(resolveAssetExtractionBudgetPolicy({ contextWindowTokens: 32768 }),
    { inputTokenBudget: 25624, retryTokenReserve: 1000, maxOutputTokens: 6144 });
  assert.deepEqual(resolveAssetExtractionBudgetPolicy({ contextWindowTokens: 32768, maxInputTokens: 16000, maxOutputTokens: 4096 }),
    { inputTokenBudget: 16000, retryTokenReserve: 1000, maxOutputTokens: 4096 });
  assert.equal(resolveAssetExtractionBudgetPolicy({ contextWindowTokens: 32768, maxInputTokens: 16000 }, 50000).inputTokenBudget, 16000);
  assert.equal(resolveAssetExtractionBudgetPolicy({ contextWindowTokens: 32768 }, 50000).inputTokenBudget, 25624);
  assert.equal(resolveAssetExtractionBudgetPolicy({ maxInputTokens: 25000 }, 50000).inputTokenBudget, 25000);
  assert.equal(resolveAssetExtractionBudgetPolicy({}, 12000).inputTokenBudget, 12000);
});

test("very small and explicit zero limits remain nonnegative and large limits stay safe integers", () => {
  for (const contextWindowTokens of [0, 512, 1000, 6144]) {
    const policy = resolveAssetExtractionBudgetPolicy({ contextWindowTokens });
    assert.equal(policy.inputTokenBudget, 0);
    assert.equal(policy.retryTokenReserve, 0);
    assert.ok(policy.maxOutputTokens <= contextWindowTokens);
  }
  assert.equal(resolveAssetExtractionBudgetPolicy({ maxInputTokens: 0 }).inputTokenBudget, 0);
  assert.equal(resolveAssetExtractionBudgetPolicy({}, 0).inputTokenBudget, 0);
  assert.equal(resolveAssetExtractionBudgetPolicy({ maxInputTokens: 4096.9 }).inputTokenBudget, 4096);
  for (const value of Object.values(resolveAssetExtractionBudgetPolicy({ contextWindowTokens: Number.MAX_VALUE, maxOutputTokens: 1 })))
    assert.ok(Number.isSafeInteger(value) && value >= 0);
});

const required = {
  userConstraints: "完整保留用户关于年龄、风格、脸型、衣装的要求。",
  previousDesign: { face: "原有脸型", hair: "黑色长发", clothing: "白色衬衫" },
  legacyDescription: "原有资产描述及既定身份。",
  scripts: [{ id: 1, excerpts: [{ sourceRef: "1:1", quote: "  艾娃二十五岁，黑色长发，日常穿白色衬衫。\n" }] }],
  evidenceFacts: [{ sourceRef: "1:1", fact: "二十五岁" }, { sourceRef: "1:1", fact: "黑色长发" }],
};
const schema = { type: "object", properties: { describe: { type: "string" } } };
const system = "角色卡只取原文直接事实，年龄未知不默认成年。";

test("final design planning removes optional peers before references while preserving required content", () => {
  const input = { ...required, siblingDesigns: Array.from({ length: 4 }, (_, id) => ({ id, face: "其他人物脸型".repeat(200) })),
    cardCandidates: [{ id: 10, version: 2, face: "合适的脸型" }, { id: 11, version: 2, face: "次选脸型" }] };
  const withoutPeers = { ...input, siblingDesigns: [] };
  const threshold = estimateAssetExtractionRequestTokens(system, withoutPeers, schema);
  const policy = { inputTokenBudget: threshold + 1000, retryTokenReserve: 1000, maxOutputTokens: 6144 };
  const planned = planAssetDesignInput(schema, system, input, policy);
  assert.deepEqual(planned, withoutPeers);
  assert.ok(estimateAssetExtractionRequestTokens(system, planned, schema) <= policy.inputTokenBudget - policy.retryTokenReserve);
  assert.equal(input.siblingDesigns.length, 4, "planning never mutates the original request or candidate lists");
  for (const key of Object.keys(required)) assert.deepEqual(planned[key as keyof typeof planned], input[key as keyof typeof input]);
});

test("when references also overflow, higher ranked candidates are retained and none are partially truncated", () => {
  const cards = [{ id: 10, face: "第一候选完整外形" }, { id: 11, face: "第二候选完整外形".repeat(100) }];
  const input = { ...required, referenceCards: cards };
  const threshold = estimateAssetExtractionRequestTokens(system, { ...input, referenceCards: [cards[0]] }, schema);
  const planned = planAssetDesignInput(schema, system, input, { inputTokenBudget: threshold + 1000, retryTokenReserve: 1000, maxOutputTokens: 6144 });
  assert.deepEqual(planned.referenceCards, [cards[0]]);
  assert.deepEqual(input.referenceCards, cards);
});

test("required facts never disappear when the entire request still exceeds the budget", () => {
  const input = { ...required, scripts: [{ id: 1, excerpts: [{ sourceRef: "1:1", quote: "原文".repeat(20000) }] }],
    siblingDesigns: [{ face: "其他角色" }], candidateCards: [{ face: "候选角色" }] };
  const policy = resolveAssetExtractionBudgetPolicy();
  const planned = planAssetDesignInput(schema, system, input, policy);
  assert.deepEqual(planned.scripts, input.scripts); assert.deepEqual(planned.evidenceFacts, input.evidenceFacts);
  assert.equal(planned.userConstraints, input.userConstraints); assert.deepEqual(planned.previousDesign, input.previousDesign);
  assert.deepEqual(planned.siblingDesigns, []); assert.deepEqual(planned.candidateCards, []);
  assert.throws(() => assertAssetExtractionRequestBudget(system, planned, schema, "角色卡", policy), /未截断原文或事实/);
});

test("existing estimator and default assertion behavior remain unchanged; explicit policies can admit larger requests", () => {
  const input = { content: "事实".repeat(6000) }, estimated = estimateAssetExtractionRequestTokens("", input, {});
  assert.ok(estimated > ASSET_EXTRACTION_INPUT_TOKEN_BUDGET);
  assert.throws(() => assertAssetExtractionRequestBudget("", input, {}, "资产最终设计"), /预算 14000/);
  assert.equal(assertAssetExtractionRequestBudget("", input, {}, "角色卡", resolveAssetExtractionBudgetPolicy({ contextWindowTokens: 64000 })), estimated);
});
