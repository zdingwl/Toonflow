"""One-shot, human-readable integration patch for the staged storyboard recovery upgrade.

The patch fails closed when any expected source anchor has changed. The workflow
runs tests and TypeScript validation BEFORE committing its output to the staging
branch. This script is removed from the resulting commit.
"""
from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise RuntimeError(f"{path}: expected exactly one anchor, found {text.count(old)}: {old[:120]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


# 1. Progress is a database property, never an XML attribute in rendered Markdown.
tools = "src/agents/productionAgent/tools.ts"
replace(tools,
    'import { createHash, randomUUID } from "node:crypto";',
    'import { createHash, randomUUID } from "node:crypto";\nimport { readStoryboardProgress } from "./storyboardProgress";')
replace(tools,
    '  const tools: Record<string, Tool> = {\n    get_flowData: tool({',
    '''  const tools: Record<string, Tool> = {
    get_storyboard_progress: tool({
      description: "只读：从数据库获取分镜任务 taskId、total、revision、已保存/缺失场次和下一场；不要从 Markdown 查找 XML task 属性。",
      inputSchema: jsonSchema(z.object({}).toJSONSchema()),
      execute: async () => {
        const progress = await readStoryboardProgress(u.db, Number(resTool.data.projectId), Number(resTool.data.scriptId));
        const thinking = msg.thinking("正在核对分镜表数据库进度...");
        thinking.appendText(JSON.stringify(progress));
        thinking.updateTitle(progress.valid ? "分镜任务进度核对完成" : "分镜任务进度冲突");
        thinking.complete();
        return progress;
      },
    }),
    get_flowData: tool({''')

# 2. Only the backend commits AI-produced XML. The browser renders on the authoritative commit event.
ui = "Toonflow-web-master/src/stores/productionAgent.ts"
replace(ui,
    '    // useChat 对已闭合的 XML 可能多次触发 complete；同一消息/场次只发送一次保存请求。\n    const sceneReceipts = new Map<string, Promise<void>>();\n\n',
    '')
start = '        } else if (tag === "storyboardTable") {'
stop = '        if (status == "complete") {\n          throttledFn();\n        }'
file = Path(ui)
text = file.read_text(encoding="utf-8")
start_index = text.find(start)
stop_index = text.find(stop, start_index)
if start_index < 0 or stop_index < 0 or text.count(start) != 1:
    raise RuntimeError("productionAgent.ts: storyboard XML handler anchor missing")
text = text[:start_index] + '''        } else if (tag === "storyboardTable") {
          // Agent XML is only a stream preview; the backend is the sole writer.
          // Never write a scene (or a full table) from a browser completion event.
          // The storyboardTable:committed handler below updates the workspace.
          return;
        }
''' + text[stop_index:]
file.write_text(text, encoding="utf-8")

# 3. Include source revisions with NEW scene tasks; never silently rewrite old content.
table = "src/agents/productionAgent/storyboardTable.ts"
replace(table,
    'import type { Knex } from "knex";',
    'import type { Knex } from "knex";\nimport { hashStoryboardSource } from "./storyboardProgress";')
replace(table,
    '''    if (output.mode === "scene") {
      const merged = mergeStoryboardScene(''',
    '''    if (output.mode === "scene") {
      const script = await trx("o_script").where({ id: episodesId, projectId }).select("content").first();
      if (!script) throw new Error("当前项目不存在该集剧本");
      const sourceHash = hashStoryboardSource(script.content ?? "");
      const planHash = hashStoryboardSource(typeof data.scriptPlan === "string" ? data.scriptPlan : "");
      if (currentProgress?.sourceHash && currentProgress.sourceHash !== sourceHash) {
        throw new Error("剧本自分镜任务开始后已修改，不能继续混写旧任务");
      }
      if (currentProgress?.planHash && currentProgress.planHash !== planHash) {
        throw new Error("导演计划自分镜任务开始后已修改，不能继续混写旧任务");
      }
      const merged = mergeStoryboardScene(''')
replace(table,
    '''        storyboardTableProgress: merged.storyboardTableProgress,
      };''',
    '''        storyboardTableProgress: {
          ...merged.storyboardTableProgress,
          sourceHash: currentProgress?.sourceHash ?? sourceHash,
          planHash: currentProgress?.planHash ?? planHash,
        },
      };''')
replace(table,
    '''        resultRef: `storyboardTable:${projectId}:${episodesId}:scene:${output.scene}`,
        ...merged,
      };''',
    '''        resultRef: `storyboardTable:${projectId}:${episodesId}:scene:${output.scene}`,
        ...merged,
        storyboardTableProgress: nextData.storyboardTableProgress,
      };''')

# 4. The scene runner, not the planner, owns task/scene/total and the next-scene loop.
agent = "src/agents/productionAgent/index.ts"
replace(agent,
    'import { TaskStore } from "@/utils/agent/runtime/taskStore";',
    '''import { TaskStore } from "@/utils/agent/runtime/taskStore";
import { readStoryboardProgress } from "./storyboardProgress";
import { runStoryboardTask } from "./storyboardTaskRunner";
import { extractSourceScene, validateStoryboardScene } from "./storyboardValidator";''')
replace(agent,
    '''    messages,
  }: {
    key: `${string}:${string}`;''',
    '''    messages,
    expectedScene,
  }: {
    key: `${string}:${string}`;''')
replace(agent,
    '''    messages?: { role: "user" | "assistant" | "system"; content: string }[];
  }) {
    const stepInput = JSON.stringify({ key, prompt, messages: messages ?? null });''',
    '''    messages?: { role: "user" | "assistant" | "system"; content: string }[];
    expectedScene?: { scene: number; total: number; taskId: string; sourceScene?: string };
  }) {
    const stepInput = JSON.stringify({ key, prompt, messages: messages ?? null, expectedScene: expectedScene ?? null });''')
replace(agent,
    '''          const parsed = extractStoryboardTable(fullResponse);
          const committed = await commitStoryboardTableOutput(''',
    '''          const parsed = extractStoryboardTable(fullResponse);
          if (expectedScene) {
            if (parsed.mode !== "scene" || parsed.scene !== expectedScene.scene ||
                parsed.total !== expectedScene.total || parsed.taskId !== expectedScene.taskId) {
              throw new Error(`当前只允许输出第${expectedScene.scene}场及固定 task/total，拒绝其他场次或整表`);
            }
            const validation = validateStoryboardScene(parsed.scene, parsed.content, expectedScene.sourceScene);
            if (!validation.valid) throw new Error(`第${parsed.scene}场内容校验失败：${validation.errors.join("；")}`);
            if (!validation.coverageVerified) {
              subMsg.text(`第${parsed.scene}场通过结构校验；原剧本逐项覆盖尚待人工或后续核验。`).complete();
            }
          }
          const committed = await commitStoryboardTableOutput(''')
start = '  const run_sub_agent_storyboard_table = tool({'
end = '  const run_sub_agent_supervision = tool({'
file = Path(agent)
text = file.read_text(encoding="utf-8")
a = text.find(start)
b = text.find(end, a)
if a < 0 or b < 0 or text.count(start) != 1:
    raise RuntimeError("index.ts: storyboard tool block missing")
new_tool = '''  const run_sub_agent_storyboard_table = tool({
    description: "由后端控制分镜逐场生成、事务提交和中断恢复。整集使用 scope=full；明确只写一场时使用 scope=single。",
    inputSchema: jsonSchema<{ prompt: string; total?: number; scope?: "full" | "single" }>(
      z.object({
        prompt: z.string().min(1).describe("本次分镜创作要求"),
        total: z.number().int().min(1).max(1000).optional().describe("首次生成时的总场数，应与已确认导演计划一致；恢复时沿用数据库总数"),
        scope: z.enum(["full", "single"]).optional().describe("整集逐场完成或明确只处理下一缺失场"),
      }).toJSONSchema(),
    ),
    execute: async ({ prompt, total: requestedTotal, scope: requestedScope }) => {
      const productionSkills = await loadProductionSkills();
      const skill = path.join(u.getPath("skills"), "production_execution_storyboard_table.md");
      const systemPrompt = await readSkill(skill);
      const projectId = Number(resTool.data.projectId);
      const episodesId = Number(resTool.data.scriptId);
      const progress = await readStoryboardProgress(u.db, projectId, episodesId);
      if (!progress.valid) throw new Error(progress.conflict?.message ?? "分镜进度异常，请先核对现有数据");
      const scriptRow = await u.db("o_script").where({ id: episodesId, projectId }).select("content").first();
      const workspace = await u.db("o_agentWorkData").where({ projectId, episodesId, key: "productionAgent" }).select("data").first();
      const plan = workspace?.data ? (JSON.parse(workspace.data).scriptPlan ?? "") : "";
      const declaredTotal = String(plan).match(/共规划\\s*(\\d+)\\s*个?场/);
      const planHeadings = [...String(plan).matchAll(/^\\s*(?:\\d+[.、]\\s*)?场\\s*(\\d+)\\s*[：:]/gm)].map((m) => Number(m[1]));
      const planTotal = declaredTotal ? Number(declaredTotal[1]) :
        (planHeadings.length && planHeadings.every((n, i) => n === i + 1) ? planHeadings.length : undefined);
      const total = progress.total ?? requestedTotal ?? planTotal;
      if (!total || !Number.isSafeInteger(total) || total > 1000) {
        throw new Error("无法从已有进度或导演计划确定总场数，请先核对导演计划");
      }
      if (requestedTotal !== undefined && requestedTotal !== total) throw new Error("输入总场数与已保存进度不一致");
      if (planTotal !== undefined && planTotal !== total) throw new Error("导演计划总场数与分镜任务不一致");
      const sourceScript = String(scriptRow?.content ?? "");
      const stage = await runStoryboardTask({
        db: u.db,
        projectId,
        episodesId,
        total,
        maxScenes: requestedScope === "single" ? 1 : total,
        maxAttemptsPerScene: 1, // 未能核对的 Step 不能在同一 Run 中盲目重放。
        abortSignal,
        generate: async ({ scene, taskId, total }) => {
          const sourceScene = extractSourceScene(sourceScript, scene);
          const before = await readStoryboardTableSnapshot(u.db, projectId, episodesId);
          const previous = before.storyboardTableProgress?.scenes[String(scene - 1)]?.slice(-800) ?? "";
          const protocol = `\\n【后端固定任务协议】只处理第${scene}场，共${total}场，task=${taskId}。` +
            `必须仅输出一份完整闭合的 <storyboardTable scene="${scene}" total="${total}" task="${taskId}">该场完整Markdown</storyboardTable>；` +
            `不要生成其他场次，不要自行变更 task/total。\\n` +
            (sourceScene ? `本场原剧本（必须完整覆盖）：\\n${sourceScene}\\n` :
              `当前剧本未识别到明确的第${scene}场边界；先调用 get_flowData(script) 定位本场，不得凭空补剧情。\\n`) +
            (previous ? `上一场末尾连续性参考：\\n${previous}\\n` : "") +
            `创作要求：${prompt}`;
          await runAgent({
            key: "productionAgent:storyboardTableAgent",
            prompt: protocol,
            system: systemPrompt,
            name: "执行导演",
            memoryKey: "assistant:execution",
            expectedScene: { scene, total, taskId, sourceScene },
            messages: [
              { role: "assistant", content: productionSkills.prompt + `\\n${modelInfo}` },
              { role: "user", content: protocol },
            ],
            tools: { ...productionSkills.tools },
          });
        },
      });
      return {
        taskId: stage.taskId, total: stage.total, savedScenes: stage.savedScenes,
        missingScenes: stage.missingScenes, nextScene: stage.nextScene,
        complete: stage.complete,
        message: stage.complete ? "分镜表全部场次已事务提交；原剧本覆盖仍须逐场核验。" :
          "本次场次已保存；仍有缺失场次，不能宣称整集完成。",
      };
    },
  });

'''
file.write_text(text[:a] + new_tool + text[b:], encoding="utf-8")

# 5. Align instruction text with the single-writer and program-controlled scene protocol.
skill = "data/skills/production_execution_storyboard_table.md"
replace(skill,
    '根据本次实际输出上限，决定采用【旧版整表】还是【逐场模式】。',
    '当前由后端决定逐场任务和总场次；不得自行选择整表模式或改动场次/任务标识。')
replace(skill,
    '一次子 Agent 调用**只处理一场**，只输出一对完整闭合的 `<storyboardTable scene="N" total="M" task="storyboard_run_01">该场完整 Markdown</storyboardTable>`。`N` 为真实场次序号、`M` 为本集固定总场次数，每次子任务必须沿用同一个 `task`，例如 `storyboard_run_01`，直到整集完成。',
    '一次子 Agent 调用**只处理一场**，仅输出一对完整闭合的 `<storyboardTable scene="N" total="M" task="后端下发的taskId">该场完整 Markdown</storyboardTable>`。`N`、`M` 和 `task` 必须与本次后端任务协议完全一致，不得使用示例 task 或自行确定下一场。')
replace(skill,
    '恢复中断时，先按需读取现有 `storyboardTable`，数出实际保存的 `## 场N：`，**只派发缺失场次**。',
    '恢复中断时，调用 `get_storyboard_progress` 读取数据库进度，**只生成后端指定的下一缺失场次**；不要在 Markdown 正文里寻找 XML task 属性。')
replace(skill,
    '分镜表只能通过上述 XML 生成并由前端在完整闭合时保存，不能编造一个“保存成功”的工具回执。',
    '分镜表只能通过上述 XML 生成，由后端在完整闭合、校验后事务提交；前端仅展示预览与后端提交回执。不能编造“保存成功”的工具回执。')

print("Applied audited storyboard patch; pending yarn test:agent and yarn lint.")
