import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { createAssetExtractionCheckpoint, getAssetExtractionProgress, migrateAssetExtractionCheckpoints, recoverStaleAssetExtractionRuns } from "../src/utils/assetExtractionCheckpoint";

async function fixture(t: TestContext, migrate = true) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  if (migrate) await migrateAssetExtractionCheckpoints(db);
  return db;
}

const signature = { model: { provider: "local", name: "fixture-model", temperature: 0.2 }, rules: "原文直接依据优先",
  scripts: [{ id: 2, content: "艾娃二十五岁，黑色长发。" }, { id: 1, content: "艾娃穿白衬衫。" }],
  cards: [{ id: 10, version: 3, style: "realistic_3d_anime" }] };
const options = { projectId: 7, scriptIds: [2, 1, 2], signature };

test("failed extraction resumes only successful persisted steps for the same project and script set", async t => {
  const db = await fixture(t);
  const first = await createAssetExtractionCheckpoint(db, options);
  const input = { scripts: signature.scripts, system: signature.rules };
  const validatedResult = { newAssets: [{ name: "艾娃", type: "role", scriptIds: [1, 2] }], existingAssetRefs: [] };
  await first.write("discovery", "batch-1", input, validatedResult);
  await first.progress("facts", 1, 2, "艾娃，第 2 批");
  await first.fail(new Error("模型调用失败"));
  const failed = await getAssetExtractionProgress(db, 7);
  assert.equal(failed?.status, "failed"); assert.equal(failed?.stageLabel, "收集人物事实");
  assert.equal(failed?.label, "艾娃，第 2 批"); assert.equal(failed?.error, "模型调用失败");

  const resumed = await createAssetExtractionCheckpoint(db, { ...options, scriptIds: [1, 2] });
  assert.equal(resumed.runId, first.runId);
  assert.deepEqual(await resumed.read("discovery", "batch-1", input), validatedResult);
  assert.equal(await resumed.read("facts", "batch-2", input), undefined, "failed calls are never cached");
  assert.equal((await getAssetExtractionProgress(db, 7))?.status, "running");
  assert.equal((await getAssetExtractionProgress(db, 7))?.error, null);
  assert.equal((await db("o_assetExtractionRun")).length, 1);
});

test("checkpoint lookup hashes the exact request and canonicalizes object key order", async t => {
  const db = await fixture(t), run = await createAssetExtractionCheckpoint(db, options);
  const input = { model: "fixture", system: "rule", facts: [{ sourceRef: "1:1", fact: "白衬衫" }] };
  await run.write("card", "艾娃", input, { describe: "白衬衫" });
  assert.deepEqual(await run.read("card", "艾娃", { facts: input.facts, system: "rule", model: "fixture" }), { describe: "白衬衫" });
  assert.equal(await run.read("card", "艾娃", { ...input, model: "another-model" }), undefined);
  assert.equal(await run.read("card", "艾娃", { ...input, facts: [{ sourceRef: "1:1", fact: "黑衬衫" }] }), undefined);
  assert.equal(await run.read("card", "麦迪逊", input), undefined);
  assert.equal(await run.read("facts", "艾娃", input), undefined);
  await assert.rejects(run.write("card", "bad", input, undefined), /可序列化/);
  assert.equal(await run.read("card", "bad", input), undefined);
  await db("o_assetExtractionStep").where({ key: "艾娃" }).update({ result: "broken JSON" });
  assert.equal(await run.read("card", "艾娃", input), undefined, "a corrupt cache result must not fail the extraction");
});

test("model configuration, source text, rule or candidate-card version changes start a new run", async t => {
  const db = await fixture(t), first = await createAssetExtractionCheckpoint(db, options);
  await first.write("facts", "艾娃", { sourceRef: "1:1" }, { scriptFacts: [] });
  await first.fail("容量不足");
  const variants = [
    { ...signature, model: { ...signature.model, temperature: 0.5 } },
    { ...signature, scripts: [{ id: 1, content: "修改后的原文" }] },
    { ...signature, rules: "修改后的规则" },
    { ...signature, cards: [{ ...signature.cards[0], version: 4 }] },
  ];
  for (const changedSignature of variants) {
    const run = await createAssetExtractionCheckpoint(db, { ...options, signature: changedSignature });
    assert.notEqual(run.runId, first.runId);
    assert.equal(await run.read("facts", "艾娃", { sourceRef: "1:1" }), undefined);
    await run.fail("fixture stop");
  }
  for (const changedOptions of [{ ...options, projectId: 8 }, { ...options, scriptIds: [1] }]) {
    const run = await createAssetExtractionCheckpoint(db, changedOptions);
    assert.notEqual(run.runId, first.runId);
  }
});

test("stage completion cannot report final success before the caller commits assets", async t => {
  const db = await fixture(t), run = await createAssetExtractionCheckpoint(db, options);
  await run.write("card", "艾娃", { identity: "艾娃" }, { describe: "黑色长发" });
  await run.progress("saving", 1, 1, "保存角色卡");
  assert.equal((await getAssetExtractionProgress(db, 7))?.status, "running");
  assert.equal((await getAssetExtractionProgress(db, 7))?.completedAt, null);
  await run.fail("资产保存事务已回滚");
  assert.equal((await getAssetExtractionProgress(db, 7))?.status, "failed");
  const retry = await createAssetExtractionCheckpoint(db, options);
  assert.deepEqual(await retry.read("card", "艾娃", { identity: "艾娃" }), { describe: "黑色长发" });
  // Production calls this only after its final asset transaction succeeds.
  await retry.complete();
  const completed = await getAssetExtractionProgress(db, 7);
  assert.equal(completed?.status, "completed"); assert.equal(completed?.stageLabel, "已完成");
  assert.ok(completed?.completedAt); assert.equal(completed?.error, null);
  await retry.fail("a late error must not erase committed success");
  assert.equal((await getAssetExtractionProgress(db, 7))?.status, "completed");
  await assert.rejects(retry.write("card", "late", {}, {}), /已结束/);
});

test("a completed run is retained for history but explicit refresh starts an independent extraction", async t => {
  const db = await fixture(t), first = await createAssetExtractionCheckpoint(db, options);
  await first.write("discovery", "batch-1", {}, { existingAssetRefs: [] });
  await first.complete();
  const next = await createAssetExtractionCheckpoint(db, options);
  assert.notEqual(next.runId, first.runId);
  assert.equal(await next.read("discovery", "batch-1", {}), undefined);
  assert.equal((await db("o_assetExtractionStep").where({ runId: first.runId })).length, 1);
  assert.equal((await db("o_assetExtractionRun").where({ runId: first.runId }).first()).status, "completed");
  assert.equal((await getAssetExtractionProgress(db, 7))?.runId, next.runId);
});

test("unmigrated databases disable checkpoints without implicit schema writes", async t => {
  const db = await fixture(t, false), run = await createAssetExtractionCheckpoint(db, options);
  assert.equal(run.enabled, false); assert.equal(run.runId, null);
  await run.write("card", "艾娃", {}, {}); await run.progress("card", 0, 1); await run.fail("failed"); await run.complete();
  assert.equal(await run.read("card", "艾娃", {}), undefined);
  assert.equal(await getAssetExtractionProgress(db, 7), null);
  assert.equal(await db.schema.hasTable("o_assetExtractionRun"), false);
  await migrateAssetExtractionCheckpoints(db); await migrateAssetExtractionCheckpoints(db);
  assert.equal((await createAssetExtractionCheckpoint(db, options)).enabled, true);
});

test("simultaneous fresh requests do not adopt one another's running checkpoint", async t => {
  const db = await fixture(t);
  const [first, second] = await Promise.all([createAssetExtractionCheckpoint(db, options), createAssetExtractionCheckpoint(db, options)]);
  assert.notEqual(first.runId, second.runId);
  await first.write("facts", "艾娃", {}, { scriptFacts: [] });
  assert.equal(await second.read("facts", "艾娃", {}), undefined);
});

test("startup recovery marks interrupted runs failed and preserves committed successful steps", async t => {
  const db = await fixture(t), interrupted = await createAssetExtractionCheckpoint(db, options);
  await interrupted.write("discovery", "batch-1", {}, { newAssets: [] });
  await interrupted.progress("facts", 1, 3, "艾娃");
  const finished = await createAssetExtractionCheckpoint(db, { ...options, projectId: 8 });
  await finished.complete();
  assert.equal(await recoverStaleAssetExtractionRuns(db), 1);
  assert.equal((await getAssetExtractionProgress(db, 7))?.status, "failed");
  assert.equal((await getAssetExtractionProgress(db, 7))?.completed, 1);
  assert.equal((await getAssetExtractionProgress(db, 8))?.status, "completed");
  const resumed = await createAssetExtractionCheckpoint(db, options);
  assert.equal(resumed.runId, interrupted.runId);
  assert.deepEqual(await resumed.read("discovery", "batch-1", {}), { newAssets: [] });
  assert.equal(await resumed.read("facts", "unfinished", {}), undefined);
});

test("progress shows the recently resumed older run rather than a newer-id failed run with a different signature", async t => {
  const db = await fixture(t);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const original = await createAssetExtractionCheckpoint(db, options);
  await original.progress("facts", 1, 3, "艾娃"); await original.fail("第一次失败");
  now = 2000;
  const changed = await createAssetExtractionCheckpoint(db, { ...options, signature: { ...signature, rules: "另一版规则" } });
  await changed.progress("card", 0, 1, "新的规则"); await changed.fail("另一个配置失败");
  assert.equal((await getAssetExtractionProgress(db, 7))?.runId, changed.runId);
  now = 3000;
  const resumed = await createAssetExtractionCheckpoint(db, options);
  assert.equal(resumed.runId, original.runId);
  await resumed.progress("facts", 2, 3, "艾娃续跑");
  const visible = await getAssetExtractionProgress(db, 7);
  assert.equal(visible?.runId, original.runId, "latest activity determines visible progress, not insertion order");
  assert.equal(visible?.status, "running"); assert.equal(visible?.completed, 2);
  assert.equal(visible?.label, "艾娃续跑"); assert.equal(visible?.error, null);
});
