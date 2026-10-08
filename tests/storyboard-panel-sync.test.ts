import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { storyboardSegments, syncRevisedStoryboardPanels } from "../src/agents/productionAgent/storyboardPanelSync";
import { assertStoryboardPromptFresh } from "../src/utils/storyboardPromptFreshness";

const segment = (action: string) => `### 片段一（约5s）
**引用资产ID**：[1]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
| 1 | ${action} | 5 | 全景 | 固定 | 无台词 | 风声 |`;

test("片段正文不包含下一场场头，多场总表可与逐段面板精确对应", () => {
  const first = segment("走向入口"), second = segment("等待");
  const table = `## 场1：走廊 ｜ 参演角色：甲\n${first}\n\n## 场2：办公室 ｜ 参演角色：乙\n${second}`;
  assert.deepEqual(storyboardSegments(table), [first, second]);
});

test("多场修订能匹配首场已保存面板并保留下一场正文", async () => {
  const db = await setup();
  try {
    const prefix = "## 场1：船侧 ｜ 参演角色：甲\n";
    const later = `\n\n## 场2：船舱 ｜ 参演角色：乙\n${segment("等待")}`;
    const updated = await db.transaction(trx => syncRevisedStoryboardPanels(trx, 7, 1, { storyboard: [{ id: 2 }] },
      prefix + segment("站在栏杆旁") + later, prefix + segment("双手承重悬在船外") + later));
    assert.equal(updated[0].videoDesc, segment("双手承重悬在船外"));
    assert.equal((await db("o_storyboard").first()).duration, "5");
    assert.equal((await db("o_videoTrack").first()).selectVideoId, 9);
  } finally { await db.destroy(); }
});

async function setup() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_storyboard", t => { t.integer("id"); t.integer("projectId"); t.integer("scriptId"); t.integer("trackId"); t.text("videoDesc"); t.text("duration"); });
  await db.schema.createTable("o_assets2Storyboard", t => { t.integer("storyboardId"); t.integer("assetId"); });
  await db.schema.createTable("o_videoTrack", t => { t.integer("id"); t.integer("projectId"); t.integer("scriptId"); t.text("prompt"); t.text("state"); t.text("reason"); t.float("duration"); t.integer("selectVideoId"); });
  await db.schema.createTable("o_video", t => { t.integer("id"); t.text("state"); });
  await db.schema.createTable("o_videoPromptVariant", t => { t.integer("trackId"); t.text("prompt"); t.text("state"); t.text("reason"); });
  await db.schema.createTable("o_agentWorkData", t => { t.increments("id"); t.integer("projectId"); t.integer("episodesId"); t.text("key"); t.text("data"); });
  await db("o_storyboard").insert({ id: 2, projectId: 7, scriptId: 1, trackId: 20, videoDesc: segment("站在栏杆旁"), duration: "5" });
  await db("o_videoTrack").insert({ id: 20, projectId: 7, scriptId: 1, prompt: "old base", duration: 5, selectVideoId: 9 });
  await db("o_videoPromptVariant").insert({ trackId: 20, prompt: "old English" });
  await db("o_video").insert({ id: 9, state: "生成成功" });
  return db;
}

test("修订同步执行面板及工作区，旧提示词失效但付费视频和选中版本保留", async () => {
  const db = await setup();
  try {
    const updated = await db.transaction(trx => syncRevisedStoryboardPanels(trx, 7, 1, { storyboard: [{ id: 2, videoDesc: segment("站在栏杆旁") }] }, segment("站在栏杆旁"), segment("双手承重悬在船外")));
    assert.equal(updated[0].videoDesc, segment("双手承重悬在船外"));
    assert.equal((await db("o_storyboard").first()).videoDesc, updated[0].videoDesc);
    assert.equal((await db("o_videoTrack").first()).selectVideoId, 9);
    assert.equal((await db("o_video").first()).state, "生成成功");
    await assert.rejects(() => assertStoryboardPromptFresh(db, 7, 20, "old English"), /旧分镜/);
    await assertStoryboardPromptFresh(db, 7, 20, "new English");
    assert.equal((await db("o_videoPromptVariant").first()).prompt, "old English");
    assert.equal((await db("o_videoPromptVariant").first()).state, "未生成");
    assert.equal((await db("o_videoTrack").first()).prompt, null);
    assert.equal(JSON.parse((await db("o_agentWorkData").first()).data).history[0].basePrompt, "old base");
  } finally { await db.destroy(); }
});

test("独立修改的面板冲突时全部回滚，不覆盖新内容", async () => {
  const db = await setup();
  try {
    await db("o_storyboard").update({ videoDesc: segment("独立修订") });
    await assert.rejects(() => db.transaction(trx => syncRevisedStoryboardPanels(trx, 7, 1, { storyboard: [] }, segment("站在栏杆旁"), segment("悬挂"))), /独立修改/);
    assert.equal((await db("o_storyboard").first()).videoDesc, segment("独立修订"));
    assert.equal((await db("o_agentWorkData")).length, 0);
  } finally { await db.destroy(); }
});

test("面板已修好时只同步总表副本，不使已验证的新提示词失效", async () => {
  const db = await setup();
  try {
    await db("o_storyboard").update({ videoDesc: segment("悬挂") });
    const updated = await db.transaction(trx => syncRevisedStoryboardPanels(trx, 7, 1, { storyboard: [{ id: 2 }] }, segment("站在栏杆旁"), segment("悬挂")));
    assert.equal(updated[0].videoDesc, segment("悬挂"));
    assert.equal((await db("o_agentWorkData")).length, 0);
  } finally { await db.destroy(); }
});
