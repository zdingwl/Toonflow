import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (file) => readFileSync(path.join(root, file), "utf8");

test("分镜决策层必须先读回本场，再派发缺场，齐全后才审核", () => {
  const decision = source("data/skills/production_agent_decision.md");
  const stage = decision.split("### 阶段4：构建分镜表")[1]?.split("### 阶段5：")[0] ?? "";
  const audit = decision.split("### 审核派发与结果处理")[1]?.split("### 调度决策树")[0] ?? "";
  assert.ok(stage, "缺少阶段4调度规则");
  assert.match(stage, /每次 `run_sub_agent_storyboard_table` 只能处理一场/);
  assert.match(stage, /重新读取工作区已保存的分镜表/);
  assert.match(stage, /只补缺场/);
  assert.match(stage, /此前不派发监督层、阶段5或后续阶段/);
  assert.match(audit, /阶段4全部场次已核实保存后/);
  assert.doesNotMatch(audit, /阶段1或阶段4执行完毕后/);
});

test("决策层调度示例采用实际工具的 prompt 参数", () => {
  const decision = source("data/skills/production_agent_decision.md");
  const agent = source("src/agents/productionAgent/index.ts");
  assert.match(agent, /const promptInput = z\s*\.object\(\{ prompt: z\.string\(\)/);
  assert.match(decision, /run_sub_agent_supervision\(\s*prompt:/);
  assert.doesNotMatch(decision, /\bprompts\s*:/);
});
