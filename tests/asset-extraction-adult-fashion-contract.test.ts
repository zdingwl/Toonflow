import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, estimateAssetExtractionRequestTokens } from "../src/utils/assetExtractionContext";

const userConstraints = "用户明确确认：艾娃已满18岁。本次要求时髦且轻性感的完整服装设计，自主比较不同方案再选一套；服装例子仅启发，要求材质对比与精致高跟鞋，保留脸和黑色长发。";
const firstQuote = "  艾娃是女性，黑色长发。";
const lastQuote = "艾娃眼睛为黑色。";
const visualDesign = { face: "鹅蛋脸、黑色眼睛", body: "自然成人比例", hair: "黑色长发",
  clothing: "灰银色单肩柔缎上衣，黑色高腰收腰短裙、适度开衩，尖头精致高跟鞋", environment: "", shape: "" };

async function fixture(t: TestContext, longSource: boolean) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const name of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(name);
  });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content"); table.integer("extractState"); table.text("errorReason");
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); table.primary(["scriptId", "assetId"]); });
  await db.schema.createTable("o_image", table => { table.integer("id"); table.integer("assetsId"); table.text("filePath"); });
  await migrateAssetDescriptions(db);
  const middle = longSource ? Array.from({ length: 500 }, (_, index) => `固定环境第${index + 1}段：走廊墙面仍保持浅色，窗边海风经过房间，远处持续有普通浪声，地面维持原有结构。`) : [];
  const quotes = [firstQuote, ...middle, lastQuote];
  await db("o_script").insert({ id: 501, projectId: 1, name: "本集", content: quotes.join("\r\n"), extractState: 0 });
  await db("o_assets").insert({ id: 10, projectId: 1, type: "role", name: "艾娃", describe: "黑色长发，旧保守长袖长裙。",
    prompt: "旧图已完成提示词", promptState: "已完成", imageId: 99,
    descriptionMeta: JSON.stringify({ source: "user", userConstraints, visualDesign: { ...visualDesign, clothing: "旧保守长袖长裙" } }) });
  await db("o_image").insert({ id: 99, assetsId: 10, filePath: "paid-original.jpg" });
  await db("o_scriptAssets").insert({ scriptId: 501, assetId: 10 });
  const snapshot = async () => ({ assets: await db("o_assets").orderBy("id"), images: await db("o_image").orderBy("id"),
    histories: await db("o_assetDescriptionHistory").orderBy("id"), links: await db("o_scriptAssets").orderBy(["scriptId", "assetId"]), scripts: await db("o_script").orderBy("id") });
  return { db, quotes, snapshot };
}

async function submit(request: any, value: any) {
  await request.tools.resultTool.execute(value, {});
  return { finishReason: "tool-calls" };
}

for (const longSource of [false, true]) {
  test(`user-confirmed adult fashion remains user metadata and never becomes script age evidence (${longSource ? "batched collection" : "short source"})`, async t => {
    const { db, quotes, snapshot } = await fixture(t, longSource);
    const before = await snapshot();
    const reviewed = new Map<string, string>(); let collections = 0, finals = 0;
    const expectedRefs = ["501:1", `501:${quotes.length}`];
    const invoke = async (request: any) => {
      assert.deepEqual(await snapshot(), before, "design/collection must finish before transactional writes");
      assert.deepEqual(request.toolChoice, { type: "tool", toolName: "resultTool" });
      const input = JSON.parse(request.messages[0].content);
      const schema = await request.tools.resultTool.inputSchema.jsonSchema;
      assert.ok(estimateAssetExtractionRequestTokens(request.system, input, schema) <= ASSET_EXTRACTION_INPUT_TOKEN_BUDGET);
      if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [501] }] });
      const facts = input.scripts.flatMap((script: any) => script.excerpts
        .filter((excerpt: any) => expectedRefs.includes(excerpt.sourceRef))
        .map((excerpt: any) => ({ sourceRef: excerpt.sourceRef, fact: excerpt.quote.trim() })));
      if (!schema.properties.describe) {
        collections++;
        assert.deepEqual(Object.keys(input).sort(), ["asset", "scripts"]);
        assert.doesNotMatch(JSON.stringify(input), /用户明确确认|已满18岁|轻性感|收腰短裙/);
        assert.doesNotMatch(request.system, /露肩|适度开领|收腰|适度开衩/);
        assert.match(request.system, /只收原文明示的年龄/);
        for (const script of input.scripts) for (const excerpt of script.excerpts) reviewed.set(excerpt.sourceRef, excerpt.quote);
        return submit(request, { scriptFacts: facts });
      }
      finals++;
      assert.equal(input.userConstraints, userConstraints, "the explicit adult/fashion authorization reaches final design intact");
      assert.match(request.system, /原文明示成年或 userConstraints 中用户明确确认本角色已满18岁/);
      assert.match(request.system, /任一即可.*不要求两者同时具备/);
      assert.match(request.system, /用户确认不能写成 scriptFacts 的原文年龄/);
      assert.match(request.system, /已确认成年且用户明确要求轻性感时装/);
      assert.match(request.system, /内部比较若干不同方案.*轮廓记忆点、材质对比和精致鞋型/);
      assert.match(request.system, /完整时髦衣装.*上下装或整裙、鞋、配色与材质/);
      assert.match(request.system, /示例仅启发，不是固定清单/);
      assert.match(request.system, /成人JK、洛丽塔仅是服装名称，不改为学生身份或幼态/);
      assert.match(request.system, /不自动改回保守版/);
      assert.match(request.system, /原文和用户都未确认成年时.*不使用成人胸腰臀曲线、性感或裸露设计/);
      assert.match(request.system, /原文明示未成年.*真实 conflicts 待确认/);
      assert.doesNotMatch(JSON.stringify(input.scripts), /用户明确确认|18岁|成人|轻性感/);
      if (longSource) {
        assert.ok(collections > 1);
        assert.equal(reviewed.size, quotes.length, "all original excerpts survive collection and budget splitting");
        for (const [index, quote] of quotes.entries()) assert.equal(reviewed.get(`501:${index + 1}`), quote);
        assert.deepEqual(input.evidenceFacts.map((fact: any) => fact.sourceRef), expectedRefs);
      }
      return submit(request, { describe: "成年女性，鹅蛋脸、黑色眼睛、黑色长发，灰银色单肩柔缎上衣与黑色高腰收腰短裙、适度开衩，尖头精致高跟鞋。",
        visualDesign, scriptFacts: facts, conflicts: [] });
    };
    assert.deepEqual(await extractScriptAssets({ db, invoke, system: "保留本角色用户明确要求与真实剧本来源。" },
      { projectId: 1, scriptIds: [501], updateExistingDescriptions: true }), { created: 0, updated: 1, reused: 0 });
    assert.equal(finals, 1);
    if (!longSource) assert.equal(collections, 0);
    const asset = await db("o_assets").where({ id: 10 }).first(), meta = JSON.parse(asset.descriptionMeta);
    assert.equal(meta.userConstraints, userConstraints);
    assert.equal(meta.visualDesign.clothing, visualDesign.clothing);
    assert.deepEqual(meta.scriptFacts, [
      { sourceRef: expectedRefs[0], scriptId: 501, quote: firstQuote, fact: firstQuote.trim() },
      { sourceRef: expectedRefs[1], scriptId: 501, quote: lastQuote, fact: lastQuote.trim() },
    ]);
    assert.doesNotMatch(JSON.stringify(meta.scriptFacts), /18岁|成年|单肩|短裙|性感/);
    assert.equal(asset.imageId, 99); assert.equal(asset.prompt, "旧图已完成提示词");
    assert.deepEqual(await db("o_image").orderBy("id"), before.images);
    assert.equal((await db("o_assetDescriptionHistory").where({ assetId: 10 }).first()).describe, before.assets[0].describe);
    assert.deepEqual(await db("o_scriptAssets").orderBy(["scriptId", "assetId"]), before.links);
  });
}

test("extraction route distinguishes adult authorization from unknown-age defaults and immutable script facts", () => {
  const source = readFileSync(path.resolve("src/routes/script/extractAssets.ts"), "utf8");
  const rules = /const assetExtractionDesignRules = `([\s\S]*?)`\.trim\(\);/.exec(source)?.[1];
  assert.ok(rules);
  assert.match(rules, /原文明示或 userConstraints 中用户明确确认/);
  assert.match(rules, /任一来源明确本角色已满18岁即可按成人设计/);
  assert.match(rules, /用户确认保存在 userConstraints，不伪称 scriptFacts 的原文年龄/);
  assert.match(rules, /已确认成年且用户要求轻性感时装时.*不自动改回保守衣装/);
  assert.match(rules, /原文和用户均未确认成年.*禁止使用成人胸腰臀、性感或裸露设计/);
  assert.match(rules, /scriptFacts 只收原文直接明示事实，不收用户补充的年龄与衣装设计/);
});
