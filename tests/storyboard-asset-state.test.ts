import assert from "node:assert/strict";
import test from "node:test";
import knex from "knex";
import { storyboardRoleParentMap } from "../src/agents/productionAgent/storyboardContext";
import { validateStoryboardScene } from "../src/agents/productionAgent/storyboardValidator";
import { commitStoryboardTableOutput, extractStoryboardTable } from "../src/agents/productionAgent/storyboardTable";
import { reviseStoryboardScene, storyboardSceneHash } from "../src/agents/productionAgent/storyboardRevision";
import { readSupervisionSnapshot, supervisionDiagnostics, validateSupervisionReport } from "../src/agents/productionAgent/supervisionContext";

const assets = [
  { id: 1, type: "role", assetsId: null }, { id: 11, type: "role", assetsId: 1 }, { id: 12, type: "role", assetsId: 1 },
  { id: 2, type: "role", assetsId: null }, { id: 21, type: "role", assetsId: 2 },
  { id: 3, type: "scene", assetsId: null }, { id: 31, type: "scene", assetsId: 3 },
  { id: 4, type: "tool", assetsId: null }, { id: 41, type: "tool", assetsId: 4 },
];
function segment(ids: number[], seconds: number, number = 1) {
  return `### 片段${number}（约${seconds}s）
**引用资产ID**：[${ids.join(", ")}]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| ${number} | 环境中只有无具名背景群众；设备外后期叠层显示【后来】，未新增角色资产 | ${seconds} | 远景 | 固定 | 无台词 | 环境音 |`;
}
const board = (ids: number[]) => `## 场1：测试\n${segment(ids, 6)}`;
const splitBoard = `## 场1：测试\n${segment([11, 3], 3)}\n${segment([12, 3], 3, 2)}`;
const options = { targetDuration: 6, assetIds: assets.map(asset => asset.id), assetParentMap: storyboardRoleParentMap(assets) };

test("一个片段硬拒绝同角色主/衍生及两衍生，重复同ID和不同角色仍允许", () => {
  for (const ids of [[1, 11, 3], [11, 12, 3]]) {
    const result = validateStoryboardScene(1, board(ids), undefined, options);
    assert.equal(result.valid, false); assert.match(result.errors.join("；"), /同一角色父资产1的多套状态/);
  }
  assert.equal(validateStoryboardScene(1, board([11, 11, 21, 3]), undefined, options).valid, true);
  assert.equal(validateStoryboardScene(1, board([11, 21, 3, 31, 4, 41]), undefined, options).valid, true);
  assert.match(validateStoryboardScene(1, board([11, 3]) + "\n**引用资产ID**：[12]", undefined, options).errors.join("；"), /多套状态/, "同一片段第二份数组不能绕过角色状态校验");
});

test("角色状态变化分片段允许；纯环境、道具、后期屏幕及无具名群众不误拒绝", () => {
  assert.equal(validateStoryboardScene(1, splitBoard, undefined, options).valid, true);
  assert.equal(validateStoryboardScene(1, board([3, 31, 4, 41]), undefined, options).valid, true);
  const memoryBeat = `## 场1：测试\n${segment([3], 2.3)}\n${segment([11, 3], 1.3, 2)}\n${segment([12, 3], 0.4, 3)}`;
  assert.equal(validateStoryboardScene(1, memoryBeat, undefined, { ...options, targetDuration: 4 }).valid, true, "环境记忆、过去角色、现在角色按片段独立引用可保持同一4秒节拍");
  assert.equal(validateStoryboardScene(1, board([11, 12, 3])).valid, true, "旧调用无映射不猜测角色关系");
});

async function fixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_script", t => { t.integer("id"); t.integer("projectId"); t.text("content"); });
  await db.schema.createTable("o_agentWorkData", t => { t.increments("id"); t.integer("projectId"); t.integer("episodesId"); t.text("key"); t.text("data"); });
  await db.schema.createTable("o_assets", t => { t.integer("id"); t.integer("projectId"); t.integer("assetsId"); t.integer("imageId"); t.text("name"); t.text("type"); t.text("describe"); });
  await db.schema.createTable("o_scriptAssets", t => { t.integer("scriptId"); t.integer("assetId"); });
  await db("o_script").insert({ id: 8, projectId: 7, content: "场1：测试（0–6秒）" });
  await db("o_assets").insert([...assets, { id: 99, type: "role", assetsId: 1 }].map(asset => ({ ...asset, projectId: 7, name: `资产${asset.id}`, describe: "真实描述", imageId: asset.id + 1000 })));
  await db("o_scriptAssets").insert([...assets.filter(asset => asset.id !== 1).map(asset => ({ scriptId: 8, assetId: asset.id })), { scriptId: 9, assetId: 99 }]);
  return db;
}
const parsed = (text: string, full = false) => extractStoryboardTable(full
  ? `<storyboardTable>${text}</storyboardTable>`
  : `<storyboardTable scene="1" total="1" task="storyboard_state_test">${text}</storyboardTable>`);

test("真实事务生成/整表拒绝混状态和跨集状态，不保存工作区或checkpoint", async () => {
  const db = await fixture();
  try {
    let checkpointWrites = 0;
    for (const full of [false, true]) await assert.rejects(() => commitStoryboardTableOutput(db, 7, 8, parsed(board([11, 12, 3]), full), undefined, async () => { checkpointWrites++; }), /多套状态/);
    await assert.rejects(() => commitStoryboardTableOutput(db, 7, 8, parsed(board([99, 3]))), /引用资产缺失或不属于/);
    assert.equal((await db("o_agentWorkData")).length, 0); assert.equal(checkpointWrites, 0);
    await commitStoryboardTableOutput(db, 7, 8, parsed(board([11, 21, 3, 31, 4, 41])), undefined, async () => { checkpointWrites++; });
    assert.equal(checkpointWrites, 1);
    assert.equal((await db("o_assets").where({ id: 11 }).first()).imageId, 1011);
  } finally { await db.destroy(); }
});

test("旧整表完全相同也不能绕过新护栏认证混状态checkpoint，保留已有稿", async () => {
  const db = await fixture();
  try {
    const data = JSON.stringify({ scriptPlan: "", storyboardTable: board([11, 12, 3]) });
    await db("o_agentWorkData").insert({ projectId: 7, episodesId: 8, key: "productionAgent", data });
    let checkpointWrites = 0;
    await assert.rejects(() => commitStoryboardTableOutput(db, 7, 8, parsed(board([11, 12, 3]), true), undefined, async () => { checkpointWrites++; }), /多套状态/);
    assert.equal(checkpointWrites, 0); assert.equal((await db("o_agentWorkData").first()).data, data);
  } finally { await db.destroy(); }
});

test("真实修订事务拒绝混状态并保留旧稿；拆分后提交历史与时长完整", async () => {
  const db = await fixture();
  try {
    await commitStoryboardTableOutput(db, 7, 8, parsed(board([11, 3])));
    const before = await db("o_agentWorkData").first(), data = JSON.parse(before.data), progress = data.storyboardTableProgress;
    const request = { projectId: 7, episodesId: 8, scene: 1, taskId: progress.taskId, expectedRevision: progress.revision,
      expectedSceneHash: storyboardSceneHash(progress.scenes["1"]), reason: "分离角色外观状态", revisedScene: board([1, 11, 3]) };
    await assert.rejects(() => reviseStoryboardScene(db, request), /多套状态/);
    assert.equal((await db("o_agentWorkData").first()).data, before.data);
    const saved = await reviseStoryboardScene(db, { ...request, revisedScene: splitBoard });
    assert.equal(saved.revision, progress.revision + 1);
    const after = JSON.parse((await db("o_agentWorkData").first()).data);
    assert.equal(after.storyboardRevisionHistory.length, 1); assert.equal(after.storyboardRevisionHistory[0].original, progress.scenes["1"]);
    assert.equal(after.storyboardTable, splitBoard);
  } finally { await db.destroy(); }
});

test("监督使用真实本集父子映射，已保存混状态时拒绝错误A或文本合格结论", async () => {
  const db = await fixture();
  try {
    await db("o_agentWorkData").insert({ projectId: 7, episodesId: 8, key: "productionAgent", data: JSON.stringify({ scriptPlan: "", storyboardTable: board([11, 12, 3]) }) });
    const snapshot = await readSupervisionSnapshot(db, 7, 8);
    assert.equal(snapshot.assets.some(parent => parent.derive.some(child => child.id === 99)), false);
    assert.match(supervisionDiagnostics(snapshot).scenes[0].errors.join("；"), /多套状态/);
    assert.match(validateSupervisionReport(snapshot, "评分：A\n文本结论：合格").join("；"), /同一角色父资产1/);
    assert.deepEqual(validateSupervisionReport({ ...snapshot, storyboardTable: splitBoard }, "评分：A\n文本结论：合格"), []);
  } finally { await db.destroy(); }
});
