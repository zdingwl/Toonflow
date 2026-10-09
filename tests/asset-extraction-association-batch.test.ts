import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";

const projectId = 1;
const assetIds = Array.from({ length: 30 }, (_value, index) => 100 + index);
const scriptIds = Array.from({ length: 20 }, (_value, index) => 701 + index);
const options = { projectId, scriptIds, groupSize: 10, updateExistingDescriptions: false };

interface SqlQuery {
  sql: string;
  bindings?: readonly unknown[];
}

interface DiscoveryResult {
  newAssets: [];
  existingAssetRefs: { assetId: number; scriptIds: number[] }[];
}

interface DiscoveryRequest {
  system: string;
  messages: { role: string; content: string }[];
  tools: {
    resultTool: {
      execute: (result: DiscoveryResult, options: Record<string, never>) => Promise<unknown>;
    };
  };
}

interface DiscoveryInput {
  scripts: { id: number; name: string; content: string }[];
  existingAssets: { assetId: number; name: string; type: string }[];
}

interface LinkRow {
  scriptId: number;
  assetId: number;
}

interface AssetRow {
  id: number;
  projectId: number;
  assetsId: number | null;
  name: string;
  type: string;
  describe: string;
  prompt: string;
  promptState: string;
  promptErrorReason: string | null;
  imageId: number;
  startTime: number;
  descriptionVersion: number;
  promptDescriptionVersion: number;
  imageDescriptionVersion: number;
  descriptionMeta: string;
}

interface ScriptRow {
  id: number;
  projectId: number;
  name: string;
  content: string;
  extractState: number;
  errorReason: string | null;
}

interface ImageRow {
  id: number;
  assetsId: number;
  filePath: string;
  prompt: string;
  descriptionVersion: number;
}

interface HistoryRow {
  id: number;
  assetId: number;
  projectId: number;
  version: number;
  describe: string;
  meta: string;
  createdAt: number;
}

async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_assets", table => {
    table.increments("id");
    table.integer("projectId").notNullable();
    table.integer("assetsId");
    table.integer("imageId");
    table.bigInteger("startTime");
    for (const column of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(column);
  });
  await db.schema.createTable("o_script", table => {
    table.integer("id").primary();
    table.integer("projectId").notNullable();
    table.text("name");
    table.text("content");
    table.integer("extractState");
    table.text("errorReason");
  });
  await db.schema.createTable("o_scriptAssets", table => {
    table.integer("scriptId").notNullable();
    table.integer("assetId").notNullable();
    table.primary(["scriptId", "assetId"]);
  });
  await db.schema.createTable("o_image", table => {
    table.integer("id").primary();
    table.integer("assetsId").notNullable();
    table.text("filePath");
    table.text("prompt");
  });
  await migrateAssetDescriptions(db);

  await db("o_assets").insert(assetIds.map(id => ({
    id, projectId, name: `角色${id}`, type: "role", assetsId: null,
    describe: `角色${id}的已确认旧造型`, prompt: `角色${id}的已完成提示词`,
    promptState: "已完成", promptErrorReason: null, imageId: 4000 + id, startTime: 1000 + id,
    descriptionVersion: 1, promptDescriptionVersion: 1, imageDescriptionVersion: 1,
    descriptionMeta: JSON.stringify({ source: "user", userConstraints: `角色${id}的已确认要求` }),
  })));
  await db("o_image").insert(assetIds.map(id => ({
    id: 4000 + id, assetsId: id, filePath: `paid-selected-${id}.png`,
    prompt: `旧图片提示词${id}`, descriptionVersion: 1,
  })));
  await db("o_assetDescriptionHistory").insert(assetIds.map(id => ({
    assetId: id, projectId, version: 0, describe: `角色${id}的历史描述`,
    meta: JSON.stringify({ source: "ai", changedFields: ["clothing"] }), createdAt: 900 + id,
  })));
  await db("o_script").insert(scriptIds.map(id => ({
    id, projectId, name: `剧本${id}`, content: `三十位具名角色在剧本${id}中分别对话。`,
    extractState: 0, errorReason: `剧本${id}的先前错误`,
  })));
  await db("o_scriptAssets").insert(scriptIds.map((scriptId, index) => ({ scriptId, assetId: assetIds[index] })));

  const insertedAssociations: SqlQuery[] = [];
  const completedAssociationInserts: SqlQuery[] = [];
  const isAssociationInsert = (query: SqlQuery) => /^insert into ["`]o_scriptAssets["`]/i.test(query.sql);
  db.on("query", (query: SqlQuery) => {
    if (isAssociationInsert(query)) insertedAssociations.push(query);
  });
  db.on("query-response", (_response: unknown, query: SqlQuery) => {
    if (isAssociationInsert(query)) completedAssociationInserts.push(query);
  });
  const snapshot = async () => ({
    assets: await db<AssetRow>("o_assets").orderBy("id"),
    images: await db<ImageRow>("o_image").orderBy("id"),
    histories: await db<HistoryRow>("o_assetDescriptionHistory").orderBy("id"),
    links: await db<LinkRow>("o_scriptAssets").orderBy(["scriptId", "assetId"]),
    scripts: await db<ScriptRow>("o_script").orderBy("id"),
  });
  return { db, snapshot, insertedAssociations, completedAssociationInserts };
}

function discoveryModel() {
  const requestedScriptIds: number[][] = [];
  const invoke = async (request: DiscoveryRequest) => {
    assert.match(request.system, /本步骤识别资产和剧本关联/);
    assert.equal(request.messages.length, 1);
    const input = JSON.parse(request.messages[0].content) as DiscoveryInput;
    assert.ok(Array.isArray(input.scripts));
    assert.deepEqual(input.existingAssets.map(asset => asset.assetId), assetIds);
    const currentIds = input.scripts.map(script => script.id);
    assert.ok(currentIds.length > 0 && currentIds.length <= 10);
    assert.ok(currentIds.every(id => scriptIds.includes(id)));
    requestedScriptIds.push(currentIds);
    await request.tools.resultTool.execute({
      newAssets: [],
      existingAssetRefs: assetIds.map(assetId => ({ assetId, scriptIds: currentIds })),
    }, {});
    return { finishReason: "tool-calls" };
  };
  return { invoke, requestedScriptIds };
}

function assertAllScriptsDiscovered(requested: number[][]) {
  assert.equal(requested.length, 2, "reusing existing assets requires only the two discovery batches");
  assert.deepEqual(requested.flat().sort((left, right) => left - right), scriptIds);
}

function assertRealSqliteInsert(query: SqlQuery, expectedRows: number) {
  // Knex compiles a SQLite array insert into SELECT ... UNION ALL SELECT.
  // Each association supplies two bindings; executing >500 rows at once fails
  // SQLite's compound-select limit, even though the model result is valid.
  assert.match(query.sql, /union all select/i);
  assert.equal(query.bindings?.length, expectedRows * 2);
}

test("600 reused-asset associations execute on SQLite without replacing saved designs or images", async t => {
  const { db, snapshot, insertedAssociations, completedAssociationInserts } = await fixture(t);
  const before = await snapshot();
  const model = discoveryModel();
  const result = await extractScriptAssets({ db, invoke: model.invoke, system: "既有资产关联测试规则" }, options);
  const after = await snapshot();

  assert.deepEqual(result, { created: 0, updated: 0, reused: 30 });
  assertAllScriptsDiscovered(model.requestedScriptIds);
  const expectedLinks = scriptIds.flatMap(scriptId => assetIds.map(assetId => ({ scriptId, assetId })));
  assert.equal(after.links.length, 600);
  assert.deepEqual(after.links, expectedLinks);
  assert.deepEqual(after.scripts, before.scripts.map(script => ({ ...script, extractState: 1, errorReason: null })));
  assert.deepEqual(after.assets, before.assets, "existing description, prompt, selected image, and versions are preserved");
  assert.deepEqual(after.histories, before.histories);
  assert.deepEqual(after.images, before.images, "paid image records are preserved");
  assert.equal(insertedAssociations.length, 3);
  assert.equal(completedAssociationInserts.length, 3, "all three real SQLite inserts completed");
  for (const query of insertedAssociations) assertRealSqliteInsert(query, 200);
});

test("a SQLite failure in association batch two rolls back the completed first batch and all selected script state", async t => {
  const { db, snapshot, insertedAssociations, completedAssociationInserts } = await fixture(t);
  const before = await snapshot();
  const model = discoveryModel();

  // Assets 100..109 contribute the first 200 rows. The first row for asset
  // 110 starts batch two. The trigger reads the uncommitted transaction to
  // prove batch one really executed before injecting the later failure.
  await db.raw(`CREATE TRIGGER fail_second_association_batch
    BEFORE INSERT ON o_scriptAssets
    WHEN NEW.assetId = 110
    BEGIN
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM o_scriptAssets) = 200
          AND (SELECT COUNT(*) FROM o_scriptAssets WHERE assetId BETWEEN 100 AND 109) = 200
        THEN RAISE(ABORT, 'second association batch failed after 200 committed-to-transaction rows')
        ELSE RAISE(ABORT, 'second association batch failed without the expected first batch')
      END;
    END`);

  await assert.rejects(
    extractScriptAssets({ db, invoke: model.invoke, system: "既有资产关联测试规则" }, options),
    /second association batch failed after 200 committed-to-transaction rows/,
  );
  assertAllScriptsDiscovered(model.requestedScriptIds);
  assert.equal(insertedAssociations.length, 2, "batch two was attempted and batch three was never reached");
  assert.equal(completedAssociationInserts.length, 1, "batch one executed successfully before SQLite rejected batch two");
  for (const query of insertedAssociations) assertRealSqliteInsert(query, 200);
  assert.deepEqual(await snapshot(), before, "old associations, scripts, assets, history, and media survive the transaction rollback");
});
