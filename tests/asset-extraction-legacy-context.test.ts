import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";

const discoverySummary = "贯穿五集，adult，医院左胸logo；这是发现阶段的错误摘要。";
const sourceQuote = "  艾娃是女性，黑色齐肩发。";
const visualDesign = { face: "自然脸部比例", body: "自然比例，无夸张曲线", hair: "黑色齐肩发", clothing: "普通灰色长袖上衣", environment: "", shape: "" };

async function fixture(t: TestContext, content: string, existingDescription?: string) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content"); table.integer("extractState"); table.text("errorReason");
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); table.primary(["scriptId", "assetId"]); });
  await db.schema.createTable("o_image", table => { table.integer("id"); table.integer("assetsId"); table.text("filePath"); });
  await migrateAssetDescriptions(db);
  await db("o_assets").insert({ id: 10, projectId: 1, name: existingDescription === undefined ? "已选其他角色" : "艾娃", type: "role",
    describe: existingDescription ?? "其他角色的已选外观", prompt: "保留的已付费图提示词", imageId: 40 });
  await db("o_image").insert({ id: 40, assetsId: 10, filePath: "paid-selected.png" });
  await db("o_script").insert([
    { id: 701, projectId: 1, name: "本集", content, extractState: 0, errorReason: null },
    { id: 702, projectId: 1, name: "已有历史关联", content: "艾娃穿灰色长袖上衣。", extractState: 1, errorReason: null },
  ]);
  await db("o_scriptAssets").insert({ scriptId: 702, assetId: 10 });
  return db;
}

async function submit(request: any, value: any) {
  try { await request.tools.resultTool.execute(value, {}); return { finishReason: "tool-calls" }; }
  catch (error) { return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] }; }
}

async function requestData(request: any) {
  assert.deepEqual(request.toolChoice, { type: "tool", toolName: "resultTool" });
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
  return { input: JSON.parse(request.messages[0].content), schema: await request.tools.resultTool.inputSchema.jsonSchema };
}

function facts(input: any) {
  return input.scripts.flatMap((script: any) => (script.excerpts || []).filter((excerpt: any) => excerpt.sourceRef === "701:1")
    .map((excerpt: any) => ({ sourceRef: excerpt.sourceRef, fact: "女性，黑色齐肩发", quote: "不能保存模型自造引文", scriptId: -99 })));
}

function finalDesign(scriptFacts: any[]) {
  return { describe: "艾娃，黑色齐肩发，自然比例，普通灰色长袖上衣。", scriptFacts, visualDesign, conflicts: [] };
}

test("fresh discovery summaries cannot become legacy design evidence in short or collected long requests", async t => {
  for (const longSource of [false, true]) {
    const content = sourceQuote + (longSource ? "\r\n" + "海风经过固定走廊，远处的浪声持续，墙面与地面没有变化。\r\n".repeat(500) : "");
    const db = await fixture(t, content);
    const savedOtherAsset = await db("o_assets").where({ id: 10 }).first(), images = await db("o_image");
    let collections = 0, finals = 0;
    const invoke = async (request: any) => {
      const { input, schema } = await requestData(request);
      if (schema.properties.newAssets) return submit(request, { newAssets: [{ name: "艾娃", type: "role", desc: discoverySummary,
        scriptIds: input.scripts.map((script: any) => script.id) }], existingAssetRefs: [] });
      assert.equal(Object.hasOwn(input, "legacyDescription"), false, "fresh targets have no historical-description field, even after collection");
      for (const marker of ["贯穿五集", "adult", "医院左胸logo"]) {
        assert.ok(!request.messages[0].content.includes(marker), `discovery summary leaked into design/collection input: ${marker}`);
        assert.ok(!request.system.includes(marker), `discovery summary leaked into system context: ${marker}`);
      }
      assert.deepEqual(await db("o_assets").orderBy("id"), [savedOtherAsset], "discovery and collection do not write partial assets");
      assert.equal((await db("o_assetDescriptionHistory")).length, 0);
      if (!schema.properties.describe) { collections++; return submit(request, { scriptFacts: facts(input) }); }
      finals++;
      if (longSource) {
        assert.ok(collections > 1, "exercise the long-source collector-to-final path");
        assert.deepEqual(input.evidenceFacts, [{ sourceRef: "701:1", fact: "女性，黑色齐肩发" }]);
      } else { assert.equal(collections, 0); assert.equal(Object.hasOwn(input, "evidenceFacts"), false); }
      return submit(request, finalDesign(facts(input)));
    };
    const result = await extractScriptAssets({ db, invoke, system: "只依据原文设计稳定外观。" }, { projectId: 1, scriptIds: [701] });
    assert.equal(result.created, 1); assert.equal(finals, 1);
    const asset = await db("o_assets").where({ name: "艾娃" }).first();
    assert.deepEqual(JSON.parse(asset.descriptionMeta).scriptFacts,
      [{ sourceRef: "701:1", scriptId: 701, quote: sourceQuote, fact: "女性，黑色齐肩发" }], "the server still owns exact evidence quotes");
    assert.deepEqual(await db("o_assets").where({ id: 10 }).first(), savedOtherAsset);
    assert.deepEqual(await db("o_image"), images);
    assert.deepEqual(await db("o_scriptAssets").where({ scriptId: 702 }), [{ scriptId: 702, assetId: 10 }]);
    assert.equal((await db("o_assetDescriptionHistory").where({ assetId: 10 })).length, 0);
  }
});

test("existing saved descriptions, including empty values, never fall back to fresh discovery summaries", async t => {
  for (const savedDescription of ["  历史保存的黑发与灰色衣装  ", ""]) {
    const db = await fixture(t, sourceQuote, savedDescription), before = await db("o_assets").where({ id: 10 }).first();
    const images = await db("o_image"); let finals = 0;
    const invoke = async (request: any) => {
      const { input, schema } = await requestData(request);
      if (schema.properties.newAssets) {
        assert.ok(input.existingAssets.some((asset: any) => asset.assetId === 10 && asset.name === "艾娃"));
        // An already saved identity may be returned as newAssets by the model.
        // Its discovery desc must still never replace the DB-owned old value.
        return submit(request, { newAssets: [{ name: "艾娃", type: "role", desc: discoverySummary, scriptIds: [701] }], existingAssetRefs: [] });
      }
      finals++;
      assert.ok(schema.properties.describe);
      assert.equal(Object.hasOwn(input, "legacyDescription"), true);
      assert.equal(input.legacyDescription, savedDescription, "keep the exact DB value; empty is not an invitation to use discovery desc");
      assert.ok(!request.messages[0].content.includes(discoverySummary));
      assert.deepEqual(await db("o_assets").where({ id: 10 }).first(), before);
      assert.equal((await db("o_assetDescriptionHistory")).length, 0);
      return submit(request, finalDesign(facts(input)));
    };
    const result = await extractScriptAssets({ db, invoke, system: "只依据原文设计稳定外观。" },
      { projectId: 1, scriptIds: [701], updateExistingDescriptions: true });
    assert.equal(result.updated, 1); assert.equal(finals, 1);
    const current = await db("o_assets").where({ id: 10 }).first();
    assert.equal(current.imageId, before.imageId); assert.equal(current.prompt, before.prompt);
    assert.equal(current.descriptionVersion, 1); assert.deepEqual(await db("o_image"), images);
    const history = await db("o_assetDescriptionHistory").where({ assetId: 10 });
    assert.equal(history.length, 1); assert.equal(history[0].describe, savedDescription); assert.equal(history[0].version, 0);
    assert.deepEqual(JSON.parse(current.descriptionMeta).scriptFacts,
      [{ sourceRef: "701:1", scriptId: 701, quote: sourceQuote, fact: "女性，黑色齐肩发" }]);
    assert.deepEqual((await db("o_scriptAssets").where({ assetId: 10 }).orderBy("scriptId")).map(row => row.scriptId), [701, 702]);
  }
});
