import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";

const system = readFileSync("data/modelPrompt/system/scriptAssetExtraction.md", "utf8");
const emptyDiscovery = { newAssets: [], existingAssetRefs: [] };
const options = { projectId: 1, scriptIds: [731], updateExistingDescriptions: true };

async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(async () => { await db.destroy(); });
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId");
    table.text("name"); table.text("type"); table.text("describe"); table.text("prompt");
    table.text("descriptionMeta"); table.integer("descriptionVersion");
  });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content");
    table.integer("extractState"); table.text("errorReason");
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); });
  await db.schema.createTable("o_assetDescriptionHistory", table => { table.increments("id"); table.integer("assetId"); table.text("describe"); });
  await db.schema.createTable("o_image", table => { table.integer("id"); table.integer("assetsId"); table.text("filePath"); });
  await db("o_assets").insert({ id: 42, projectId: 1, name: "既有已选角色", type: "role", describe: "已确认造型", prompt: "已完成提示词", imageId: 9, descriptionVersion: 2 });
  await db("o_image").insert({ id: 9, assetsId: 42, filePath: "paid-selected.png" });
  await db("o_script").insert({ id: 731, projectId: 1, name: "背景片段", content: "几名路人匆匆走过，桌边摆着普通瓶罐。", extractState: 0 });
  await db("o_scriptAssets").insert({ scriptId: 731, assetId: 42 });
  const mutations: string[] = [];
  db.on("query", query => {
    if (/^\s*(?:insert\s+into|update|delete\s+from)\s+["`]?(?:o_assets|o_assetDescriptionHistory|o_image)\b/i.test(query.sql)) mutations.push(query.sql);
  });
  return { db, mutations };
}

test("schema-valid empty background discovery succeeds without redesign, asset writes or loss of selected images", async t => {
  const { db, mutations } = await fixture(t);
  const before = await db("o_assets");
  let calls = 0;
  const result = await extractScriptAssets({ db, system, invoke: async request => {
    calls++;
    assert.equal(calls, 1, "an empty discovery must not be retried or invoke a design stage");
    const input = JSON.parse(request.messages[0].content);
    assert.equal(input.scripts[0].id, 731);
    await request.tools.resultTool.execute(emptyDiscovery, {});
    return { finishReason: "tool-calls" };
  } }, options);
  assert.deepEqual(result, { created: 0, updated: 0, reused: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(await db("o_assets"), before);
  assert.deepEqual(await db("o_image"), [{ id: 9, assetsId: 42, filePath: "paid-selected.png" }]);
  assert.deepEqual(await db("o_assetDescriptionHistory"), []);
  assert.deepEqual(mutations, [], "no asset/image/design-history mutations are allowed");
  assert.deepEqual(await db("o_scriptAssets"), [], "only the selected script's unsupported old associations are removed");
  assert.equal((await db("o_script").where({ id: 731 }).first()).extractState, 1);
});

test("a text-only empty claim still retries and fails without resultTool or persisted changes", async t => {
  const { db, mutations } = await fixture(t);
  const before = await db("o_assets"), links = await db("o_scriptAssets");
  let calls = 0;
  await assert.rejects(extractScriptAssets({ db, system, invoke: async () => {
    calls++;
    return { text: "没有可独立制作的资产", finishReason: "stop" };
  } }, options), /AI 未返回有效的资产结果：模型未提交结果工具/);
  assert.equal(calls, 2);
  assert.deepEqual(await db("o_assets"), before);
  assert.deepEqual(await db("o_scriptAssets"), links);
  assert.equal((await db("o_script").where({ id: 731 }).first()).extractState, 0);
  assert.deepEqual(mutations, []);
});

test("invalid tool results still retry and fail rather than becoming empty success", async t => {
  const { db, mutations } = await fixture(t);
  const links = await db("o_scriptAssets");
  let calls = 0;
  await assert.rejects(extractScriptAssets({ db, system, invoke: async request => {
    calls++;
    try { await request.tools.resultTool.execute({ newAssets: [], existingAssetRefs: "not-an-array" }, {}); }
    catch (error) { return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] }; }
    throw new Error("invalid result unexpectedly passed its schema");
  } }, options), /AI 未返回有效的资产结果/);
  assert.equal(calls, 2);
  assert.deepEqual(await db("o_scriptAssets"), links);
  assert.deepEqual(mutations, []);
});

test("schema correction can legitimately finish with an empty discovery on the second attempt", async t => {
  const { db, mutations } = await fixture(t);
  let calls = 0;
  const result = await extractScriptAssets({ db, system, invoke: async request => {
    calls++;
    if (calls === 1) {
      try { await request.tools.resultTool.execute({ newAssets: [], existingAssetRefs: null }, {}); }
      catch (error) { return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] }; }
      throw new Error("invalid result unexpectedly passed its schema");
    }
    await request.tools.resultTool.execute(emptyDiscovery, {});
    return { finishReason: "tool-calls" };
  } }, options);
  assert.equal(calls, 2);
  assert.deepEqual(result, { created: 0, updated: 0, reused: 0 });
  assert.deepEqual(mutations, []);
});
