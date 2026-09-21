import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { extractDirectorPlan, saveDirectorPlan } from "../src/agents/productionAgent/directorPlan";

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
