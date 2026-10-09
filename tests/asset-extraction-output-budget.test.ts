import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";

const options = { projectId: 1, scriptIds: [701], updateExistingDescriptions: false };
const selected = { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [701] }] };
const invalid = { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [999] }] };

async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content");
    table.integer("extractState"); table.text("errorReason");
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); });
  await db.schema.createTable("o_image", table => { table.integer("id"); table.integer("assetsId"); table.text("filePath"); });
  await migrateAssetDescriptions(db);
  await db("o_assets").insert({ id: 10, projectId: 1, name: "艾娃", type: "role", describe: "已选角色造型", prompt: "已完成提示词", imageId: 40 });
  await db("o_image").insert({ id: 40, assetsId: 10, filePath: "paid-selected.png" });
  await db("o_script").insert({ id: 701, projectId: 1, name: "第一集", content: "艾娃黑发黑眼。", extractState: 0, errorReason: null });
  await db("o_scriptAssets").insert({ scriptId: 701, assetId: 10 });
  const mutations: string[] = [];
  db.on("query", query => {
    if (/^\s*(?:insert\s+into|update|delete\s+from)\s+["`]?(?:o_assets|o_assetDescriptionHistory|o_image|o_scriptAssets|o_script)\b/i.test(query.sql)) mutations.push(query.sql);
  });
  const snapshot = async () => ({
    assets: await db("o_assets").orderBy("id"), images: await db("o_image").orderBy("id"),
    histories: await db("o_assetDescriptionHistory").orderBy("id"), links: await db("o_scriptAssets").orderBy(["scriptId", "assetId"]),
    scripts: await db("o_script").orderBy("id"),
  });
  return { db, mutations, snapshot };
}

async function submit(request: any, value: any, finishReason = "tool-calls") {
  try {
    await request.tools.resultTool.execute(value, {});
    return { finishReason };
  } catch (error) {
    return { finishReason, content: [{ type: "tool-error", error }] };
  }
}

async function checkRequest(request: any, maxOutputTokens: number) {
  assert.equal(request.maxOutputTokens, maxOutputTokens);
  assert.equal(request.temperature, 0.3);
  assert.deepEqual(request.toolChoice, { type: "tool", toolName: "resultTool" });
  assert.equal(typeof request.stopWhen, "function");
  assert.equal(request.messages.length, 1); assert.equal(request.messages[0].role, "user");
  assert.deepEqual(Object.keys(request.tools), ["resultTool"]);
  return { messages: JSON.stringify(request.messages), schema: await request.tools.resultTool.inputSchema.jsonSchema };
}

test("only a truncated completion raises the second output cap while preserving the input and tool contract", async t => {
  const { db, mutations } = await fixture(t);
  const requests: any[] = [], contracts: any[] = [];
  const invoke = async (request: any) => {
    requests.push(request); contracts.push(await checkRequest(request, requests.length === 1 ? 6144 : 12288));
    assert.deepEqual(mutations, [], "nothing is saved before a valid result tool executes");
    if (requests.length === 1) return { finishReason: "length", text: "尚未提交的长推理" };
    assert.equal(requests.length, 2);
    assert.match(request.system, /字段简洁/); assert.match(request.system, /不输出长篇推理/);
    assert.match(request.system, /未知[^。]*不补写/); assert.match(request.system, /事实可为空/);
    return submit(request, selected);
  };
  const result = await extractScriptAssets({ db, invoke, system: "rules" }, options);
  assert.equal(requests.length, 2); assert.deepEqual(contracts[0], contracts[1]);
  assert.deepEqual(result, { created: 0, updated: 0, reused: 1 });
  assert.equal((await db("o_assets").where({ id: 10 }).first()).imageId, 40);
  assert.equal((await db("o_assetDescriptionHistory")).length, 0);
});

test("two length-limited responses stop after the larger final attempt and leave all persisted data untouched", async t => {
  const { db, mutations, snapshot } = await fixture(t);
  const before = await snapshot(), contracts: any[] = [];
  let calls = 0;
  const invoke = async (request: any) => {
    calls++; contracts.push(await checkRequest(request, calls === 1 ? 6144 : 12288));
    assert.ok(calls <= 2); return { finishReason: "length", text: "仍未提交结果" };
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" }, options), /识别剧本资产.*模型输出达到长度上限/);
  assert.equal(calls, 2); assert.deepEqual(contracts[0], contracts[1]);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

test("a schema tool error takes precedence over a length finish reason and keeps the second cap unchanged", async t => {
  const { db, mutations } = await fixture(t); let calls = 0;
  const contracts: any[] = [];
  const invoke = async (request: any) => {
    calls++; contracts.push(await checkRequest(request, 6144)); assert.deepEqual(mutations, []);
    if (calls === 1) {
      const result = await submit(request, invalid, "length");
      assert.equal(result.content?.[0].type, "tool-error"); return result;
    }
    assert.match(request.system, /上次结果未能保存/);
    assert.doesNotMatch(request.system, /模型输出达到长度上限/);
    return submit(request, selected);
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, options);
  assert.equal(calls, 2); assert.deepEqual(contracts[0], contracts[1]);
});

test("repeated schema failures never inflate the output cap or replace existing assets and links", async t => {
  const { db, mutations, snapshot } = await fixture(t); const before = await snapshot(); let calls = 0;
  const invoke = async (request: any) => {
    calls++; assert.ok(calls <= 2); await checkRequest(request, 6144);
    return submit(request, invalid, "length");
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" }, options), /识别剧本资产.*AI 未返回有效的资产结果/);
  assert.equal(calls, 2); assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

test("a normal stop without a tool gets a bounded correction at the original cap", async t => {
  const { db, mutations } = await fixture(t); const contracts: any[] = []; let calls = 0;
  const invoke = async (request: any) => {
    calls++; contracts.push(await checkRequest(request, 6144)); assert.deepEqual(mutations, []);
    if (calls === 1) return { finishReason: "stop", text: "已分析，但没有调用工具" };
    assert.match(request.system, /模型未提交结果工具[^。]*stop/);
    return submit(request, selected);
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, options);
  assert.equal(calls, 2); assert.deepEqual(contracts[0], contracts[1]);
});

test("two text-only stop responses fail without any asset, image, history, script or link writes", async t => {
  const { db, mutations, snapshot } = await fixture(t); const before = await snapshot(); let calls = 0;
  const invoke = async (request: any) => {
    calls++; assert.ok(calls <= 2); await checkRequest(request, 6144);
    return { finishReason: "stop", text: "正文不能冒充工具结果" };
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" }, options), /模型未提交结果工具[^。]*stop/);
  assert.equal(calls, 2); assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

for (const finishReason of ["tool-calls", "length"]) {
  test(`a valid first tool result is accepted without retry even when finishReason is ${finishReason}`, async t => {
    const { db, mutations } = await fixture(t); let calls = 0;
    const invoke = async (request: any) => {
      calls++; assert.equal(calls, 1); await checkRequest(request, 6144); assert.deepEqual(mutations, []);
      return submit(request, selected, finishReason);
    };
    const result = await extractScriptAssets({ db, invoke, system: "rules" }, options);
    assert.equal(calls, 1); assert.equal(result.reused, 1);
    assert.equal((await db("o_assets").where({ id: 10 }).first()).imageId, 40);
    assert.equal((await db("o_assetDescriptionHistory")).length, 0);
  });
}

test("each discovery or design stage starts at the original cap instead of inheriting a previous stage's retry budget", async t => {
  const { db, mutations } = await fixture(t); const stages: string[] = [], contracts: any[] = []; let calls = 0;
  const invoke = async (request: any) => {
    calls++;
    const contract = await checkRequest(request, calls % 2 === 1 ? 6144 : 12288);
    contracts.push(contract); assert.deepEqual(mutations, [], "all discovery and design responses precede the atomic commit");
    const schema = contract.schema; stages.push(schema.properties.newAssets ? "discovery" : "design");
    if (calls % 2 === 1) return { finishReason: "length", text: "这一阶段尚未提交工具" };
    if (schema.properties.newAssets) return submit(request, selected);
    return submit(request, {
      describe: "黑发黑眼，保留既有角色识别点。",
      scriptFacts: [{ sourceRef: "701:1", fact: "黑发黑眼" }], conflicts: [],
      visualDesign: { face: "保留既有脸型", body: "中性体态", hair: "黑发", clothing: "普通上衣", environment: "", shape: "" },
    });
  };
  const result = await extractScriptAssets({ db, invoke, system: "rules" }, { ...options, updateExistingDescriptions: true });
  assert.equal(calls, 4); assert.deepEqual(stages, ["discovery", "discovery", "design", "design"]);
  assert.deepEqual(contracts[0], contracts[1]); assert.deepEqual(contracts[2], contracts[3]);
  assert.equal(result.updated, 1); assert.equal((await db("o_assets").where({ id: 10 }).first()).imageId, 40);
  assert.equal((await db("o_assetDescriptionHistory")).length, 1);
});
