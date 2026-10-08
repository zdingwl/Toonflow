import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { initStudioTables } from "../src/utils/importStudioQueue";
import {
  initImportStudioNative,
  createImportProject,
  materializeImportBatch,
} from "../src/utils/importStudioNative";
import { loadH3ReferencePlan, resolveH3ReferencePlan } from "../src/utils/h3ReferencePlan";
async function fixture() {
  const db = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  const schema: Record<string, string[]> = {
    o_project: [
      "name",
      "intro",
      "projectType",
      "type",
      "artStyle",
      "videoRatio",
      "imageQuality",
      "imageModel",
      "videoModel",
      "mode",
      "directorManual",
      "userId",
      "createTime",
    ],
    o_script: ["projectId", "name", "content", "createTime"],
    o_assets: [
      "projectId",
      "scriptId",
      "name",
      "type",
      "describe",
      "prompt",
      "promptState",
      "assetsId",
      "descriptionVersion",
      "promptDescriptionVersion",
      "imageDescriptionVersion",
      "referenceLayout",
      "designStatus",
      "imageId",
    ],
    o_image: ["assetsId", "filePath", "type", "state", "model", "errorReason"],
    o_videoTrack: [
      "projectId",
      "scriptId",
      "prompt",
      "duration",
      "state",
      "archived",
      "videoId",
    ],
    o_storyboard: [
      "projectId",
      "scriptId",
      "trackId",
      "prompt",
      "videoDesc",
      "duration",
      "index",
      "shouldGenerateImage",
      "createTime",
    ],
    o_video: [
      "projectId",
      "scriptId",
      "videoTrackId",
      "filePath",
      "state",
      "time",
    ],
    o_scriptAssets: ["scriptId", "assetId"],
    o_assets2Storyboard: ["storyboardId", "assetId"],
  };
  for (const [name, cols] of Object.entries(schema))
    await db.schema.createTable(name, (t) => {
      t.increments("id");
      for (const col of cols)
        /Id$|^userId$/.test(col) ? t.integer(col) : t.text(col);
    });
  await initStudioTables(db);
  return db;
}
test("legacy migration preserves completed media, whole-image Picture order and is idempotent", async () => {
  const db = await fixture();
  try {
    for (const kind of ["image", "video"])
      await db("o_importBatch").insert({
        id: kind,
        kind,
        name: kind,
        fingerprint: kind,
        createdAt: 1,
        assets:
          kind === "image"
            ? "[]"
            : JSON.stringify([
                { id: "a", name: "A", type: "role", path: "/a.png" },
                { id: "b", name: "B", type: "scene", path: "/b.png" },
              ]),
      });
    await db("o_importItem").insert([
      {
        id: "image",
        batchId: "image",
        position: 0,
        state: "succeeded",
        output: "/paid.png",
        model: "local:flux",
        spec: JSON.stringify({
          id: "i",
          name: "I",
          type: "scene",
          prompt: "room",
        }),
      },
      {
        id: "video",
        batchId: "video",
        position: 0,
        state: "succeeded",
        output: "/paid.mp4",
        spec: JSON.stringify({
          id: "v",
          name: "V",
          prompt: "<Picture 1> and <Picture 2>",
          assets: ["b", "a"],
          duration: 5,
          aspectRatio: "9:16",
          resolution: "768p",
          audio: false,
        }),
      },
    ]);
    await initImportStudioNative(db);
    await initImportStudioNative(db);
    assert.equal((await db("o_project")).length, 2);
    assert.equal((await db("o_script")).length, 2);
    assert.equal((await db("o_video")).length, 1);
    const imageItem = await db("o_importItem").where({ id: "image" }).first();
    const asset = await db("o_assets").where({ id: imageItem.assetId }).first();
    assert.equal(
      (await db("o_image").where({ id: asset.imageId }).first()).filePath,
      "/paid.png",
    );
    const videoItem = await db("o_importItem").where({ id: "video" }).first();
    const track = await db("o_videoTrack")
      .where({ id: videoItem.trackId })
      .first();
    assert.equal(
      (await db("o_video").where({ id: track.videoId }).first()).filePath,
      "/paid.mp4",
    );
    const plan = await loadH3ReferencePlan(db, track.id, track.prompt);
    assert.deepEqual(
      plan?.slots.map((s) => s.path),
      ["/b.png", "/a.png"],
    );
    assert.ok(plan?.slots.every((s) => !s.kind));
  } finally {
    await db.destroy();
  }
});
test("creatures use native tool generation while source types and prompts survive import", async () => {
  const db = await fixture();
  try {
    await initImportStudioNative(db);
    const projectId = await createImportProject(db, "image", { name: "creatures" });
    const batch = { id: "creatures", kind: "image", name: "creatures", assets: "[]", createdAt: 1, fingerprint: "creatures" };
    const spec = { id: "shark", name: "Shark", type: "creature", prompt: "A realistic shark", aspectRatio: "4:3" };
    await db("o_importBatch").insert(batch);
    await db("o_importItem").insert({ id: "shark", batchId: batch.id, position: 0, state: "succeeded", output: "/shark.png", spec: JSON.stringify(spec) });
    await db.transaction(trx => materializeImportBatch(trx, batch, projectId));
    const item = await db("o_importItem").where({ id: "shark" }).first();
    const asset = await db("o_assets").where({ id: item.assetId }).first();
    assert.deepEqual(JSON.parse(item.spec), spec);
    assert.equal(asset.type, "tool");
    assert.equal(asset.prompt, spec.prompt);
    assert.equal(asset.referenceLayout, null);
    assert.equal((await db("o_image").where({ id: asset.imageId }).first()).type, "tool");
  } finally { await db.destroy(); }
});

test("video creature imports resolve native H3 references without changing Picture order or starting generation", async () => {
  const db = await fixture();
  try {
    await initImportStudioNative(db);
    const projectId = await createImportProject(db, "video", { name: "creature video" });
    const assets = [
      { id: "hero", name: "人物四视图", type: "role", path: "/hero.png" },
      { id: "shark", name: "变异鲨", type: "creature", path: "/shark.png" },
    ];
    const batch = { id: "creature-video", kind: "video", name: "creature video", assets: JSON.stringify(assets), createdAt: 1, fingerprint: "creature-video" };
    const spec = { id: "shot", name: "遭遇海兽", prompt: "<Picture 1> 的海兽靠近 <Picture 2> 的人物。", assets: ["shark", "hero"], duration: 6, aspectRatio: "16:9", resolution: "768p", audio: true };
    await db("o_importBatch").insert(batch);
    await db("o_importItem").insert({ id: "shot", batchId: batch.id, position: 0, state: "ready", spec: JSON.stringify(spec) });
    await db.transaction(trx => materializeImportBatch(trx, batch, projectId));
    const item = await db("o_importItem").where({ id: "shot" }).first();
    assert.deepEqual(JSON.parse(item.spec), spec);
    assert.deepEqual(JSON.parse((await db("o_importBatch").where({ id: batch.id }).first()).assets), assets);
    const track = await db("o_videoTrack").where({ id: item.trackId }).first();
    assert.equal(track.prompt, spec.prompt);
    const plan = await loadH3ReferencePlan(db, track.id, track.prompt);
    assert.ok(plan);
    const native = await db("o_assets as a").join("o_image as i", "a.imageId", "i.id").where("a.projectId", projectId).select("a.id", "a.name", "a.type", "i.filePath", "i.type as imageType").orderBy("a.id");
    assert.deepEqual(native.map(a => [a.type, a.imageType]), [["role", "role"], ["tool", "tool"]]);
    const references = resolveH3ReferencePlan(native, plan);
    assert.deepEqual(references.map(r => [r.path, r.assetType]), [["/shark.png", "tool"], ["/hero.png", "role"]]);
    assert.ok(plan.slots.every(s => !s.kind));
    assert.equal((await db("o_video")).length, 0);
  } finally { await db.destroy(); }
});

test("new imports are native, isolated across projects, and rollback on invalid binding", async () => {
  const db = await fixture();
  try {
    await initImportStudioNative(db);
    const p1 = await createImportProject(db, "image", { name: "one" }),
      p2 = await createImportProject(db, "image", { name: "two" });
    for (const [id, projectId] of [
      ["one", p1],
      ["two", p2],
    ] as const) {
      const batch = {
        id,
        kind: "image",
        name: id,
        assets: "[]",
        createdAt: 1,
        fingerprint: id,
      };
      await db("o_importBatch").insert(batch);
      await db("o_importItem").insert({
        id,
        batchId: id,
        position: 0,
        state: "ready",
        spec: JSON.stringify({
          id: "same",
          name: "same",
          type: "scene",
          prompt: "room",
        }),
      });
      await db.transaction((trx) =>
        materializeImportBatch(trx, batch, projectId),
      );
    }
    assert.equal((await db("o_assets").where({ projectId: p1 })).length, 1);
    assert.equal((await db("o_assets").where({ projectId: p2 })).length, 1);
    await db("o_importItem").insert({
      id: "bad",
      batchId: "bad",
      position: 0,
      state: "ready",
      spec: JSON.stringify({
        name: "bad",
        prompt: "x",
        duration: 5,
        assets: ["missing"],
      }),
    });
    await assert.rejects(
      db.transaction((trx) =>
        materializeImportBatch(
          trx,
          { id: "bad", kind: "video", name: "bad", assets: "[]", createdAt: 1 },
          p1,
        ),
      ),
      /missing/,
    );
    assert.equal((await db("o_videoTrack")).length, 0);
    assert.equal((await db("o_script")).length, 2);
  } finally {
    await db.destroy();
  }
});
