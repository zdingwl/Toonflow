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

test("分镜批量保存使用事务且仅在提交后回填新 ID", () => {
  const route = source("src/routes/production/storyboard/batchAddStoryboardInfo.ts");
  const commit = route.indexOf("const { stored, createdIds } = await u.db.transaction(");
  const result = route.indexOf("data.forEach((item: any, index: number) => { item.id = createdIds[index]; });");
  assert.ok(commit >= 0 && result > commit);
  assert.match(route, /引用资产不属于当前项目或不存在/);
  assert.match(route, /const stored = await trx\("o_storyboard"\)\.where\(\{ scriptId, projectId \}\)/);
  assert.match(route, /trackId: item\.trackId/);
  assert.match(route, /Math\.max\(Date\.now\(\), Number\(maxRow\?\.maxId \?\? 0\) \+ 1\)/);
});
