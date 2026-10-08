import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { extractDirectorPlan, reconcileDirectorPlanOutput, saveDirectorPlan } from "../src/agents/productionAgent/directorPlan";

test("导演计划只有完整单份 XML 才可提交", () => {
  assert.equal(extractDirectorPlan("说明<scriptPlan>第一场\n第二场</scriptPlan>完成"), "第一场\n第二场");
  assert.throws(() => extractDirectorPlan("<scriptPlan>未闭合"));
  assert.throws(() => extractDirectorPlan("<scriptPlan> </scriptPlan>"));
  assert.throws(() => extractDirectorPlan("<scriptPlan>一</scriptPlan><scriptPlan>二</scriptPlan>"));
  assert.throws(() => extractDirectorPlan("<scriptPlan>一</scriptPlan><scriptPlan>截断"));
  assert.throws(() => extractDirectorPlan("</scriptPlan><scriptPlan>顺序错误"));
});

test("导演计划提交后读回，保留其他工作区字段并校验剧集归属", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_script", (t) => {
      t.integer("id").primary();
      t.integer("projectId");
      t.text("content");
    });
    await db.schema.createTable("o_agentWorkData", (t) => {
      t.increments("id").primary();
      t.integer("projectId");
      t.integer("episodesId");
      t.string("key");
      t.text("data");
      t.integer("createTime");
      t.integer("updateTime");
    });
    await db("o_script").insert({ id: 1, projectId: 12, content: "剧本" });
    await saveDirectorPlan(db, 12, 1, "计划 A", "");
    const before = JSON.parse((await db("o_agentWorkData").first()).data);
    assert.equal(before.script, "剧本");
    await db("o_agentWorkData").update({ data: JSON.stringify({ ...before, storyboardTable: "已有分镜" }) });
    await saveDirectorPlan(db, 12, 1, "计划 B", "计划 A");
    const after = JSON.parse((await db("o_agentWorkData").first()).data);
    assert.equal(after.scriptPlan, "计划 B");
    assert.equal(after.storyboardTable, "已有分镜");
    assert.equal(await db("o_agentWorkData").count({ count: "*" }).first().then((row) => Number(row?.count)), 1);
    await assert.rejects(() => saveDirectorPlan(db, 12, 1, "覆盖", "计划 A"), /已被修改/);
    await assert.rejects(() => saveDirectorPlan(db, 99, 1, "非法计划", ""));
  } finally {
    await db.destroy();
  }
});


test("导演计划恢复核对只接受已经提交到当前剧集的数据", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_script", (t) => {
      t.integer("id").primary(); t.integer("projectId"); t.text("content");
    });
    await db.schema.createTable("o_agentWorkData", (t) => {
      t.increments("id").primary(); t.integer("projectId"); t.integer("episodesId"); t.string("key"); t.text("data");
      t.integer("createTime"); t.integer("updateTime");
    });
    await db("o_script").insert({ id: 2, projectId: 7, content: "剧本" });
    await saveDirectorPlan(db, 7, 2, "计划A", "");
    assert.equal(
      await reconcileDirectorPlanOutput(db, 7, 2, "<scriptPlan>计划A</scriptPlan>"),
      "directorPlan:7:2",
    );
    assert.equal(
      await reconcileDirectorPlanOutput(db, 7, 2, "<scriptPlan>另一计划</scriptPlan>"),
      null,
    );
  } finally {
    await db.destroy();
  }
});

test("节拍未覆盖制作预算时拒绝整份计划，保留已有分镜和视频状态", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_script", t => { t.integer("id").primary(); t.integer("projectId"); t.text("content"); });
    await db.schema.createTable("o_agentWorkData", t => {
      t.increments("id").primary(); t.integer("projectId"); t.integer("episodesId"); t.string("key"); t.text("data");
      t.integer("createTime"); t.integer("updateTime");
    });
    await db("o_script").insert({ id: 1, projectId: 12, content: "场景一 内·屋（0–10秒）\n小林\n我回来了。" });
    const before = { scriptPlan: "已确认计划", storyboardTable: "已完成分镜", workbench: { videoList: [{ id: 19, state: "成功" }] } };
    await db("o_agentWorkData").insert({ projectId: 12, episodesId: 1, key: "productionAgent", data: JSON.stringify(before) });
    const plan = `| 场次 | 场景名 | 台词条数 | 台词字数 | 情绪浓度 | 情绪基调（含 X→Y） | 原剧本时段 | 制作预算（秒） |
|---|---|---|---|---|---|---|---|
| Sc1 | 内·屋 | 1 | 4 | 2 | 不安→安心 | 0–10秒 | 10 |
### 逐场导演设计
#### Sc1：内·屋
| 节拍 | 场内区间（秒） | 来源锚点 | 局势变化 | 表演 | 意图 |
|---|---|---|---|---|---|
| B1 | 50–60 | 我回来了。 | 归来 | 进屋 | 确认 |`;
    await assert.rejects(saveDirectorPlan(db, 12, 1, plan, "已确认计划"), /从0连续/);
    assert.deepEqual(JSON.parse((await db("o_agentWorkData").first()).data), before);
    await saveDirectorPlan(db, 12, 1, plan.replace("| B1 | 50–60", "| B1 | 0–10"), "已确认计划");
    const after = JSON.parse((await db("o_agentWorkData").first()).data);
    assert.equal(after.storyboardTable, before.storyboardTable);
    assert.deepEqual(after.workbench, before.workbench);
  } finally { await db.destroy(); }
});
