import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { commitStoryboardTableOutput, extractStoryboardTable } from "../src/agents/productionAgent/storyboardTable";
import { readStoryboardProgress } from "../src/agents/productionAgent/storyboardProgress";
import { runStoryboardTask } from "../src/agents/productionAgent/storyboardTaskRunner";
import { validateStoryboardScene } from "../src/agents/productionAgent/storyboardValidator";

async function makeDb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_script", (t) => {
    t.integer("id").primary(); t.integer("projectId"); t.text("content");
  });
  await db.schema.createTable("o_agentWorkData", (t) => {
    t.increments("id").primary(); t.integer("projectId"); t.integer("episodesId"); t.string("key"); t.text("data");
  });
  await db("o_script").insert({ id: 2, projectId: 7, content: "场1：第一场\n她说：『你好』\n场2：第二场\n场3：第三场" });
  return db;
}

function sceneXml(index: number, total: number, taskId: string) {
  return extractStoryboardTable(`<storyboardTable scene="${index}" total="${total}" task="${taskId}">## 场${index}：第${index}场\n内容${index}</storyboardTable>`);
}

test("已有第1场按事务进度继续到第3场，绝不重复生成已保存内容", async () => {
  const db = await makeDb();
  try {
    const taskId = "storyboard_run_01";
    await commitStoryboardTableOutput(db, 7, 2, sceneXml(1, 3, taskId));
    const before = await readStoryboardProgress(db, 7, 2);
    assert.deepEqual(before.savedScenes, [1]);
    assert.deepEqual(before.missingScenes, [2, 3]);
    assert.equal(before.nextScene, 2);
    const requested: number[] = [];
    const final = await runStoryboardTask({
      db, projectId: 7, episodesId: 2, total: 3,
      generate: async ({ scene, taskId: id, total }) => {
        requested.push(scene);
        await commitStoryboardTableOutput(db, 7, 2, sceneXml(scene, total, id));
      },
    });
    assert.deepEqual(requested, [2, 3]);
    assert.deepEqual(final.savedScenes, [1, 2, 3]);
    assert.deepEqual(final.missingScenes, []);
    assert.equal(final.complete, true);
    assert.equal(final.taskId, taskId);
  } finally { await db.destroy(); }
});

test("空工作区可以启动新逐场任务，单场请求不会误报整集完成", async () => {
  const db = await makeDb();
  try {
    const first = await runStoryboardTask({
      db, projectId: 7, episodesId: 2, total: 3, maxScenes: 1,
      generate: async ({ scene, total, taskId }) => {
        assert.equal(scene, 1);
        await commitStoryboardTableOutput(db, 7, 2, sceneXml(scene, total, taskId));
      },
    });
    assert.equal(first.complete, false);
    assert.deepEqual(first.missingScenes, [2, 3]);
    const after = await readStoryboardProgress(db, 7, 2);
    assert.equal(after.taskId, first.taskId);
    assert.match(first.taskId ?? "", /^storyboard_[a-f0-9]{32}$/);
  } finally { await db.destroy(); }
});

test("正文和进度不一致时拒绝自动恢复且保留已存内容", async () => {
  const db = await makeDb();
  try {
    await commitStoryboardTableOutput(db, 7, 2, sceneXml(1, 3, "storyboard_run_01"));
    const row = await db("o_agentWorkData").where({ projectId: 7, episodesId: 2, key: "productionAgent" }).first();
    const data = JSON.parse(row.data);
    await db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify({ ...data, storyboardTable: "## 场1：人工修订" }) });
    const state = await readStoryboardProgress(db, 7, 2);
    assert.equal(state.valid, false);
    assert.equal(state.conflict?.code, "TABLE_PROGRESS_MISMATCH");
    await assert.rejects(() => runStoryboardTask({ db, projectId: 7, episodesId: 2, total: 3, generate: async () => { throw new Error("不得执行"); } }), /分镜正文与进度记录不一致/);
    const rowAfter = await db("o_agentWorkData").where({ id: row.id }).first();
    assert.equal(JSON.parse(rowAfter.data).storyboardTable, "## 场1：人工修订");
  } finally { await db.destroy(); }
});

test("场次结构缺失及原台词遗漏不会通过内容核验", () => {
  const source = "场1：测试\n艾娃说：『你好』";
  const incomplete = validateStoryboardScene(1, "## 场1：测试\n### 片段一（约5s）\n| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |\n|---|---|---|---|---|---|---|\n| 1 | 她回头 | 5 | 近景 | 固定 | 无 | 环境音 |", source);
  assert.equal(incomplete.valid, false);
  assert.match(incomplete.errors.join("；"), /遗漏原剧本台词/);
  const complete = validateStoryboardScene(1, "## 场1：测试\n### 片段一（约5s）\n| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |\n|---|---|---|---|---|---|---|\n| 1 | 她回头 | 5 | 近景 | 固定 | 艾娃：『你好』 | 环境音 |", source);
  assert.equal(complete.valid, true);
  assert.equal(complete.coverageVerified, true);
});
