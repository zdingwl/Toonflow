import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { extractDirectorPlan, reconcileDirectorPlanOutput, saveDirectorPlan } from "../src/agents/productionAgent/directorPlan";
import { validateDirectorFacts } from "../src/agents/productionAgent/screenplay";

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


test("导演规划必须覆盖每个相邻场界的连续性契约", () => {
  const script = `场景一 外·甲板（0-5秒）
艾娃
回去。
场景二 水下（5-10秒）
艾娃
我要回去！
场景三 内·公寓（10-15秒）
艾娃
七十二小时。`;
  const plan = `| 场次 | 场景名 | 台词条数 | 台词字数 | 情绪浓度 | 情绪基调（含 X→Y） | 原剧本时段 | 制作预算（秒） |
|---|---|---:|---:|---:|---|---|---:|
| Sc1 | 甲板 | 1 | 2 | 8 | 求生 | 0-5秒 | 5 |
| Sc2 | 水下 | 1 | 4 | 9 | 濒死 | 5-10秒 | 5 |
| Sc3 | 公寓 | 1 | 5 | 7 | 决绝 | 10-15秒 | 5 |

| 场间 | continuity_mode | transition_type | 承接要求 | 可重置项 |
|---|---|---|---|---|
| Sc1 → Sc2 | PRESERVE | CONTINUOUS_ACTION | 坠落方向和人物姿态连续，水面保持在上方 | 无 |
| Sc2 → Sc3 | RESET | TIME_JUMP | 保留艾娃身份，重新建立公寓时空 | 时间、地点、即时姿态 |`;
  assert.deepEqual(validateDirectorFacts(script, plan), []);
  assert.match(validateDirectorFacts(script, plan.replace(/\| Sc1 → Sc2[^\n]+\n/, "")).join("；"), /完整列出全部2个/);
  assert.match(validateDirectorFacts(script, plan.replace("PRESERVE", "MAYBE")).join("；"), /continuity_mode/);
  assert.match(validateDirectorFacts(script, plan.replace("TIME_JUMP", "MONTAGE")).join("；"), /transition_type/);
});
