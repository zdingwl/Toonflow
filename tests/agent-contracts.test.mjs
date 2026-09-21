import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (name) => readFileSync(path.join(root, name), "utf8");

// 仅校验受本轮改动影响的静态协议和工具函数；不替代真实数据库、Socket 或模型端到端测试。
test("修改过的 Agent TypeScript 文件无语法诊断", () => {
  for (const file of ["src/utils/ai.ts", "src/agents/scriptAgent/tools.ts", "src/utils/agent/skillsTools.ts"]) {
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

test("分镜表提示词保持单标签写入并允许输出前补读", () => {
  const skill = source("data/skills/production_execution_storyboard_table.md");
  assert.match(skill, /唯一一对.*storyboardTable/);
  assert.match(skill, /其他场景不得凭此虚构人物/);
  assert.match(skill, /正式输出 XML 前按需读取/);
  assert.doesNotMatch(skill, /此后严禁再调用任何 `get_flowData`/);
});

test("章节校验不读取整章小说正文", () => {
  const tools = source("src/agents/scriptAgent/tools.ts");
  const events = tools.split("get_novel_events: tool(")[1]?.split("get_planData: tool(")[0] ?? "";
  assert.ok(events);
  assert.doesNotMatch(events, /\.select\([^\n]*chapterData/);
  assert.match(events, /未找到章节编号/);
});
