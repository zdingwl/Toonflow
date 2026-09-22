import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { commitStoryboardTableOutput, extractStoryboardTable } from "../src/agents/productionAgent/storyboardTable";
import { storyboardSceneHash, reviseStoryboardScene } from "../src/agents/productionAgent/storyboardRevision";
import { readStoryboardProgress } from "../src/agents/productionAgent/storyboardProgress";

const sceneText = (number: number, duration: number) => `## 场${number}：场景\n### 片段一（约${duration}s）\n| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |\n|---|---|---|---|---|---|---|\n| 1 | 艾娃抬头 | ${duration} | 近景 | 固定 |  | 水声 |`;

async function setup() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_script", (t) => {
    t.integer("id").primary(); t.integer("projectId"); t.text("content");
  });
  await db.schema.createTable("o_agentWorkData", (t) => {
    t.increments("id").primary(); t.integer("projectId"); t.integer("episodesId"); t.string("key"); t.text("data");
  });
  await db("o_script").insert({ id: 2, projectId: 7, content: "场1：测试\n场2：测试" });
  for (const scene of [1, 2]) {
    await commitStoryboardTableOutput(db, 7, 2,
      extractStoryboardTable(`<storyboardTable scene="${scene}" total="2" task="storyboard_run_01">${sceneText(scene, 2)}</storyboardTable>`));
  }
  return db;
}

async function stored(db: ReturnType<typeof knex>) {
  const row = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first();
  return JSON.parse(row.data);
}

test("修订已存场次，事务提交后读回一致，保留其他场次和旧稿", async () => {
  const db = await setup();
  try {
    const original = await stored(db);
    const oldScene = original.storyboardTableProgress.scenes["1"];
    const before = await readStoryboardProgress(db, 7, 2);
    const result = await reviseStoryboardScene(db, {
      projectId: 7, episodesId: 2, scene: 1, taskId: before.taskId!,
      expectedRevision: before.revision, expectedSceneHash: storyboardSceneHash(oldScene),
      revisedScene: sceneText(1, 3), reason: "调整第一场镜头时长",
    });
    assert.equal(result.changed, true);
    assert.equal(result.revision, before.revision + 1);
    assert.equal(result.coverageVerified, false);
    const saved = await stored(db);
    assert.equal(saved.storyboardTableProgress.scenes["1"], sceneText(1, 3));
    assert.equal(saved.storyboardTableProgress.scenes["2"], original.storyboardTableProgress.scenes["2"]);
    assert.equal(saved.storyboardRevisionHistory.length, 1);
    assert.equal(saved.storyboardRevisionHistory[0].original, oldScene);
    assert.equal(saved.storyboardTable, result.storyboardTable);
    const after = await readStoryboardProgress(db, 7, 2);
    assert.equal(after.valid, true);
    assert.equal(after.complete, true);
  } finally { await db.destroy(); }
});

test("旧修订版本和旧场次哈希不能覆盖现有分镜", async () => {
  const db = await setup();
  try {
    const before = await stored(db);
    const req = {
      projectId: 7, episodesId: 2, scene: 1, taskId: "storyboard_run_01",
      expectedRevision: before.storyboardTableProgress.revision,
      expectedSceneHash: storyboardSceneHash(before.storyboardTableProgress.scenes["1"]),
      revisedScene: sceneText(1, 3), reason: "更改节奏",
    };
    await reviseStoryboardScene(db, req);
    await assert.rejects(() => reviseStoryboardScene(db, { ...req, revisedScene: sceneText(1, 4) }), /修订版本已经变化/);
    await assert.rejects(() => reviseStoryboardScene(db, {
      ...req, expectedRevision: req.expectedRevision + 1, expectedSceneHash: "0".repeat(64),
    }), /原场次已变化/);
    const after = await stored(db);
    assert.equal(after.storyboardTableProgress.scenes["1"], sceneText(1, 3));
    assert.equal(after.storyboardRevisionHistory.length, 1);
  } finally { await db.destroy(); }
});

test("非法或截断的场次修订不修改数据库", async () => {
  const db = await setup();
  try {
    const before = await stored(db);
    await assert.rejects(() => reviseStoryboardScene(db, {
      projectId: 7, episodesId: 2, scene: 1, taskId: "storyboard_run_01",
      expectedRevision: before.storyboardTableProgress.revision,
      expectedSceneHash: storyboardSceneHash(before.storyboardTableProgress.scenes["1"]),
      revisedScene: "## 场1：仅有标题", reason: "错误输出",
    }), /没有任何分镜片段/);
    assert.deepEqual(await stored(db), before);
  } finally { await db.destroy(); }
});
