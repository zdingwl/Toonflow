import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (name) => readFileSync(path.join(root, name), "utf8");

// 代码级协议与语法检查，不替代真实数据库、Socket、浏览器或模型生成的端到端测试。
test("修改过的 Agent、保存接口与前端 Store TypeScript 文件无语法诊断", () => {
  for (const file of [
    "src/utils/ai.ts",
    "src/agents/scriptAgent/tools.ts",
    "src/agents/productionAgent/tools.ts",
    "src/utils/storyboardScenes.ts",
    "src/utils/agent/skillsTools.ts",
    "src/routes/production/storyboard/batchAddStoryboardInfo.ts",
    "src/routes/production/saveFlowData.ts",
    "src/routes/scriptAgent/getPlanData.ts",
    "src/routes/scriptAgent/setPlanData.ts",
    "Toonflow-web-master/src/stores/productionAgent.ts",
    "Toonflow-web-master/src/stores/scriptAgent.ts",
  ]) {
    const result = ts.transpileModule(source(file), {
      fileName: path.basename(file),
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), [], file);
  }
});

test("分段读取兼容旧版完整字符串并能续读到末尾", () => {
  const code = source("src/agents/scriptAgent/tools.ts");
  const declaration = code.match(/function optionalTextChunk\([\s\S]*?\n}\n/);
  assert.ok(declaration, "缺少 optionalTextChunk 实现");
  const js = ts.transpileModule(declaration[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const chunk = new Function(`${js}\nreturn optionalTextChunk;`)();
  assert.equal(chunk("abcdef"), "abcdef");
  assert.deepEqual(chunk("abcdef", 2, 2), { data: "cd", offset: 2, total: 6, nextOffset: 4 });
  assert.deepEqual(chunk("abcdef", 4, 2), { data: "ef", offset: 4, total: 6, nextOffset: null });
  assert.deepEqual(chunk("abcdef", 99, 2), { data: "", offset: 6, total: 6, nextOffset: null });
});

test("剧本子任务只注入一对 scriptItem 标签", () => {
  const code = source("src/agents/scriptAgent/index.ts");
  const scriptAgent = code.split("const run_sub_agent_script = tool(")[1];
  assert.ok(scriptAgent, "未找到剧本子 Agent");
  const format = scriptAgent.split("const formatPrompt =")[1]?.split("return runAgent(")[0] ?? "";
  assert.equal((format.match(/<scriptItem\b/g) ?? []).length, 1);
  assert.equal((format.match(/<\/scriptItem>/g) ?? []).length, 1);
});

test("分镜 Skill 允许短篇单标签与长篇单场标签，缺场不能报告完成", () => {
  const skill = source("data/skills/production_execution_storyboard_table.md");
  assert.match(skill, /其他场景不得凭此虚构人物/);
  assert.match(skill, /<storyboardTable scene="N" total="M" task="storyboard_run_01">/);
  assert.match(skill, /一次子 Agent 调用\*\*只处理一场/);
  assert.match(skill, /缺失场次/);
  assert.match(skill, /旧版整表模式/);
  assert.doesNotMatch(skill, /此后严禁再调用任何 `get_flowData`/);
});

test("前端只接收分场完成事件，并将场次独立提交给后端", () => {
  const client = source("Toonflow-web-master/src/stores/productionAgent.ts");
  assert.match(client, /if \(status !== "complete"\) return/);
  assert.match(client, /scene: \{ taskId, index: scene, total, content: value \}/);
  assert.match(client, /sceneReceipts\.set\(key, write\)/);
  assert.match(client, /storyboardTableProgress = response\.data\.storyboardTableProgress/);
});

test("章节校验不读取整章小说正文", () => {
  const tools = source("src/agents/scriptAgent/tools.ts");
  const events = tools.split("get_novel_events: tool(")[1]?.split("get_planData: tool(")[0] ?? "";
  assert.ok(events);
  assert.doesNotMatch(events, /\.select\([^\n]*chapterData/);
  assert.match(events, /未找到章节编号/);
});

test("分镜面板批量写入使用事务、校验引用资产并读回已保存的分组 ID", () => {
  const route = source("src/routes/production/storyboard/batchAddStoryboardInfo.ts");
  assert.match(route, /await u\.db\.transaction\(async \(trx\) =>/);
  assert.match(route, /where\(\{ id: scriptId, projectId \}\)/);
  assert.match(route, /引用资产不属于当前项目或不存在/);
  assert.match(route, /where\(\{ scriptId, projectId \}\)/);
  assert.match(route, /const stored = await trx\("o_storyboard"\)/);
  assert.match(route, /trackId: item\.trackId/);
  assert.match(route, /Math\.max\(Date\.now\(\), Number\(maxRow\?\.maxId \?\? 0\) \+ 1\)/);
});

test("制作工作区保存先校验分镜归属，事务内读回数据后才回执", () => {
  const route = source("src/routes/production/saveFlowData.ts");
  assert.match(route, /await u\.db\.transaction\(async \(trx\) =>/);
  assert.match(route, /where\(\{ id: item\.id, projectId, scriptId: episodesId \}\)/);
  assert.match(route, /key: "productionAgent"/);
  assert.match(route, /saved\.data !== payload/);
  assert.match(route, /工作区数据写入校验失败/);
});

test("剧本初始化、写入及前端自动保存具有持久化核对与顺序约束", () => {
  const init = source("src/routes/scriptAgent/getPlanData.ts");
  const save = source("src/routes/scriptAgent/setPlanData.ts");
  const client = source("Toonflow-web-master/src/stores/scriptAgent.ts");
  assert.match(init, /script:\s*\[\]/);
  assert.match(save, /if \(!updated\)/);
  assert.match(save, /剧本工作区保存校验失败/);
  assert.match(save, /剧本正文保存校验失败/);
  assert.match(client, /saveQueue\.then\(async/);
  assert.match(client, /lastQueuedSnapshot/);
  assert.match(client, /保存失败，请检查后端状态/);
});
