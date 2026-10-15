import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { migrateCharacterCards } from "../src/utils/characterCards";
import { createAssetExtractionCheckpoint, migrateAssetExtractionCheckpoints, recoverStaleAssetExtractionRuns } from "../src/utils/assetExtractionCheckpoint";

const validVisual = { face: "自然椭圆脸，清晰眉眼", body: "自然比例，肩线舒展", hair: "黑色长发",
  clothing: "白色翻领衬衫、灰色直筒长裤与黑色平底鞋", environment: "", shape: "" };

async function fixture(t: TestContext, cause: "missing_clothing" | "unknown_adult") {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_script", table => {
    for (const field of ["id", "projectId", "extractState"]) table.integer(field);
    for (const field of ["name", "content", "errorReason"]) table.text(field);
  });
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); for (const field of ["projectId", "assetsId", "imageId"]) table.integer(field);
    table.bigInteger("startTime"); for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); table.primary(["scriptId", "assetId"]); });
  await migrateAssetDescriptions(db); await migrateCharacterCards(db); await migrateAssetExtractionCheckpoints(db);
  const content = cause === "missing_clothing" ? "艾娃是女性，25岁，黑色长发。" : "艾娃是女性，黑色长发。";
  await db("o_script").insert({ id: 1, projectId: 7, name: "第一集", content });
  await db("o_assets").insert({ id: 10, projectId: 7, name: "艾娃", type: "role", imageId: 40,
    describe: "旧的可用人物描述", prompt: "已完成图片对应提示词", promptState: "已完成",
    descriptionMeta: JSON.stringify({ visualDesign: validVisual, userConstraints: "保留黑色长发" }) });
  await db("o_scriptAssets").insert({ scriptId: 1, assetId: 10 });
  const before = await db("o_assets").where({ id: 10 }).first();
  const initialCardCount = (await db("o_characterCard")).length;
  let provideInvalidCard = true;
  const calls: string[] = [];
  const invoke = async (request: any) => {
    const input = JSON.parse(request.messages[0].content), schema = await request.tools.resultTool.inputSchema.jsonSchema;
    const stage = schema.properties.newAssets ? "discovery" : schema.properties.decisions ? "scope" : schema.properties.mode ? "match" : schema.properties.describe ? "final" : "facts";
    calls.push(stage);
    if (stage === "final") assert.deepEqual(input.agePolicy, {
      ageBand: cause === "missing_clothing" ? "adult" : "unknown",
      ageMin: cause === "missing_clothing" ? 25 : null, ageMax: cause === "missing_clothing" ? 25 : null,
      ageBounds: { min: cause === "missing_clothing" ? 25 : null, max: cause === "missing_clothing" ? 25 : null }, gender: "female",
    }, "the final writer receives authoritative source/user age bounds on both initial attempts and checkpoint recovery");
    let result: any;
    if (stage === "discovery") result = { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [1] }] };
    else if (stage === "facts") result = { scriptFacts: [{ sourceRef: "1:1", fact: "女性" }, { sourceRef: "1:1", fact: "黑色长发" },
      ...(cause === "missing_clothing" ? [{ sourceRef: "1:1", fact: "25岁" }] : [])] };
    else if (stage === "scope") result = { decisions: input.candidates.map((candidate: any) => ({ candidateId: candidate.candidateId, retain: true })) };
    else if (stage === "match") result = { mode: "new", references: [] };
    else result = { describe: "自然眉眼，黑色长发，白色衬衫搭灰色长裤与黑色平底鞋", visualDesign: {
      ...validVisual, ...(provideInvalidCard ? cause === "missing_clothing" ? { clothing: "" } : { body: "成年自然体态" } : {}),
    }, scriptFacts: input.verifiedFacts, conflicts: [], characterDefinition: "女性，黑色长发，现代日常人物" };
    try {
      await request.tools.resultTool.execute(result, {});
      return { finishReason: "tool-calls" };
    } catch (error) { return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] }; }
  };
  const checkpointOptions = { projectId: 7, scriptIds: [1], signature: { content, visual: validVisual, model: "memory-test" } };
  const run = async (checkpoint: Awaited<ReturnType<typeof createAssetExtractionCheckpoint>>) => extractScriptAssets({ db, invoke,
    system: "按照明确事实生成完整角色卡，未知年龄不默认成年", checkpoint,
    characterCards: { artStyle: "realistic_3d_anime", ownerId: 1 } },
  { projectId: 7, scriptIds: [1], updateExistingDescriptions: true });
  return { db, before, calls, initialCardCount, checkpointOptions, run, useValidCard: () => { provideInvalidCard = false; } };
}

for (const cause of ["missing_clothing", "unknown_adult"] as const) {
  test(`${cause}: semantic-invalid final cards are not cached, and retry resumes facts and matching then generates only the card`, async t => {
    const f = await fixture(t, cause), first = await createAssetExtractionCheckpoint(f.db, f.checkpointOptions);
    await assert.rejects(f.run(first), /完整的面部|明确年龄|有效的资产结果/);
    if (cause === "unknown_adult") {
      // The old process stopped before its catch handler marked the run failed.
      assert.equal(await recoverStaleAssetExtractionRuns(f.db), 1);
    } else await first.fail("角色卡校验失败");
    assert.deepEqual(f.calls, ["discovery", "facts", "scope", "match", "final", "final"], "invalid card attempts remain bounded");
    assert.equal((await f.db("o_assetExtractionStep").where({ stage: "生成角色卡" })).length, 0, "a card rejected by save validation must not become a successful checkpoint");
    assert.equal((await f.db("o_assetExtractionStep")).length, 4, "successful discovery, facts, scope audit and match remain reusable");
    assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), f.before);
    assert.equal((await f.db("o_characterCard")).length, f.initialCardCount);

    f.useValidCard(); f.calls.length = 0;
    const resumed = await createAssetExtractionCheckpoint(f.db, f.checkpointOptions);
    assert.equal(resumed.runId, first.runId);
    await f.run(resumed); await resumed.complete();
    assert.deepEqual(f.calls, ["final"], "retry must call only the previously invalid card step");
    const saved = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal(saved.imageId, 40); assert.equal(saved.prompt, f.before.prompt);
    assert.equal((await f.db("o_characterCard")).length, f.initialCardCount + 1);
    assert.equal((await f.db("o_assetExtractionStep").where({ stage: "生成角色卡" })).length, 1);
    assert.equal((await f.db("o_assetExtractionRun").where({ runId: resumed.runId }).first()).status, "completed");
  });
}
