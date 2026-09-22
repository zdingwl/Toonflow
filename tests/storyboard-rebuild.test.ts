import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { commitStoryboardTableOutput, extractStoryboardTable } from "../src/agents/productionAgent/storyboardTable";
import { getStoryboardRebuildContext, rebuildStoryboardTask } from "../src/agents/productionAgent/storyboardRebuild";
import { hashStoryboardSource, readStoryboardProgress } from "../src/agents/productionAgent/storyboardProgress";

const oldPlan = "共规划2场\n场1：旧场景\n场2：旧结尾";
const newPlan = "共规划2场\n场1：新场景\n场2：新结尾";
const sceneText = (index: number) => `## 场${index}：测试\n### 片段一（约2s）\n| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |\n|---|---|---|---|---|---|---|\n| 1 | 第${index}场镜头 | 2 | 近景 | 固定 |  | 水声 |`;
const xml = (scene: number, taskId: string, content = sceneText(scene)) =>
  extractStoryboardTable(`<storyboardTable scene="${scene}" total="2" task="${taskId}">${content}</storyboardTable>`);

async function setup() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_script", (table) => {
    table.integer("id").primary(); table.integer("projectId"); table.text("content");
  });
  await db.schema.createTable("o_agentWorkData", (table) => {
    table.increments("id").primary(); table.integer("projectId"); table.integer("episodesId"); table.string("key"); table.text("data");
  });
  await db("o_script").insert({ id: 2, projectId: 7, content: "场1：原剧本\n场2：原剧本" });
  await db("o_agentWorkData").insert({ projectId: 7, episodesId: 2, key: "productionAgent", data: JSON.stringify({
    scriptPlan: oldPlan, storyboardTable: "", assets: [], storyboard: [],
  }) });
  const oldTaskId = "storyboard_run_01";
  await commitStoryboardTableOutput(db, 7, 2, xml(1, oldTaskId));
  await commitStoryboardTableOutput(db, 7, 2, xml(2, oldTaskId));
  const row = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first();
  await db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify({ ...JSON.parse(row.data), scriptPlan: newPlan }) });
  return db;
}
async function stored(db: ReturnType<typeof knex>) {
  const row = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first();
  return JSON.parse(row.data);
}
const request = { projectId: 7, episodesId: 2, expectedTaskId: "storyboard_run_01", expectedRevision: 2,
  expectedPlanHash: hashStoryboardSource(newPlan), total: 2, reason: "用户明确授权以最新导演计划重新构建全部分镜" };

test("PLAN_CHANGED 显示真实旧场次而不是误报保存0场", async () => {
  const db = await setup();
  try {
    const progress = await readStoryboardProgress(db, 7, 2);
    assert.equal(progress.valid, false);
    assert.equal(progress.conflict?.code, "PLAN_CHANGED");
    assert.equal(progress.revision, 2);
    assert.deepEqual(progress.savedScenes, [1, 2]);
    const context = await getStoryboardRebuildContext(db, 7, 2);
    assert.equal(context.actualSceneCount, 2);
    assert.deepEqual(context.actualSavedScenes, [1, 2]);
  } finally { await db.destroy(); }
});

test("明确重建先归档旧任务的全部场次，再创建绑定新计划的新task", async () => {
  const db = await setup();
  try {
    const old = await stored(db);
    const rebuilt = await rebuildStoryboardTask(db, request);
    assert.equal(rebuilt.archivedSceneCount, 2);
    assert.deepEqual(rebuilt.archivedSavedScenes, [1, 2]);
    assert.equal(rebuilt.revision, 0);
    assert.equal(rebuilt.nextScene, 1);
    assert.deepEqual(rebuilt.savedScenes, []);
    assert.notEqual(rebuilt.taskId, request.expectedTaskId);
    const data = await stored(db);
    assert.equal(data.storyboardTable, "");
    assert.equal(data.storyboardTableProgress.taskId, rebuilt.taskId);
    assert.equal(data.storyboardTaskArchives.length, 1);
    assert.equal(data.storyboardTaskArchives[0].previousTable, old.storyboardTable);
    assert.deepEqual(data.storyboardTaskArchives[0].previousProgress, old.storyboardTableProgress);
    const progress = await readStoryboardProgress(db, 7, 2);
    assert.equal(progress.valid, true);
    assert.deepEqual(progress.missingScenes, [1, 2]);
    await assert.rejects(() => commitStoryboardTableOutput(db, 7, 2, xml(1, request.expectedTaskId)), /任务标识/);
    await commitStoryboardTableOutput(db, 7, 2, xml(1, rebuilt.taskId));
    const latest = await stored(db);
    assert.equal(latest.storyboardTableProgress.scenes["1"], sceneText(1));
    assert.equal(latest.storyboardTaskArchives[0].previousTable, old.storyboardTable);
  } finally { await db.destroy(); }
});

test("旧版本、过期计划以及正文冲突均不可重建或丢失旧稿", async () => {
  const db = await setup();
  try {
    const original = await stored(db);
    await assert.rejects(() => rebuildStoryboardTask(db, { ...request, expectedRevision: 1 }), /版本已变化/);
    await assert.rejects(() => rebuildStoryboardTask(db, { ...request, expectedPlanHash: hashStoryboardSource(oldPlan) }), /已再次修改/);
    assert.deepEqual(await stored(db), original);
    const mismatch = { ...original, storyboardTable: original.storyboardTable + "\n人工修改" };
    const row = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first();
    await db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify(mismatch) });
    await assert.rejects(() => rebuildStoryboardTask(db, request), /正文与进度不一致/);
    assert.deepEqual(await stored(db), mismatch);
  } finally { await db.destroy(); }
});
