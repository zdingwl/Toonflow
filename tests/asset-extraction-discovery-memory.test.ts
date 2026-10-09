import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, ASSET_EXTRACTION_RETRY_TOKEN_RESERVE, estimateAssetExtractionRequestTokens,
  splitAssetExtractionText } from "../src/utils/assetExtractionContext";

type Script = { id: number; name: string; content: string };

async function fixture(t: TestContext, scripts: Script[]) {
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
  await db("o_assets").insert({ id: 10, projectId: 1, name: "既有角色", type: "role", describe: "已选造型", prompt: "旧提示词", imageId: 40 });
  await db("o_image").insert({ id: 40, assetsId: 10, filePath: "paid-selected.png" });
  await db("o_script").insert(scripts.map(script => ({ ...script, projectId: 1, extractState: 0, errorReason: null })));
  await db("o_scriptAssets").insert({ scriptId: scripts[0].id, assetId: 10 });
  const snapshot = async () => ({ assets: await db("o_assets").orderBy("id"), scripts: await db("o_script").orderBy("id"),
    links: await db("o_scriptAssets").orderBy(["scriptId", "assetId"]), images: await db("o_image").orderBy("id"), histories: await db("o_assetDescriptionHistory").orderBy("id") });
  return { db, snapshot };
}

async function submit(request: any, value: any) {
  try { await request.tools.resultTool.execute(value, {}); return { finishReason: "tool-calls" }; }
  catch (error) { return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] }; }
}

async function readRequest(request: any) {
  const input = JSON.parse(request.messages[0].content), schema = await request.tools.resultTool.inputSchema.jsonSchema;
  assert.deepEqual(request.toolChoice, { type: "tool", toolName: "resultTool" });
  assert.ok(estimateAssetExtractionRequestTokens(request.system, input, schema) <= ASSET_EXTRACTION_INPUT_TOKEN_BUDGET,
    "every actual invocation must include growing candidate memory in its context budget");
  return { input, schema };
}

function references(input: any) {
  return (input.scripts || []).flatMap((script: any) => (script.excerpts || []).filter((excerpt: any) => excerpt.quote.includes(input.asset.name))
    .map((excerpt: any) => ({ sourceRef: excerpt.sourceRef, fact: `原文明示${input.asset.name}` })));
}

async function designOrCollect(request: any, input: any, schema: any) {
  const facts = references(input);
  if (!schema.properties.describe) return submit(request, { scriptFacts: facts });
  return submit(request, { describe: `${input.asset.name}，保留原文明确的实体识别。`, scriptFacts: facts, conflicts: [],
    visualDesign: { face: "", body: "", hair: "", clothing: "", environment: "固定场所", shape: "清楚的固定结构" } });
}

const names = Array.from({ length: 80 }, (_value, index) => `港口${index + 1}号海潮银帆固定码头仓储登记实体海潮银帆固定码头仓储登记实体`);
const namesText = names.map(name => `${name}是实际出现的独立实体。`).join("\r\n");
const filler = "连续原文海风吹过甲板，固定栏杆仍在原位。".repeat(160);
const newEntities = (scriptId: number) => names.map(name => ({ name, type: "tool", desc: "原文明示实体", scriptIds: [scriptId] }));

function assertMemory(memory: any[], expectedNames: string[]) {
  assert.deepEqual(memory.map(item => item.name).sort(), [...expectedNames].sort());
  assert.ok(memory.every(item => Object.keys(item).sort().join(",") === "name,type"), "unpersisted candidates have no invented ID or extra design fields");
}

test("later batches reuse canonical new-entity names while ID-less candidates cannot become existingAssetRefs", async t => {
  for (const forgedReference of [false, true]) {
    const scripts = [{ id: 701, name: "第一集", content: "艾娃站在海边。" }, { id: 702, name: "第二集", content: "艾娃走进室内。" }];
    const { db, snapshot } = await fixture(t, scripts); const before = await snapshot(); let discoveries = 0, designs = 0;
    const invoke = async (request: any) => {
      const { input, schema } = await readRequest(request);
      if (!schema.properties.newAssets) { designs++; return designOrCollect(request, input, schema); }
      discoveries++;
      if (discoveries === 1) assert.deepEqual(input.discoveredAssets, []);
      else {
        assertMemory(input.discoveredAssets, ["艾娃"]);
        assert.deepEqual(input.discoveredAssets, [{ name: "艾娃", type: "role" }]);
        assert.ok(input.existingAssets.every((asset: any) => asset.name !== "艾娃"));
        assert.match(request.system, /newAssets/); assert.match(request.system, /existingAssetRefs/);
        if (forgedReference) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 999_991, scriptIds: [702] }] });
      }
      return submit(request, { newAssets: [{ name: "艾娃", type: "role", desc: "原文明示角色", scriptIds: input.scripts.map((script: any) => script.id) }], existingAssetRefs: [] });
    };
    const run = extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: [701, 702], groupSize: 1 });
    if (forgedReference) {
      await assert.rejects(run, /不属于当前项目|资产.*(?:无效|候选|不存在)/);
      assert.equal(designs, 0); assert.deepEqual(await snapshot(), before);
    } else {
      const result = await run; assert.equal(result.created, 1); assert.equal(designs, 1);
      const ava = await db("o_assets").where({ projectId: 1, name: "艾娃", type: "role" }).first();
      assert.deepEqual((await db("o_scriptAssets").where({ assetId: ava.id }).orderBy("scriptId")).map(row => row.scriptId), [701, 702]);
    }
    assert.equal(discoveries, 2);
  }
});

test("candidate growth repartitions formerly fitting episode batches without losing text or the final episode's entity", async t => {
  const scripts: Script[] = Array.from({ length: 9 }, (_value, index) => ({ id: 701 + index, name: `第${index + 1}集`,
    content: index === 0 ? namesText : filler + (index === 8 ? "末集灯塔是实际呈现的独立场景。" : "") }));
  const { db } = await fixture(t, scripts); const delivered = new Map<number, string>(); let discoveries = 0, checkedGrowth = false;
  const invoke = async (request: any) => {
    const { input, schema } = await readRequest(request);
    if (!schema.properties.newAssets) return designOrCollect(request, input, schema);
    discoveries++;
    for (const script of input.scripts) delivered.set(script.id, (delivered.get(script.id) || "") + script.content);
    if (discoveries === 1) return submit(request, { newAssets: newEntities(701), existingAssetRefs: [] });
    assertMemory(input.discoveredAssets, names);
    if (!checkedGrowth) {
      const formerlyFitting = { ...input, scripts: scripts.slice(2, 4), discoveredAssets: [] };
      const afterGrowth = { ...formerlyFitting, discoveredAssets: input.discoveredAssets };
      const cap = ASSET_EXTRACTION_INPUT_TOKEN_BUDGET - ASSET_EXTRACTION_RETRY_TOKEN_RESERVE;
      assert.ok(estimateAssetExtractionRequestTokens(request.system, formerlyFitting, schema) <= cap,
        "the original two-episode plan must genuinely fit before discovery memory grows");
      assert.ok(estimateAssetExtractionRequestTokens(request.system, afterGrowth, schema) > cap,
        "the new memory must genuinely invalidate that previously fitting plan");
      assert.equal(input.scripts.length, 1, "the invocation must use a smaller episode group after memory growth");
      checkedGrowth = true;
    }
    const final = input.scripts.filter((script: any) => script.content.includes("末集灯塔"));
    return submit(request, { newAssets: final.map((script: any) => ({ name: "末集灯塔", type: "scene", desc: "原文明示场景", scriptIds: [script.id] })), existingAssetRefs: [] });
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: scripts.map(script => script.id), groupSize: 2 });
  assert.ok(checkedGrowth); assert.ok(discoveries > Math.ceil(scripts.length / 2));
  for (const script of scripts) assert.equal(delivered.get(script.id), script.content, `lost episode text ${script.id}`);
  const last = await db("o_assets").where({ name: "末集灯塔", projectId: 1, type: "scene" }).first();
  assert.ok(last); assert.deepEqual(await db("o_scriptAssets").where({ assetId: last.id }).select("scriptId"), [{ scriptId: 709 }]);
  assert.ok((await db("o_script")).every(script => script.extractState === 1));
});

test("a single long original is continuously resliced after candidate memory grows, keeping its ending and source quotes", async t => {
  const content = namesText + "\r\n" + filler.repeat(8) + "终段灯塔是实际呈现的独立场景。";
  const scripts = [{ id: 701, name: "超长单集", content }]; const { db } = await fixture(t, scripts);
  const pieces: string[] = []; let discoveries = 0, checkedGrowth = false;
  const invoke = async (request: any) => {
    const { input, schema } = await readRequest(request);
    if (!schema.properties.newAssets) return designOrCollect(request, input, schema);
    discoveries++; assert.equal(input.scripts.length, 1); assert.equal(input.scripts[0].id, 701);
    pieces.push(input.scripts[0].content);
    if (discoveries === 1) return submit(request, { newAssets: newEntities(701), existingAssetRefs: [] });
    assertMemory(input.discoveredAssets, names);
    if (!checkedGrowth) {
      const originalRemaining = content.slice(pieces[0].length);
      const cap = ASSET_EXTRACTION_INPUT_TOKEN_BUDGET - ASSET_EXTRACTION_RETRY_TOKEN_RESERVE;
      // The first slice contains ASCII-numbered names; later prose is denser.
      // Reconstruct the old empty-memory plan by tokens, not equal character counts.
      const oldPiece = splitAssetExtractionText(originalRemaining, part =>
        estimateAssetExtractionRequestTokens(request.system,
          { ...input, scripts: [{ ...input.scripts[0], content: part }], discoveredAssets: [] }, schema) <= cap)[0];
      const before = { ...input, scripts: [{ ...input.scripts[0], content: oldPiece }], discoveredAssets: [] };
      const after = { ...before, discoveredAssets: input.discoveredAssets };
      assert.ok(estimateAssetExtractionRequestTokens(request.system, before, schema) <= cap);
      assert.ok(estimateAssetExtractionRequestTokens(request.system, after, schema) > cap,
        "memory growth must make a former single-script slice too large");
      assert.ok(pieces[1].length < oldPiece.length, "the queued slice must be split again instead of sent oversized");
      checkedGrowth = true;
    }
    return submit(request, { newAssets: input.scripts[0].content.includes("终段灯塔") ? [{ name: "终段灯塔", type: "scene", desc: "原文明示场景", scriptIds: [701] }] : [], existingAssetRefs: [] });
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: [701], groupSize: 1 });
  assert.ok(checkedGrowth); assert.ok(discoveries > 2); assert.equal(pieces.join(""), content);
  const last = await db("o_assets").where({ name: "终段灯塔", projectId: 1 }).first(); assert.ok(last);
  assert.deepEqual(await db("o_scriptAssets").where({ assetId: last.id }).select("scriptId"), [{ scriptId: 701 }]);
  const facts = JSON.parse(last.descriptionMeta).scriptFacts;
  assert.ok(facts.some((fact: any) => fact.quote === "终段灯塔是实际呈现的独立场景。"));
  assert.ok(facts.every((fact: any) => content.includes(fact.quote)), "reslicing cannot rewrite the immutable original quotes");
});
