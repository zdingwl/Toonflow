import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("生产 Agent 修订执行器接入决策工具，并与首次分镜生成提交隔离", () => {
  const code = read("src/agents/productionAgent/index.ts");
  const result = ts.transpileModule(code, {
    fileName: "index.ts", reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const diagnostics = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  assert.match(code, /import \{ createStoryboardRevisionTool \} from "\.\/storyboardRevisionTool"/);
  assert.match(code, /const run_sub_agent_storyboard_revise = createStoryboardRevisionTool\(/);
  assert.match(code, /run_sub_agent_storyboard_revise,\s*run_sub_agent_supervision/);
  assert.match(code, /modelKey: "productionAgent:storyboardTableAgent"/);
  assert.match(code, /key: "productionAgent:storyboardRevisionAgent"/);
  assert.match(code, /readOnlyTools: true/);
  assert.match(code, /toolsNames: \["get_flowData", "get_storyboard_progress"\]/);
  assert.match(code, /return runAgent\(\{[\s\S]*?key: "productionAgent:storyboardRevisionAgent"/);
});

test("修订工具先读数据库原稿及版本，修订完成后读回并只在发生变化时报告", () => {
  const code = read("src/agents/productionAgent/storyboardRevisionTool.ts");
  assert.match(code, /readStoryboardProgress/);
  assert.match(code, /expectedRevision: before\.revision/);
  assert.match(code, /expectedSceneHash: storyboardSceneHash\(original\)/);
  assert.match(code, /if \(!committed\.changed\)/);
  assert.match(code, /readStoryboardTableSnapshot/);
  assert.match(code, /options\.notify\(/);
});
