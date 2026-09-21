import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (file) => readFileSync(path.join(root, file), "utf8");

// 静态回归约束；数据库事务回滚、浏览器 Socket 和真实模型生成仍需集成测试。
test("制作工作区读取限定项目、剧本及 Agent 类型", () => {
  const route = source("src/routes/production/getFlowData.ts");
  assert.match(route, /\.andWhere\("key", "productionAgent"\)/);
  assert.match(route, /where\("projectId", projectId\)\.where\("id", episodesId\)/);
  assert.match(route, /where\(\{ scriptId: episodesId, projectId \}\)/);
  assert.match(route, /当前项目不存在该集剧本/);
});

test("制作工作区保存及分镜排序在同一事务，并校验真实持久化内容", () => {
  const route = source("src/routes/production/saveFlowData.ts");
  assert.match(route, /await u\.db\.transaction\(async \(trx\) =>/);
  assert.match(route, /where\(\{ id: item\.id, projectId, scriptId: episodesId \}\)/);
  assert.match(route, /key: "productionAgent"/);
  assert.match(route, /saved\.data !== serialized/);
});

test("分镜批量写入的请求标识与新 ID 在同一事务中保存", () => {
  const route = source("src/routes/production/storyboard/batchAddStoryboardInfo.ts");
  assert.match(route, /requestId: z\.string\(\)\.min\(8\)\.max\(128\)/);
  assert.match(route, /createHash\("sha256"\)/);
  assert.match(route, /const \{ stored, createdIds, associationMap \} = await u\.db\.transaction\(/);
  assert.match(route, /where\(\{ projectId, episodesId: scriptId, key: requestKey \}\)/);
  assert.match(route, /prior\.payloadHash !== payloadHash/);
  assert.match(route, /whereIn\("id", createdIds\)/);
  assert.match(route, /data: JSON\.stringify\(\{ payloadHash, createdIds \}\)/);
  assert.match(route, /return \{ stored, createdIds, associationMap \}/);
  assert.match(route, /\.send\(\{ \.\.\.success\(storyboardData\), createdIds \}\)/);
  assert.match(route, /引用资产不属于当前项目或不存在/);
  assert.match(route, /Math\.max\(Date\.now\(\), Number\(maxRow\?\.maxId \?\? 0\) \+ 1\)/);
});

test("分镜前端按新增顺序回填真实 ID，不再依据同文案查找", () => {
  const client = source("Toonflow-web-master/src/stores/productionAgent.ts");
  const write = client.split("async function addStoryboardInfo(")[1]?.split("const loadingHistory")[0];
  assert.ok(write, "分镜写入函数不存在");
  assert.match(write, /data: items,[\s\S]*?requestId/);
  assert.match(write, /response\.createdIds\.map\(\(id\) => persisted\.get\(id\)\)/);
  assert.match(write, /const target = pendingItems\[index\]/);
  assert.doesNotMatch(write, /\.find\(\(d: Storyboard\) => d\.prompt/);
  assert.match(client, /callback\(\{ success: false, message, requestId \}\)/);
});

test("Agent 分镜写入工具可复用 requestId，并把失败后的重试标识传回模型", () => {
  const tools = source("src/agents/productionAgent/tools.ts");
  const write = tools.split("add_flowData_storyboard: tool(")[1];
  assert.ok(write, "分镜写入工具不存在");
  assert.match(write, /requestId: z\.string\(\)\.min\(8\)\.max\(128\)/);
  assert.match(write, /requestId: raw\.requestId \?\?/);
  assert.match(write, /ack\?\.error \?\? ack\?\.message/);
  assert.match(write, /同一镜头如需重试，请使用 requestId=/);
});
