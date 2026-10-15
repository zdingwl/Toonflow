import test from "node:test";
import assert from "node:assert/strict";
import { reviewAssetFactScope, assetFactScopeRules } from "../src/utils/assetFactScope";
import type { AssetSourceCatalog } from "../src/utils/assetExtractionContext";

const asset = { name: "林岚", type: "role" };
const source = (quotes: string[]): AssetSourceCatalog => [{ id: 71, name: "原始剧本", excerpts: quotes.map((quote, index) => ({
  sourceRef: `71:${index + 1}`, quote,
})) }];
const fact = (index: number, text: string) => ({ sourceRef: `71:${index}`, fact: text });
const candidates = (input: any) => input.candidates as { candidateId: number; sourceRef: string; fact: string }[];

test("current subject and stable appearance review excludes companion relationships and transient actions", async () => {
  const catalog = source([
    "林岚带着两位亲戚进入仓库。", "她有灰色齐肩发。", "林岚浑身湿透，走到门口。",
    "林岚随后带来一群帮忙搬货的人。", "叶宁：姐姐，找到便宜渠道了吗？",
  ]);
  const facts = [fact(1, "带来的同行者是亲戚"), fact(2, "灰色齐肩发"), fact(3, "浑身湿透"),
    fact(4, "带来搬货的帮手"), fact(5, "担任采购负责人")];
  let calls = 0;
  const filtered = await reviewAssetFactScope({
    fits: () => true,
    invokeResult: async (schema, system, input, stage) => {
      calls++;
      assert.equal(stage, "资产事实范围复核");
      assert.match(system, /候选尚未核实/);
      assert.match(system, /事实主语/);
      assert.match(system, /不解决互斥设定/);
      assert.match(system, /adjacentContext.*不是候选的引用依据/);
      const hairContext = input.adjacentContext.find((item: any) => item.sourceRef === "71:2");
      assert.deepEqual(hairContext.before, [{ sourceRef: "71:1", quote: catalog[0].excerpts[0].quote }]);
      assert.deepEqual(hairContext.after.map((item: any) => item.sourceRef), ["71:3", "71:4"]);
      assert.equal(input.scripts[0].excerpts[1].quote, "她有灰色齐肩发。");
      return schema.parse({ decisions: candidates(input).map(candidate => ({
        candidateId: candidate.candidateId, retain: candidate.fact === "灰色齐肩发",
      })) });
    },
  }, { asset, facts, catalog });
  assert.equal(calls, 1);
  assert.deepEqual(filtered, [facts[1]]);
});

test("both directly supported same-subject age and species conflicts survive for downstream validation", async () => {
  const catalog = source(["人物定义：林岚二十五岁，是人类。", "人物定义：林岚十六岁，是鲨鱼。"]);
  const facts = [fact(1, "二十五岁"), fact(1, "人类"), fact(2, "十六岁"), fact(2, "鲨鱼")];
  const result = await reviewAssetFactScope({ fits: () => true,
    invokeResult: async (schema, rules, input) => {
      assert.match(rules, /每个受直接支持的候选均 retain=true/);
      return schema.parse({ decisions: candidates(input).map(candidate => ({ candidateId: candidate.candidateId, retain: true })) });
    },
  }, { asset, facts, catalog });
  assert.deepEqual(result, facts);
});

test("decision schema rejects forged IDs, missing or duplicate decisions, coercion and rewritten facts", async () => {
  const facts = [fact(1, "灰色齐肩发"), fact(2, "日常穿灰色外套")];
  const good = [{ candidateId: 1, retain: true }, { candidateId: 2, retain: false }];
  await reviewAssetFactScope({ fits: () => true,
    invokeResult: async (schema, _rules, input) => {
      assert.deepEqual(candidates(input).map(candidate => candidate.candidateId), [1, 2]);
      for (const invalid of [
        { decisions: [good[0]] },
        { decisions: [good[0], good[0]] },
        { decisions: [good[0], { candidateId: 999, retain: false }] },
        { decisions: [...good, { candidateId: 3, retain: false }] },
        { decisions: [good[0], { candidateId: "2", retain: false }] },
        { decisions: [good[0], { candidateId: 2, retain: "false" }] },
        { decisions: [{ ...good[0], fact: "新增职业" }, good[1]] },
        { decisions: good, scriptFacts: facts },
      ]) assert.equal(schema.safeParse(invalid).success, false, JSON.stringify(invalid));
      assert.equal(schema.safeParse({ decisions: [...good].reverse() }).success, true);
      return { decisions: good };
    },
  }, { asset, facts, catalog: source(["林岚有灰色齐肩发。", "林岚日常穿灰色外套。"] ) });
});

test("malformed result reaches the supplied bounded validation retry without adding an outer retry", async () => {
  let invocations = 0, attempts = 0;
  const facts = [fact(1, "二十五岁")];
  const result = await reviewAssetFactScope({ fits: () => true,
    invokeResult: async schema => {
      invocations++;
      const results = [{ decisions: [{ candidateId: 999, retain: true }] }, { decisions: [{ candidateId: 1, retain: true }] }];
      for (const value of results) {
        attempts++;
        const parsed = schema.safeParse(value);
        if (parsed.success) return parsed.data;
      }
      throw new Error("bounded retry exhausted");
    },
  }, { asset, facts, catalog: source(["林岚二十五岁。"] ) });
  assert.equal(invocations, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(result, facts);
});

test("long evidence is reviewed in complete contiguous parts with unchanged nearby subject context", async () => {
  const original = "林岚的基础定义：" + "无可用外形信息。🙂  ".repeat(120) + "末尾原文：灰色齐肩发。";
  const catalog = source(["林岚站在门边。", original, "她的日常衣装与此相同。"]);
  const snapshot = structuredClone(catalog);
  const facts = [fact(2, "灰色齐肩发")];
  const seen: { quote: string; index: number; total: number }[] = [];
  const fits = (_schema: any, _rules: string, input: any) => JSON.stringify(input).length <= 700;
  const result = await reviewAssetFactScope({ fits,
    invokeResult: async (schema, rules, input) => {
      assert.ok(fits(schema, rules, input));
      assert.deepEqual(input.adjacentContext, [{ sourceRef: "71:2",
        before: [{ sourceRef: "71:1", quote: "林岚站在门边。" }],
        after: [{ sourceRef: "71:3", quote: "她的日常衣装与此相同。" }],
      }]);
      for (const script of input.scripts) for (const excerpt of script.excerpts)
        seen.push({ quote: excerpt.quote, index: excerpt.partIndex, total: excerpt.partCount });
      return schema.parse({ decisions: candidates(input).map(candidate => ({ candidateId: candidate.candidateId,
        retain: input.scripts.some((script: any) => script.excerpts.some((excerpt: any) => excerpt.quote.includes("灰色齐肩发"))),
      })) });
    },
  }, { asset, facts, catalog });
  assert.ok(seen.length > 2);
  assert.equal(seen.map(part => part.quote).join(""), original);
  assert.deepEqual(seen.map(part => part.index), seen.map((_part, index) => index + 1));
  assert.ok(seen.every(part => part.total === seen.length));
  assert.deepEqual(result, facts);
  assert.deepEqual(catalog, snapshot);
});

test("an early retained part does not skip later pieces of the complete original", async () => {
  const original = "林岚二十五岁。" + "原文仍须完整复核，不能跳过。".repeat(100);
  let calls = 0;
  const seen: string[] = [];
  const facts = [fact(1, "二十五岁")];
  const result = await reviewAssetFactScope({
    fits: (_schema, _rules, input) => JSON.stringify(input).length <= 550,
    invokeResult: async (schema, _rules, input) => {
      calls++;
      seen.push(...input.scripts.flatMap((script: any) => script.excerpts.map((excerpt: any) => excerpt.quote)));
      return schema.parse({ decisions: [{ candidateId: 1, retain: calls === 1 }] });
    },
  }, { asset, facts, catalog: source([original]) });
  assert.ok(calls > 2);
  assert.equal(seen.join(""), original);
  assert.deepEqual(result, facts);
});

test("retained pairs and server-owned extra metadata stay immutable and in their original order", async () => {
  const facts = [ { ...fact(1, "灰色齐肩发"), quote: "原文  保留双空格。", scriptId: 71 },
    { ...fact(2, "灰色外套"), quote: "另一个原句。", scriptId: 71 } ];
  const snapshot = structuredClone(facts);
  const result = await reviewAssetFactScope({ fits: () => true,
    invokeResult: async schema => schema.parse({ decisions: [{ candidateId: 2, retain: true }, { candidateId: 1, retain: true }] }),
  }, { asset, facts, catalog: source(["林岚有灰色齐肩发。", "林岚日常穿灰色外套。"] ) });
  assert.deepEqual(result, snapshot);
  assert.deepEqual(facts, snapshot);
  assert.notEqual(result[0], facts[0]);
  result[0].fact = "改变返回值";
  assert.deepEqual(facts, snapshot);
});

test("empty candidates cause no model or budget calls and invalid references fail before invocation", async () => {
  let calls = 0;
  const deps = { fits: () => { calls++; return true; }, invokeResult: async () => { calls++; return {}; } };
  assert.deepEqual(await reviewAssetFactScope(deps, { asset, facts: [], catalog: [] }), []);
  assert.equal(calls, 0);
  await assert.rejects(reviewAssetFactScope(deps, { asset, facts: [fact(99, "没有依据")], catalog: source(["林岚走过。"] ) }), /依据编号无效/);
  assert.equal(calls, 0);
});

test("fixed candidates and adjacent originals exceeding the budget fail without truncation or model calls", async () => {
  let calls = 0;
  const catalog = source(["相邻原文".repeat(500), "林岚二十五岁。"]);
  const snapshot = structuredClone(catalog);
  await assert.rejects(reviewAssetFactScope({
    fits: (_schema, _rules, input) => JSON.stringify(input).length < 700,
    invokeResult: async () => { calls++; return {}; },
  }, { asset, facts: [fact(2, "二十五岁")], catalog }), /无法安全分批|未截断原文/);
  assert.equal(calls, 0);
  assert.deepEqual(catalog, snapshot);
});

test("scope rules use asset identity rather than character-specific names or relationship keyword filtering", () => {
  assert.match(assetFactScopeRules, /asset\.name/);
  assert.doesNotMatch(assetFactScopeRules, /维拉|麦迪逊|艾娃|林岚/);
});
