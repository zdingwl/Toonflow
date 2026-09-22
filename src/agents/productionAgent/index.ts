import { Socket } from "socket.io";
import { z } from "zod";
import { tool, jsonSchema } from "ai";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { createSkillTools, parseFrontmatter, scanSkills } from "@/utils/agent/skillsTools";
import useTools from "@/agents/productionAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";
import { extractDirectorPlan, saveDirectorPlan } from "./directorPlan";
import { commitStoryboardTableOutput, extractStoryboardTable, readStoryboardTableSnapshot } from "./storyboardTable";
import { TaskStore } from "@/utils/agent/runtime/taskStore";
import { readStoryboardProgress } from "./storyboardProgress";
import { runStoryboardTask } from "./storyboardTaskRunner";
import { extractSourceScene, validateStoryboardScene } from "./storyboardValidator";
import { createStoryboardRevisionTool } from "./storyboardRevisionTool";
import { wrapAgentTools } from "@/utils/agent/runtime/toolExecutor";
import { buildMemoryPrompt } from "@/utils/agent/contextManager";

const PRODUCTION_SIDE_EFFECT_TOOLS = new Set([
  "add_deriveAsset", "del_deriveAsset", "generate_deriveAsset", "generate_storyboard", "add_flowData_storyboard",
]);

export interface AgentContext {
  runId?: string;
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  thinkConfig: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 };
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, abortSignal } = ctx;
  const memory = new Memory("productionAgent", isolationKey);
  await memory.add("user", text);
  const skill = path.join(u.getPath("skills"), "production_agent_decision.md");
  const taskStore = ctx.runId ? new TaskStore(u.db) : null;
  const prompt = taskStore ? await taskStore.readSkill(ctx.runId!, skill) : await fs.promises.readFile(skill, "utf-8");
  const checkpoint = taskStore ? await taskStore.buildResumePrompt(ctx.runId!) : "";

  const projectInfo = await u.db("o_project").where("id", ctx.resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${ctx.resTool.data.projectId}`);
  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  let videoMode = "";
  try { videoMode = JSON.parse(projectInfo.mode ?? ""); } catch { videoMode = projectInfo.mode ?? ""; }
  const isRef = Array.isArray(videoMode);
  const modelInfo = `项目使用的模型如下：\n图像模型：${imageModelName}\n视频模型：${videoModelName}\n多参：${isRef ? "是" : "否"}`;
  const budgetRow = await u.db("o_setting").where({ key: "memoryContextTokenBudget" }).select("value").first();
  const configuredBudget = Number(budgetRow?.value);
  const memoryBudget = Number.isSafeInteger(configuredBudget) && configuredBudget >= 400 ? configuredBudget : 2400;
  const mem = buildMemoryPrompt(await memory.get(text), memoryBudget);

  const { fullStream } = await u.Ai.Text("productionAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
    messages: [
      { role: "system", content: prompt + (checkpoint ? "\n\n恢复任务时必须遵守 assistant 消息中的 Agent Runtime 任务检查点，不得重复已完成业务步骤。" : "") },
      { role: "assistant", content: [mem, modelInfo, checkpoint].filter(Boolean).join("\n\n") },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...wrapAgentTools(
        { ...memory.getTools(), ...useTools({ resTool: ctx.resTool, msg: ctx.msg }) },
        { db: u.db, runId: ctx.runId, sideEffectTools: PRODUCTION_SIDE_EFFECT_TOOLS },
      ),
      ...(await createSubAgent(ctx)),
    },
    onFinish: async (completion) => { await memory.add("assistant:decision", removeAllXmlTags(completion.text)); },
  });
  let currentMsg = ctx.msg;
  await consumeFullStream(fullStream, currentMsg, () => {
    if (ctx.msg === currentMsg) return currentMsg;
    currentMsg.complete();
    currentMsg = ctx.msg;
    return currentMsg;
  });
}

async function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("productionAgent", parentCtx.isolationKey);
  const taskStore = new TaskStore(u.db);
  const readSkill = (filePath: string) => parentCtx.runId ? taskStore.readSkill(parentCtx.runId, filePath) : fs.promises.readFile(filePath, "utf-8");

  async function runAgent({ key, modelKey, prompt, system, name, memoryKey, tools: extraTools, messages, expectedScene, readOnlyTools }: {
    key: `${string}:${string}`;
    modelKey?: `${string}:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    tools?: Record<string, any>;
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
    expectedScene?: { scene: number; total: number; taskId: string; sourceScene?: string };
    readOnlyTools?: boolean;
  }) {
    const stepInput = JSON.stringify({ key, prompt, messages: messages ?? null, expectedScene: expectedScene ?? null });
    const stepKey = TaskStore.makeStepKey(key, stepInput);
    if (parentCtx.runId) {
      const prior = await taskStore.beginStep(parentCtx.runId, stepKey, stepInput);
      if (prior.cached) return prior.output ?? "";
    }
    try {
      parentCtx.msg.complete();
      const subMsg = resTool.newMessage("assistant", name);
      const isDirectorPlan = key === "productionAgent:directorPlanAgent";
      const isStoryboardTable = key === "productionAgent:storyboardTableAgent";
      const scope = { projectId: Number(resTool.data.projectId), episodesId: Number(resTool.data.scriptId), key: "productionAgent" };
      const startingWorkspace = (isDirectorPlan || isStoryboardTable)
        ? await u.db("o_agentWorkData").where(scope).select("data").first() : null;
      const startingData = startingWorkspace?.data ? JSON.parse(startingWorkspace.data) : {};
      const expectedPlan = startingData.scriptPlan ?? "";
      const expectedStoryboardTable = isStoryboardTable
        ? await readStoryboardTableSnapshot(u.db, scope.projectId, scope.episodesId) : undefined;
      const activeTools = useTools({
        resTool, msg: subMsg,
        ...(readOnlyTools ? { toolsNames: ["get_flowData", "get_storyboard_progress"] } : {}),
      });
      const { fullStream } = await u.Ai.Text(modelKey ?? key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
        system,
        messages: messages ?? [{ role: "user", content: prompt }],
        abortSignal,
        tools: {
          ...extraTools,
          ...wrapAgentTools(activeTools, {
            db: u.db, runId: parentCtx.runId, stepKey, sideEffectTools: PRODUCTION_SIDE_EFFECT_TOOLS,
          }),
        },
      });
      const fullResponse = await consumeFullStream(fullStream, subMsg, undefined, !(isDirectorPlan || isStoryboardTable));
      if (parentCtx.runId) await taskStore.saveStepOutput(parentCtx.runId, stepKey, fullResponse);
      if (isDirectorPlan) {
        try {
          const plan = extractDirectorPlan(fullResponse);
          await saveDirectorPlan(u.db, scope.projectId, scope.episodesId, plan, expectedPlan);
          resTool.socket.emit("scriptPlan:committed", { episodesId: Number(resTool.data.scriptId), plan });
          subMsg.text("导演计划已保存到工作区。").complete();
          subMsg.complete();
        } catch (error) {
          console.error("[directorPlan] 输出校验失败，文本长度:", fullResponse.length, "开头:", fullResponse.slice(0, 180));
          subMsg.error(u.error(error).message);
          throw error;
        }
      } else if (isStoryboardTable) {
        try {
          const parsed = extractStoryboardTable(fullResponse);
          if (expectedScene) {
            if (parsed.mode !== "scene" || parsed.scene !== expectedScene.scene || parsed.total !== expectedScene.total || parsed.taskId !== expectedScene.taskId) {
              throw new Error(`当前只允许输出第${expectedScene.scene}场及固定 task/total，拒绝其他场次或整表`);
            }
            const validation = validateStoryboardScene(parsed.scene, parsed.content, expectedScene.sourceScene);
            if (!validation.valid) throw new Error(`第${parsed.scene}场内容校验失败：${validation.errors.join("；")}`);
            if (!validation.coverageVerified) subMsg.text(`第${parsed.scene}场通过结构校验；原剧本逐项覆盖尚待人工或后续核验。`).complete();
          }
          const committed = await commitStoryboardTableOutput(u.db, scope.projectId, scope.episodesId, parsed, expectedStoryboardTable);
          resTool.socket.emit("storyboardTable:committed", {
            episodesId: scope.episodesId,
            storyboardTable: committed.storyboardTable,
            storyboardTableProgress: committed.storyboardTableProgress,
            savedScenes: committed.savedScenes,
            missingScenes: committed.missingScenes,
          });
          const progressText = committed.missingScenes.length
            ? `分镜表已保存：已完成场次 ${committed.savedScenes.join(", ")}；待补场次 ${committed.missingScenes.join(", ")}。`
            : "分镜表已完整保存到工作区。";
          subMsg.text(progressText).complete();
          subMsg.complete();
        } catch (error) {
          console.error("[storyboardTable] 输出或提交校验失败，文本长度:", fullResponse.length, "开头:", fullResponse.slice(0, 180));
          subMsg.error(u.error(error).message);
          throw error;
        }
      }
      const visibleMemory = removeAllXmlTags(fullResponse).trim();
      const memoryContent = visibleMemory || (isDirectorPlan ? "导演计划已保存到工作区。" : isStoryboardTable ? "分镜表产出已保存到工作区。" : "");
      if (memoryContent) await memory.add(memoryKey, memoryContent, { name, createTime: new Date(subMsg.datetime).getTime() });
      if (parentCtx.runId) {
        let resultRef = `message:${subMsg.id}`;
        if (isDirectorPlan) resultRef = `directorPlan:${scope.projectId}:${scope.episodesId}`;
        if (isStoryboardTable) {
          const parsed = extractStoryboardTable(fullResponse);
          resultRef = parsed.mode === "scene"
            ? `storyboardTable:${scope.projectId}:${scope.episodesId}:scene:${parsed.scene}`
            : `storyboardTable:${scope.projectId}:${scope.episodesId}:full`;
        }
        await taskStore.finishStep(parentCtx.runId, stepKey, resultRef);
      }
      parentCtx.msg = resTool.newMessage("assistant", "视频策划");
      return fullResponse;
    } catch (error) {
      if (parentCtx.runId) await taskStore.markStepReconciling(parentCtx.runId, stepKey, u.error(error).message);
      throw error;
    }
  }

  const promptInput = z.object({ prompt: z.string().describe("交给子Agent的任务简约描述，100字以内") }).toJSONSchema();
  const projectInfo = await u.db("o_project").where("id", resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${resTool.data.projectId}`);
  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  let videoMode = "";
  try { videoMode = JSON.parse(projectInfo.mode ?? ""); } catch { videoMode = projectInfo.mode ?? ""; }
  const isRef = Array.isArray(videoMode);
  const modelInfo = `项目使用的模型如下：\n图像模型：${imageModelName}\n视频模型：${videoModelName}\n多参：${isRef ? "是" : "否"}`;
  const loadArtSkills = () => createArtSkills(projectInfo?.artStyle!, projectInfo?.directorManual!, readSkill);
  const loadProductionSkills = () => useProductionSkills(projectInfo?.artStyle!, projectInfo?.directorManual!, readSkill);

  const run_sub_agent_derive_assets = tool({
    description: "运行执行subAgent来完成衍生资产分析与信息写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const artSkills = await loadArtSkills();
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_execution_derive_assets.md"));
      return runAgent({ key: "productionAgent:deriveAssetsAgent", prompt, system: systemPrompt,
        name: "执行导演", memoryKey: "assistant:execution", messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` }, { role: "user", content: prompt },
        ], tools: { ...artSkills.tools } });
    },
  });

  const run_sub_agent_generate_assets = tool({
    description: "运行执行subAgent来完成衍生资产图片生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const artSkills = await loadArtSkills();
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_execution_generate_assets.md"));
      return runAgent({ key: "productionAgent:generateAssetsAgent", prompt, system: systemPrompt,
        name: "执行导演", memoryKey: "assistant:execution", messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` }, { role: "user", content: prompt },
        ], tools: { ...artSkills.tools } });
    },
  });

  const run_sub_agent_director_plan = tool({
    description: "运行执行subAgent来完成导演规划相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const artSkills = await loadArtSkills();
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_execution_director_plan.md"));
      const addPrompt = "\n你必须使用如下XML格式写入工作区：\n```\n<scriptPlan>内容</scriptPlan>\n```";
      return runAgent({ key: "productionAgent:directorPlanAgent", prompt, system: systemPrompt + addPrompt,
        name: "执行导演", memoryKey: "assistant:execution", messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` }, { role: "user", content: prompt + addPrompt },
        ], tools: { ...artSkills.tools } });
    },
  });

  const run_sub_agent_storyboard_gen = tool({
    description: "运行执行subAgent来完成分镜图生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const artSkills = await loadArtSkills();
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_execution_storyboard_gen.md"));
      return runAgent({ key: "productionAgent:storyboardGenAgent", prompt, system: systemPrompt,
        name: "执行导演", memoryKey: "assistant:execution", messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` }, { role: "user", content: prompt },
        ], tools: { ...artSkills.tools } });
    },
  });

  const run_sub_agent_storyboard_panel = tool({
    description: "运行执行subAgent来完成分镜面板写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const productionSkills = await loadProductionSkills();
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_execution_storyboard_panel.md"));
      return runAgent({ key: "productionAgent:storyboardPanelAgent", prompt, system: systemPrompt,
        name: "执行导演", memoryKey: "assistant:execution", messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` }, { role: "user", content: prompt },
        ], tools: { ...productionSkills.tools } });
    },
  });

  const run_sub_agent_storyboard_table = tool({
    description: "由后端控制分镜逐场生成、事务提交和中断恢复。整集使用 scope=full；明确只写一场时使用 scope=single。已有场次的修改须调用 run_sub_agent_storyboard_revise。",
    inputSchema: jsonSchema<{ prompt: string; total?: number; scope?: "full" | "single" }>(
      z.object({
        prompt: z.string().min(1).describe("本次分镜创作要求"),
        total: z.number().int().min(1).max(1000).optional().describe("首次生成时的总场数，应与已确认导演计划一致；恢复时沿用数据库总数"),
        scope: z.enum(["full", "single"]).optional().describe("整集逐场完成或明确只处理下一缺失场"),
      }).toJSONSchema(),
    ),
    execute: async ({ prompt, total: requestedTotal, scope: requestedScope }) => {
      const productionSkills = await loadProductionSkills();
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_execution_storyboard_table.md"));
      const projectId = Number(resTool.data.projectId);
      const episodesId = Number(resTool.data.scriptId);
      const progress = await readStoryboardProgress(u.db, projectId, episodesId);
      if (!progress.valid) throw new Error(progress.conflict?.message ?? "分镜进度异常，请先核对现有数据");
      const scriptRow = await u.db("o_script").where({ id: episodesId, projectId }).select("content").first();
      const workspace = await u.db("o_agentWorkData").where({ projectId, episodesId, key: "productionAgent" }).select("data").first();
      const plan = workspace?.data ? (JSON.parse(workspace.data).scriptPlan ?? "") : "";
      const declaredTotal = String(plan).match(/共规划\s*(\d+)\s*个?场/);
      const planHeadings = [...String(plan).matchAll(/^\s*(?:\d+[.、]\s*)?场\s*(\d+)\s*[：:]/gm)].map((m) => Number(m[1]));
      const planTotal = declaredTotal ? Number(declaredTotal[1]) :
        (planHeadings.length && planHeadings.every((n, i) => n === i + 1) ? planHeadings.length : undefined);
      const total = progress.total ?? requestedTotal ?? planTotal;
      if (!total || !Number.isSafeInteger(total) || total > 1000) throw new Error("无法从已有进度或导演计划确定总场数，请先核对导演计划");
      if (requestedTotal !== undefined && requestedTotal !== total) throw new Error("输入总场数与已保存进度不一致");
      if (planTotal !== undefined && planTotal !== total) throw new Error("导演计划总场数与分镜任务不一致");
      const sourceScript = String(scriptRow?.content ?? "");
      const stage = await runStoryboardTask({
        db: u.db, projectId, episodesId, total,
        maxScenes: requestedScope === "single" ? 1 : total,
        maxAttemptsPerScene: 1,
        abortSignal,
        generate: async ({ scene, taskId, total }) => {
          const sourceScene = extractSourceScene(sourceScript, scene);
          const before = await readStoryboardTableSnapshot(u.db, projectId, episodesId);
          const previous = before.storyboardTableProgress?.scenes[String(scene - 1)]?.slice(-800) ?? "";
          const protocol = `\n【后端固定任务协议】只处理第${scene}场，共${total}场，task=${taskId}。` +
            `必须仅输出一份完整闭合的 <storyboardTable scene="${scene}" total="${total}" task="${taskId}">该场完整Markdown</storyboardTable>；` +
            `不要生成其他场次，不要自行变更 task/total。\n` +
            (sourceScene ? `本场原剧本（必须完整覆盖）：\n${sourceScene}\n` :
              `当前剧本未识别到明确的第${scene}场边界；先调用 get_flowData(script) 定位本场，不得凭空补剧情。\n`) +
            (previous ? `上一场末尾连续性参考：\n${previous}\n` : "") + `创作要求：${prompt}`;
          await runAgent({
            key: "productionAgent:storyboardTableAgent", prompt: protocol, system: systemPrompt,
            name: "执行导演", memoryKey: "assistant:execution",
            expectedScene: { scene, total, taskId, sourceScene },
            messages: [
              { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
              { role: "user", content: protocol },
            ], tools: { ...productionSkills.tools },
          });
        },
      });
      return {
        taskId: stage.taskId, total: stage.total, savedScenes: stage.savedScenes,
        missingScenes: stage.missingScenes, nextScene: stage.nextScene, complete: stage.complete,
        message: stage.complete ? "分镜表全部场次已事务提交；原剧本覆盖仍须逐场核验。" :
          "本次场次已保存；仍有缺失场次，不能宣称整集完成。",
      };
    },
  });

  // 修订已有场次与补缺场严格分离；复用已配置的分镜模型，但使用独立 Step Key，
  // 生成阶段只提供只读工具，最终写入由 storyboardRevisionTool 执行带版本校验的事务。
  const run_sub_agent_storyboard_revise = createStoryboardRevisionTool({
    db: u.db,
    projectId: Number(resTool.data.projectId),
    episodesId: Number(resTool.data.scriptId),
    abortSignal,
    notify: (payload) => resTool.socket.emit("storyboardTable:committed", payload),
    generate: async ({ instruction, scene, total, taskId, original, sourceScene }) => {
      const productionSkills = await loadProductionSkills();
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_execution_storyboard_table.md"));
      const revisionPrompt = `【已有场次修订，不是首次生成】仅修订第${scene}场（共${total}场），task=${taskId}。` +
        `保持原剧本必须呈现的内容，不得擅自删除剧情或台词。只输出完整闭合的 ` +
        `<storyboardTable scene="${scene}" total="${total}" task="${taskId}">修订后第${scene}场完整Markdown</storyboardTable>。\n` +
        `【本场需解决的审核问题和用户要求】\n${instruction}\n` +
        `【本场已保存旧稿：必须在此基础上修改】\n${original}\n` +
        (sourceScene ? `【对应原剧本：必须完整覆盖】\n${sourceScene}\n` :
          `【注意】原剧本本场边界未定位；不得声称已核验全部剧情，请调用 get_flowData(script) 核对。\n`);
      return runAgent({
        key: "productionAgent:storyboardRevisionAgent",
        modelKey: "productionAgent:storyboardTableAgent",
        prompt: revisionPrompt,
        system: systemPrompt + "\n本次任务是修改已有分镜；绝不调用保存/新增工具，只返回修订 XML，后端独立提交。",
        name: "执行导演",
        memoryKey: "assistant:execution",
        readOnlyTools: true,
        messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: revisionPrompt },
        ],
      });
    },
  });

  const run_sub_agent_supervision = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const systemPrompt = await readSkill(path.join(u.getPath("skills"), "production_agent_supervision.md"));
      return runAgent({ key: "productionAgent:supervisionAgent", prompt, system: systemPrompt,
        name: "监制", memoryKey: "assistant:supervision" });
    },
  });

  return {
    run_sub_agent_derive_assets,
    run_sub_agent_generate_assets,
    run_sub_agent_director_plan,
    run_sub_agent_storyboard_gen,
    run_sub_agent_storyboard_panel,
    run_sub_agent_storyboard_table,
    run_sub_agent_storyboard_revise,
    run_sub_agent_supervision,
  };
}

async function createArtSkills(artName: string, storyName: string, readSkill: (filePath: string) => Promise<string>) {
  const artWorkerPath = u.getPath(["skills", "art_skills", artName, "driector_skills"]);
  const storyWorkerPath = u.getPath(["skills", "story_skills", storyName, "driector_skills"]);
  const skillList = [...(await scanSkills(artWorkerPath + "/*.md")), ...(await scanSkills(storyWorkerPath + "/*.md"))];
  const mainSkills: { path: string; name: string; description: string }[] = [];
  for (const skillPath of skillList) {
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    const content = await readSkill(skillPath);
    const parsed = parseFrontmatter(content);
    mainSkills.push({ path: skillPath, ...parsed });
  }
  return {
    prompt: `## Skills\n以下技能提供了专业任务的专用指令。\n当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。\n${buildSkillPrompt(mainSkills)}`,
    tools: createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills: [], tertiarySkills: [] }, u.getPath("skills"), readSkill),
  };
}

async function consumeFullStream(
  fullStream: AsyncIterable<any>,
  initialMsg: ReturnType<ResTool["newMessage"]>,
  syncMsg?: () => ReturnType<ResTool["newMessage"]>,
  completeMessage = true,
): Promise<string> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkTime = 0;
  let fullResponse = "";
  try {
    for await (const chunk of fullStream) {
      if (syncMsg) {
        const newMsg = syncMsg();
        if (newMsg !== msg) { msg = newMsg; text = msg.text(); }
      }
      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "error") {
        throw chunk.error;
      } else if (chunk.type == "finish") {
        break;
      }
    }
    text.complete();
    if (completeMessage) msg.complete();
  } catch (err: any) {
    thinking?.complete();
    const errMsg = err?.message ?? String(err);
    text.append(errMsg);
    text.error();
    msg.error();
    throw err;
  }
  return fullResponse;
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

export function buildSkillPrompt(skills: { name: string; description: string }[]): string {
  const skillEntries = skills.map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`).join("\n");
  return `\n<available_skills>\n${skillEntries}\n</available_skills>`;
}

async function useProductionSkills(artName: string, storyName: string, readSkill: (filePath: string) => Promise<string>) {
  const artWorkerPath = u.getPath(["skills", "art_skills", artName, "driector_skills"]);
  const storyWorkerPath = u.getPath(["skills", "story_skills", storyName, "driector_skills"]);
  const productionPath = u.getPath(["skills", "production_skills"]);
  const skillList = [
    ...(await scanSkills(artWorkerPath + "/*.md")),
    ...(await scanSkills(storyWorkerPath + "/*.md")),
    ...(await scanSkills(productionPath + "/*.md")),
  ];
  const mainSkills: { path: string; name: string; description: string }[] = [];
  for (const skillPath of skillList) {
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    const content = await readSkill(skillPath);
    const parsed = parseFrontmatter(content);
    mainSkills.push({ path: skillPath, ...parsed });
  }
  return {
    prompt: `## Skills\n以下技能提供了专业任务的专用指令。\n当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。\n${buildSkillPrompt(mainSkills)}`,
    tools: createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills: [], tertiarySkills: [] }, u.getPath("skills"), readSkill),
  };
}
