import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { getCharacterCard, migrateCharacterCards } from "../src/utils/characterCards";
import { ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, estimateAssetExtractionRequestTokens } from "../src/utils/assetExtractionContext";

const currentVisual = {
  face: "流畅鹅蛋脸、清晰杏眼与自然眉线。", body: "自然比例，不推断年龄或成人曲线。",
  hair: "墨黑色长发，颅顶自然蓬松。", clothing: "象牙白翻领衬衫、灰色长裤与黑色平底鞋，剪裁整洁、材质清楚。",
  environment: "", shape: "",
};
const normalQuote = "  艾娃是女性，二十五岁，黑色长发，日常穿白色衬衫。";
type Stage = "discovery" | "facts" | "scope" | "match" | "final";
type Call = { stage: Stage; input: any; schema: any; request: any; estimated: number };
type FixtureOptions = {
  content?: string; mode?: "reference" | "new" | "reuse"; malformedMatch?: "once" | "always";
  forgedFact?: boolean; conflicts?: boolean | string; secondInvalidCard?: boolean;
  extraFacts?: { sourceRef: string; fact: string }[]; rejectedFacts?: string[];
};

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_project", table => { table.integer("id"); table.integer("userId"); table.text("artStyle"); });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content"); table.text("errorReason"); table.integer("extractState");
  });
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); table.primary(["scriptId", "assetId"]); });
  await migrateAssetDescriptions(db);
  await migrateCharacterCards(db);
  await db("o_project").insert({ id: 1, userId: 1, artStyle: "realistic_3d_anime" });
  const content = options.content || (options.secondInvalidCard ? normalQuote + "诺拉是女性，黑色短发，日常穿灰色长裤。" : normalQuote);
  await db("o_script").insert({ id: 701, projectId: 1, name: "第一集", content, extractState: 0, errorReason: "旧失败" });
  await db("o_assets").insert({ id: 10, projectId: 1, name: "艾娃", type: "role", imageId: 40,
    describe: "旧描述永久保留于历史", prompt: "旧图片提示词", promptState: "已完成",
    descriptionMeta: JSON.stringify({ source: "ai", userConstraints: "保留白衬衫与黑色长发", visualDesign: { ...currentVisual, face: "原有自然鹅蛋脸。" } }) });
  await db("o_scriptAssets").insert({ scriptId: 701, assetId: 10 });
  const before = await db("o_assets").where({ id: 10 }).first();
  const initialCards = await db("o_characterCard");
  const calls: Call[] = [];
  let matchCount = 0;
  let reuseVisual: any;
  const invoke = async (request: any) => {
    const input = JSON.parse(request.messages[0].content), schema = await request.tools.resultTool.inputSchema.jsonSchema;
    const properties = schema.properties;
    const stage: Stage = properties.newAssets ? "discovery" : properties.decisions ? "scope" : properties.mode ? "match" : properties.describe ? "final" : "facts";
    calls.push({ stage, input, schema, request, estimated: estimateAssetExtractionRequestTokens(request.system, input, schema) });
    let value: any;
    if (stage === "discovery") {
      const ids = [...new Set<number>(input.scripts.map((script: any) => script.id))];
      value = { newAssets: options.secondInvalidCard ? [{ name: "诺拉", desc: "女性，黑色短发", type: "role", scriptIds: ids }] : [],
        existingAssetRefs: [{ assetId: 10, scriptIds: ids }] };
    } else if (stage === "facts") {
      const scriptFacts: { sourceRef: string; fact: string }[] = [];
      for (const script of input.scripts) for (const excerpt of script.excerpts) {
        const quote = excerpt.quote;
        if (input.asset.name === "诺拉") {
          if (quote.includes("诺拉")) scriptFacts.push({ sourceRef: excerpt.sourceRef, fact: "女性" }, { sourceRef: excerpt.sourceRef, fact: "黑色短发" });
        } else {
          if (quote.includes("女性")) scriptFacts.push({ sourceRef: excerpt.sourceRef, fact: "女性" });
          if (quote.includes("二十五岁")) scriptFacts.push({ sourceRef: excerpt.sourceRef, fact: "二十五岁" });
          if (quote.includes("黑色长发")) scriptFacts.push({ sourceRef: excerpt.sourceRef, fact: "黑色长发" });
          if (quote.includes("白色衬衫")) scriptFacts.push({ sourceRef: excerpt.sourceRef, fact: "日常穿白色衬衫" });
        }
      }
      value = { scriptFacts: [...scriptFacts, ...(options.extraFacts || [])] };
    } else if (stage === "scope") {
      value = { decisions: input.candidates.map((candidate: any) => ({ candidateId: candidate.candidateId,
        retain: !(options.rejectedFacts || []).includes(candidate.fact) })) };
    } else if (stage === "match") {
      matchCount++;
      const malformed = options.malformedMatch === "always" || (options.malformedMatch === "once" && matchCount === 1);
      const chosen = input.candidates[0];
      const mode = options.mode || "reference";
      if (mode === "reuse" && !malformed) reuseVisual = (await getCharacterCard(db, chosen.id, 1, chosen.version))!.visualDesign;
      value = { mode, references: mode === "new" ? [] : [{ cardId: malformed ? 999999 : chosen.id,
        version: malformed ? chosen.version + 10 : chosen.version, borrowedFields: ["face", "hair"] }] };
    } else {
      const invalid = options.secondInvalidCard && input.asset.name === "诺拉";
      value = { describe: "清晰杏眼、墨黑长发，白色翻领衬衫搭配灰色长裤与黑色平底鞋，保持自然比例。",
        visualDesign: { ...(reuseVisual || currentVisual), ...(invalid ? { clothing: "" } : {}) },
        scriptFacts: options.forgedFact ? [{ sourceRef: input.verifiedFacts[0].sourceRef, fact: "原文没有的医疗主任身份" }] : input.verifiedFacts,
        conflicts: options.conflicts ? [typeof options.conflicts === "string" ? options.conflicts : "原文明示衣装设定互相冲突"] : [], characterDefinition: "女性，黑色长发，现代日常衣装" };
    }
    try {
      await request.tools.resultTool.execute(value, {});
      return { finishReason: "tool-calls" };
    } catch (cause) {
      return { finishReason: "tool-calls", content: [{ type: "tool-error", error: cause }] };
    }
  };
  const run = () => extractScriptAssets({ db, invoke, system: "保持项目画风与当前人物明确设定。", discoverySystem: "按剧本识别独立资产。",
    characterCards: { artStyle: "realistic_3d_anime", ownerId: 1 } },
  { projectId: 1, scriptIds: [701], updateExistingDescriptions: true, groupSize: 5 });
  return { db, run, before, initialCards, calls, content };
}

test("partial references generate and bind an independent card; current facts and old images stay in the project", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.updated, 1);
  assert.deepEqual(f.calls.map(call => call.stage), ["discovery", "facts", "scope", "match", "final"]);
  const saved = await f.db("o_assets").where({ id: 10 }).first();
  const meta = JSON.parse(saved.descriptionMeta);
  const libraryCard = await getCharacterCard(f.db, meta.characterCard.cardId, 1, meta.characterCard.version);
  assert.ok(libraryCard && libraryCard.ownerId === 1 && libraryCard.id > 10);
  assert.equal(meta.characterCard.mode, "reference");
  assert.equal(meta.characterCard.ageMin, 25);
  assert.deepEqual(libraryCard.provenance.references, meta.characterCard.references);
  assert.ok(libraryCard.provenance.references.length > 0);
  assert.equal(libraryCard.provenance.method, "generated");
  assert.equal(libraryCard.sourceAssetId, 10);
  assert.equal(libraryCard.sourceProjectId, 1);
  assert.ok(!JSON.stringify(libraryCard).includes(normalQuote));
  assert.ok(!JSON.stringify(libraryCard).includes("scriptFacts"));
  assert.equal(meta.scriptFacts[0].quote, normalQuote);
  assert.ok(meta.scriptFacts.every((fact: any) => fact.sourceRef === "701:1" && fact.scriptId === 701 && fact.quote === normalQuote));
  assert.equal(saved.imageId, 40);
  assert.equal(saved.prompt, "旧图片提示词");
  assert.equal((await f.db("o_assetDescriptionHistory").where({ assetId: 10 }).first()).describe, f.before.describe);
  const final = f.calls.find(call => call.stage === "final")!;
  assert.deepEqual(final.input.scripts, []);
  assert.deepEqual(final.input.verifiedFacts, meta.scriptFacts.map((fact: any) => ({ sourceRef: fact.sourceRef, fact: fact.fact })));
  assert.deepEqual(Object.keys(final.input.referenceCards[0].visualDesign).sort(), ["face", "hair"]);
  assert.ok(!("name" in final.input.referenceCards[0]) && !("quote" in final.input.referenceCards[0]));
});

test("complete matching preserves the library version while the project keeps its own exact age and facts", async t => {
  const f = await fixture(t, { mode: "reuse" });
  await f.run();
  const saved = await f.db("o_assets").where({ id: 10 }).first();
  const meta = JSON.parse(saved.descriptionMeta);
  const match = f.calls.find(call => call.stage === "match")!;
  assert.equal(meta.characterCard.mode, "reuse");
  assert.equal(meta.characterCard.cardId, match.input.candidates[0].id);
  assert.equal(meta.characterCard.version, match.input.candidates[0].version);
  assert.equal(meta.characterCard.ageMin, 25);
  assert.equal(meta.characterCard.ageMax, 25);
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length);
  assert.deepEqual(meta.visualDesign, (await getCharacterCard(f.db, meta.characterCard.cardId, 1, meta.characterCard.version))!.visualDesign);
  assert.ok(meta.scriptFacts.every((fact: any) => fact.quote === normalQuote));
  assert.equal(saved.imageId, 40);
});

test("no compatible card generates a new unknown-age card without pretending the person is an adult", async t => {
  const quote = "艾娃是女性，黑色长发，日常穿白色衬衫。";
  const f = await fixture(t, { content: quote });
  await f.db("o_characterCard").where({ ageBand: "unknown" }).update({ status: "archived" });
  await f.run();
  assert.ok(!f.calls.some(call => call.stage === "match"));
  const meta = JSON.parse((await f.db("o_assets").where({ id: 10 }).first()).descriptionMeta);
  const saved = await getCharacterCard(f.db, meta.characterCard.cardId, 1);
  assert.ok(saved);
  assert.equal(meta.characterCard.mode, "new");
  assert.equal(saved.ageBand, "unknown");
  assert.equal(saved.ageMin, null);
  assert.equal(saved.ageMax, null);
  assert.deepEqual(saved.provenance.references, []);
  assert.equal(saved.visualDesign.body, currentVisual.body);
  assert.ok(!saved.describe.includes("二十五岁"));
});

test("malformed candidate id/version retries once, then uses only a real candidate", async t => {
  const f = await fixture(t, { malformedMatch: "once" });
  await f.run();
  assert.equal(f.calls.filter(call => call.stage === "match").length, 2);
  const meta = JSON.parse((await f.db("o_assets").where({ id: 10 }).first()).descriptionMeta);
  assert.ok(meta.characterCard.references.every((reference: any) => reference.cardId < 999999 && reference.version === 1));
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length + 1);
});

test("persistently forged candidate references stop after two attempts without saving assets or cards", async t => {
  const f = await fixture(t, { malformedMatch: "always" });
  await assert.rejects(f.run(), /只能选择当前候选角色卡|有效的资产结果/);
  assert.equal(f.calls.filter(call => call.stage === "match").length, 2);
  assert.equal(f.calls.filter(call => call.stage === "final").length, 0);
  assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), f.before);
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length);
  assert.equal((await f.db("o_assetDescriptionHistory")).length, 0);
});

test("real unresolved conflicts keep assets, associations and the card library intact", async t => {
  const f = await fixture(t, { conflicts: true });
  await assert.rejects(f.run(), /原文明示衣装设定互相冲突/);
  assert.equal(f.calls.filter(call => call.stage === "final").length, 2);
  assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), f.before);
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length);
  assert.equal((await f.db("o_characterCardVersion")).length, f.initialCards.length);
  assert.deepEqual(await f.db("o_scriptAssets"), [{ scriptId: 701, assetId: 10 }]);
  assert.equal((await f.db("o_script").where({ id: 701 }).first()).extractState, 0);
});

test("different companion groups and their ages never reach this role's final card or persisted facts", async t => {
  const quotes = [normalQuote, "艾娃带着两位亲戚来到仓库，亲戚是八岁男孩。", "艾娃让几位帮手搬运货箱。", "艾娃随后带着一群混混走进院子。", "艾娃转身跑向门口。"];
  const unrelatedFacts = ["带来的亲戚是八岁男孩", "帮手负责搬运货箱", "带着一群混混", "转身跑向门口"];
  const f = await fixture(t, { content: quotes.join("\n"), rejectedFacts: unrelatedFacts,
    extraFacts: unrelatedFacts.map((fact, index) => ({ sourceRef: `701:${index + 2}`, fact })) });
  await f.run();
  const audit = f.calls.find(call => call.stage === "scope")!;
  assert.ok(audit.input.candidates.some((candidate: any) => candidate.fact === "带来的亲戚是八岁男孩"), "the fixture must exercise contamination from another subject");
  const auditedQuotes = audit.input.scripts.flatMap((script: any) => script.excerpts.map((excerpt: any) => excerpt.quote));
  for (const quote of quotes) assert.ok(auditedQuotes.includes(quote), "scope audit sees original source quotes, including neighboring references to other people");
  const final = f.calls.find(call => call.stage === "final")!;
  const meta = JSON.parse((await f.db("o_assets").where({ id: 10 }).first()).descriptionMeta);
  assert.equal(meta.characterCard.ageMin, 25, "a companion's age cannot conflict with or change the current role's age");
  assert.equal(meta.characterCard.gender, "female");
  for (const fact of unrelatedFacts) {
    assert.ok(!final.input.verifiedFacts.some((candidate: any) => candidate.fact === fact));
    assert.ok(!meta.scriptFacts.some((candidate: any) => candidate.fact === fact), "collected but rejected facts must not be appended again during persistence");
  }
  assert.deepEqual(meta.scriptFacts.map((candidate: any) => candidate.fact).sort(), ["女性", "二十五岁", "黑色长发", "日常穿白色衬衫"].sort());
  assert.ok(meta.scriptFacts.every((candidate: any) => candidate.quote === normalQuote && candidate.sourceRef === "701:1"));
  assert.equal((await f.db("o_assets").where({ id: 10 }).first()).imageId, 40);
  assert.equal((await f.db("o_script").where({ id: 701 }).first()).content, quotes.join("\n"));
});

test("scope review retains mutually exclusive ages of the same role and prevents all asset/card writes", async t => {
  const f = await fixture(t, { content: normalQuote + "\n同一时间的原文明确艾娃只有八岁。", extraFacts: [{ sourceRef: "701:2", fact: "八岁" }] });
  await assert.rejects(f.run(), /年龄.*冲突/);
  const audit = f.calls.find(call => call.stage === "scope")!;
  assert.ok(audit.input.candidates.some((candidate: any) => candidate.fact === "二十五岁"));
  assert.ok(audit.input.candidates.some((candidate: any) => candidate.fact === "八岁"));
  assert.equal(f.calls.filter(call => call.stage === "final").length, 0, "fact review must not hide an actual age contradiction to obtain a valid card");
  assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), f.before);
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length);
  assert.equal((await f.db("o_assetDescriptionHistory")).length, 0);
  assert.deepEqual(await f.db("o_scriptAssets"), [{ scriptId: 701, assetId: 10 }]);
});

test("scope review does not erase conflicting species attributed to the same active role", async t => {
  const f = await fixture(t, { content: normalQuote + "\n艾娃的当前基础物种为人类。\n同一基础状态中艾娃的物种为鲨鱼。",
    extraFacts: [{ sourceRef: "701:2", fact: "物种为人类" }, { sourceRef: "701:3", fact: "物种为鲨鱼" }], conflicts: "同一基础状态下角色自身的物种互相冲突" });
  await assert.rejects(f.run(), /物种互相冲突/);
  for (const final of f.calls.filter(call => call.stage === "final")) {
    assert.ok(final.input.verifiedFacts.some((candidate: any) => candidate.fact === "物种为人类"));
    assert.ok(final.input.verifiedFacts.some((candidate: any) => candidate.fact === "物种为鲨鱼"));
  }
  assert.equal(f.calls.filter(call => call.stage === "final").length, 2, "bounded correction still rejects a genuine mutually exclusive identity");
  assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), f.before);
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length);
  assert.equal((await f.db("o_assetDescriptionHistory")).length, 0);
});

test("final card cannot introduce a forged verified fact and retries remain bounded", async t => {
  const f = await fixture(t, { forgedFact: true });
  await assert.rejects(f.run(), /verifiedFacts|有效的资产结果/);
  assert.equal(f.calls.filter(call => call.stage === "final").length, 2);
  assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), f.before);
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length);
  assert.equal((await f.db("o_assetDescriptionHistory")).length, 0);
});

test("a later invalid card rolls back earlier card inserts, asset versions and association changes in the real transaction", async t => {
  const f = await fixture(t, { secondInvalidCard: true });
  await assert.rejects(f.run(), /完整的面部、体态、发型和衣装设计/);
  assert.ok(f.calls.filter(call => call.stage === "final").length >= 2);
  assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), f.before);
  assert.equal((await f.db("o_assets")).length, 1, "new second identity was rolled back");
  assert.equal((await f.db("o_characterCard")).length, f.initialCards.length, "first inserted card was rolled back");
  assert.equal((await f.db("o_characterCardVersion")).length, f.initialCards.length);
  assert.equal((await f.db("o_assetDescriptionHistory")).length, 0);
  assert.deepEqual(await f.db("o_scriptAssets"), [{ scriptId: 701, assetId: 10 }]);
});

test("one long original quote is reviewed in contiguous fact batches and stays complete in server-owned source metadata", async t => {
  const quote = "  艾娃是女性，二十五岁，黑色长发，日常穿白色衬衫，" + "雾".repeat(30000) + "。";
  const f = await fixture(t, { content: quote });
  await f.run();
  const factCalls = f.calls.filter(call => call.stage === "facts");
  assert.ok(factCalls.length > 1);
  assert.equal(factCalls.flatMap(call => call.input.scripts.flatMap((script: any) => script.excerpts.map((excerpt: any) => excerpt.quote))).join(""), quote);
  assert.ok(factCalls.every(call => call.input.scripts.every((script: any) => script.excerpts.every((excerpt: any) => excerpt.sourceRef === "701:1"))));
  const final = f.calls.find(call => call.stage === "final")!;
  assert.deepEqual(final.input.scripts, []);
  assert.ok(final.input.verifiedFacts.length > 0 && !JSON.stringify(final.input).includes("雾".repeat(1000)));
  assert.ok(f.calls.every(call => call.estimated <= ASSET_EXTRACTION_INPUT_TOKEN_BUDGET), "every actual discovery, facts, match and final request fits its budget");
  const saved = await f.db("o_assets").where({ id: 10 }).first();
  const meta = JSON.parse(saved.descriptionMeta);
  assert.ok(meta.scriptFacts.every((fact: any) => fact.quote === quote));
  assert.equal((await f.db("o_script").where({ id: 701 }).first()).content, quote);
  assert.equal(saved.imageId, 40);
});
