import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { commitStoryboardTableOutput, extractStoryboardTable } from "../src/agents/productionAgent/storyboardTable";
import { isExplicitStoryboardRebuildRequest, prepareAuthorizedStoryboardRebuild, storyboardPlanSceneCount } from "../src/agents/productionAgent/storyboardRebuildDispatch";
import { readStoryboardProgress } from "../src/agents/productionAgent/storyboardProgress";

const firstPlan = "共规划2场\n场1：旧开场\n场2：旧结尾";
const latestPlan = "共规划2场\n场1：新开场\n场2：新结尾";
const text = (n: number) => `## 场${n}：测试\n### 片段一（约2s）\n| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |\n|---|---|---|---|---|---|---|\n| 1 | 第${n}场镜头 | 2 | 近景 | 固定 |  | 水声 |`;
const sceneXml = (n: number, taskId: string) => extractStoryboardTable(`<storyboardTable scene="${n}" total="2" task="${taskId}">${text(n)}</storyboardTable>`);

async function fixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_script", (t) => { t.integer("id").primary(); t.integer("projectId"); t.text("content"); });
  await db.schema.createTable("o_agentWorkData", (t) => { t.increments("id").primary(); t.integer("projectId"); t.integer("episodesId"); t.string("key"); t.text("data"); });
  await db("o_script").insert({ id: 2, projectId: 7, content: "场1：剧本\n场2：剧本" });
  await db("o_agentWorkData").insert({ projectId: 7, episodesId: 2, key: "productionAgent", data: JSON.stringify({ scriptPlan: firstPlan, storyboardTable: "" }) });
  for (const n of [1, 2]) await commitStoryboardTableOutput(db, 7, 2, sceneXml(n, "storyboard_run_01"));
  const original = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first();
  await db("o_agentWorkData").where({ id: original.id }).update({ data: JSON.stringify({ ...JSON.parse(original.data), scriptPlan: latestPlan }) });
  return db;
}
const request = "以最新导演计划重新构建全部分镜";

test("只识别明确的整集重建命令，普通制作、继续、修订不触发重建", () => {
  for (const command of ["重新构建", "重新生成分镜", "按最新导演计划重新构建全部七场分镜", request]) {
    assert.equal(isExplicitStoryboardRebuildRequest(command), true, command);
  }
  for (const command of ["开始制作视频", "是", "继续", "按建议修复", "修订第1场", "重新审核", "重新生成分镜图"]) {
    assert.equal(isExplicitStoryboardRebuildRequest(command), false, command);
  }
  assert.equal(storyboardPlanSceneCount(latestPlan), 2);
  assert.throws(() => storyboardPlanSceneCount("共规划7场\n场1：开场\n场2：结尾"), /场次数/);
});

test("计划冲突旧七场等价场次不能误报零场：归档旧稿再直接准备新任务", async () => {
  const db = await fixture();
  try {
    const before = await readStoryboardProgress(db, 7, 2);
    assert.equal(before.conflict?.code, "PLAN_CHANGED");
    assert.deepEqual(before.savedScenes, [1, 2]);
    const fresh = await prepareAuthorizedStoryboardRebuild(db, 7, 2, request);
    assert.equal(fresh.newlyInitialized, true);
    assert.equal(fresh.archivedSceneCount, 2);
    assert.deepEqual(fresh.archivedSavedScenes, [1, 2]);
    assert.notEqual(fresh.taskId, "storyboard_run_01");
    const after = await readStoryboardProgress(db, 7, 2);
    assert.equal(after.valid, true);
    assert.equal(after.taskId, fresh.taskId);
    assert.deepEqual(after.missingScenes, [1, 2]);
    const archived = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: `storyboardTaskArchive:${fresh.archiveId}` }).first();
    assert.ok(archived);
    assert.equal(JSON.parse(archived.data).previousProgress.scenes["2"], text(2));
    await assert.rejects(() => commitStoryboardTableOutput(db, 7, 2, sceneXml(1, "storyboard_run_01")), /任务标识/);
    await commitStoryboardTableOutput(db, 7, 2, sceneXml(1, fresh.taskId));
    const repeat = await prepareAuthorizedStoryboardRebuild(db, 7, 2, "重新构建");
    assert.equal(repeat.newlyInitialized, false);
    assert.equal(repeat.taskId, fresh.taskId);
    assert.equal(repeat.archivedSceneCount, 2);
    assert.deepEqual((await readStoryboardProgress(db, 7, 2)).savedScenes, [1]);
    await commitStoryboardTableOutput(db, 7, 2, sceneXml(2, fresh.taskId));
    assert.equal((await readStoryboardProgress(db, 7, 2)).complete, true);
    const completedRepeat = await prepareAuthorizedStoryboardRebuild(db, 7, 2, request);
    assert.equal(completedRepeat.taskId, fresh.taskId);
    assert.equal(completedRepeat.newlyInitialized, false);
  } finally { await db.destroy(); }
});

test("人工编辑冲突及无授权指令不得丢失旧任务", async () => {
  const db = await fixture();
  try {
    const row = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first();
    const old = JSON.parse(row.data);
    await assert.rejects(() => prepareAuthorizedStoryboardRebuild(db, 7, 2, "继续"), /明确/);
    assert.equal((await db("o_agentWorkData").where({ id: row.id }).first()).data, row.data);
    await db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify({ ...old, storyboardTable: old.storyboardTable + "\n手工追加" }) });
    await assert.rejects(() => prepareAuthorizedStoryboardRebuild(db, 7, 2, request), /一致性/);
    assert.equal((await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first()).data,
      JSON.stringify({ ...old, storyboardTable: old.storyboardTable + "\n手工追加" }));
  } finally { await db.destroy(); }
});

test("停止信号在写入前拒绝重建", async () => {
  const db = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => prepareAuthorizedStoryboardRebuild(db, 7, 2, request, controller.signal), /取消/);
    assert.equal((await readStoryboardProgress(db, 7, 2)).conflict?.code, "PLAN_CHANGED");
  } finally { await db.destroy(); }
});
