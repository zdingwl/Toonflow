import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import {
  extractScriptItem,
  extractScriptWorkspaceField,
  saveScriptItem,
  saveScriptWorkspaceField,
  snapshotProjectScripts,
} from "../src/agents/scriptAgent/workspace";

async function createDb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_project", (t) => { t.integer("id").primary(); });
  await db.schema.createTable("o_agentWorkData", (t) => {
    t.increments("id").primary(); t.integer("projectId"); t.string("key"); t.text("data");
  });
  await db.schema.createTable("o_script", (t) => {
    t.increments("id").primary(); t.integer("projectId"); t.string("name"); t.text("content");
  });
  await db("o_project").insert({ id: 1 });
  return db;
}

test("剧本 Agent XML 结果必须完整且唯一", () => {
  assert.equal(extractScriptWorkspaceField("<storySkeleton>骨架</storySkeleton>", "storySkeleton"), "骨架");
  assert.equal(extractScriptWorkspaceField("<adaptationStrategy>策略</adaptationStrategy>", "adaptationStrategy"), "策略");
  assert.deepEqual(extractScriptItem('<scriptItem name="第1集">正文</scriptItem>'), { name: "第1集", content: "正文" });
  assert.throws(() => extractScriptItem('<scriptItem name="第1集">未闭合'));
  assert.throws(() => extractScriptItem("<scriptItem>正文</scriptItem>"), /缺少/);
  assert.throws(() => extractScriptItem('<scriptItem name="A">一</scriptItem><scriptItem name="B">二</scriptItem>'), /只能有一份/);
});

test("故事骨架与改编策略使用乐观锁并读回校验", async () => {
  const db = await createDb();
  try {
    await saveScriptWorkspaceField(db, 1, "storySkeleton", "骨架A", "");
    await saveScriptWorkspaceField(db, 1, "adaptationStrategy", "策略A", "");
    const row = await db("o_agentWorkData").where({ projectId: 1, key: "scriptAgent" }).first();
    const data = JSON.parse(row.data);
    assert.equal(data.storySkeleton, "骨架A");
    assert.equal(data.adaptationStrategy, "策略A");
    await assert.rejects(() => saveScriptWorkspaceField(db, 1, "storySkeleton", "覆盖", ""), /已被修改/);
  } finally {
    await db.destroy();
  }
});

test("单集剧本提交区分新建与更新，并拒绝覆盖生成期间的人工修改", async () => {
  const db = await createDb();
  try {
    const id = await saveScriptItem(db, 1, { name: "第1集", content: "版本A" }, null);
    assert.ok(id > 0);
    const snapshot = await snapshotProjectScripts(db, 1);
    assert.equal(snapshot.get("第1集"), "版本A");
    await saveScriptItem(db, 1, { name: "第1集", content: "版本B" }, "版本A");
    await db("o_script").where({ projectId: 1, name: "第1集" }).update({ content: "人工修改" });
    await assert.rejects(() => saveScriptItem(db, 1, { name: "第1集", content: "版本C" }, "版本B"), /已被修改/);
    await assert.rejects(() => saveScriptItem(db, 1, { name: "第1集", content: "重复新建" }, null), /已被创建/);
  } finally {
    await db.destroy();
  }
});
