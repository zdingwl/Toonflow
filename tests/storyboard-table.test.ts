import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import {
  commitStoryboardTableOutput,
  extractStoryboardTable,
  readStoryboardTableSnapshot,
  reconcileStoryboardTableOutput,
} from "../src/agents/productionAgent/storyboardTable";

async function createDb() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_script", (t) => {
    t.integer("id").primary(); t.integer("projectId"); t.text("content");
  });
  await db.schema.createTable("o_agentWorkData", (t) => {
    t.increments("id").primary(); t.integer("projectId"); t.integer("episodesId"); t.string("key"); t.text("data");
  });
  await db("o_script").insert({ id: 2, projectId: 7, content: "剧本" });
  return db;
}

test("分镜表 XML 只接受完整整表或完整单场协议", () => {
  assert.deepEqual(
    extractStoryboardTable("<storyboardTable>## 场1：A\n内容\n\n## 场2：B\n内容</storyboardTable>"),
    { mode: "full", content: "## 场1：A\n内容\n\n## 场2：B\n内容", scenes: [1, 2] },
  );
  assert.deepEqual(
    extractStoryboardTable('<storyboardTable scene="2" total="3" task="storyboard_run_01">## 场2：B\n内容</storyboardTable>'),
    { mode: "scene", content: "## 场2：B\n内容", scene: 2, total: 3, taskId: "storyboard_run_01" },
  );
  assert.throws(() => extractStoryboardTable("<storyboardTable>未闭合"));
  assert.throws(() => extractStoryboardTable("<storyboardTable>## 场2：跳号</storyboardTable>"), /连续编号/);
  assert.throws(() => extractStoryboardTable('<storyboardTable scene="1">## 场1：A</storyboardTable>'), /同时提供/);
});

test("逐场分镜由后端事务合并、读回并支持幂等重试", async () => {
  const db = await createDb();
  try {
    const first = extractStoryboardTable('<storyboardTable scene="1" total="2" task="storyboard_run_01">## 场1：A\n内容1</storyboardTable>');
    const second = extractStoryboardTable('<storyboardTable scene="2" total="2" task="storyboard_run_01">## 场2：B\n内容2</storyboardTable>');
    const saved1 = await commitStoryboardTableOutput(db, 7, 2, first);
    assert.deepEqual(saved1.savedScenes, [1]);
    assert.deepEqual(saved1.missingScenes, [2]);
    const retry = await commitStoryboardTableOutput(db, 7, 2, first);
    assert.deepEqual(retry.savedScenes, [1]);
    const saved2 = await commitStoryboardTableOutput(db, 7, 2, second);
    assert.deepEqual(saved2.savedScenes, [1, 2]);
    assert.deepEqual(saved2.missingScenes, []);
    const snapshot = await readStoryboardTableSnapshot(db, 7, 2);
    assert.equal(snapshot.storyboardTable, "## 场1：A\n内容1\n\n## 场2：B\n内容2");
    assert.equal(snapshot.storyboardTableProgress?.complete, true);
    assert.equal(
      await reconcileStoryboardTableOutput(db, 7, 2, '<storyboardTable scene="2" total="2" task="storyboard_run_01">## 场2：B\n内容2</storyboardTable>'),
      "storyboardTable:7:2:scene:2",
    );
  } finally {
    await db.destroy();
  }
});

test("整表提交使用乐观锁，禁止覆盖生成期间的人工修改", async () => {
  const db = await createDb();
  try {
    const expected = await readStoryboardTableSnapshot(db, 7, 2);
    const parsed = extractStoryboardTable("<storyboardTable>## 场1：A\n完整</storyboardTable>");
    await commitStoryboardTableOutput(db, 7, 2, parsed, expected);
    assert.equal(
      await reconcileStoryboardTableOutput(db, 7, 2, "<storyboardTable>## 场1：A\n完整</storyboardTable>"),
      "storyboardTable:7:2:full",
    );

    const stale = await readStoryboardTableSnapshot(db, 7, 2);
    const row = await db("o_agentWorkData").first();
    const data = JSON.parse(row.data);
    await db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify({ ...data, storyboardTable: "## 场1：人工\n改动" }) });
    await assert.rejects(
      () => commitStoryboardTableOutput(
        db,
        7,
        2,
        extractStoryboardTable("<storyboardTable>## 场1：A\n新版</storyboardTable>"),
        stale,
      ),
      /已被修改/,
    );
  } finally {
    await db.destroy();
  }
});
