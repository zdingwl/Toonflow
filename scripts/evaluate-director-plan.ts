/** Isolated text evaluation: read-only DB and the effective production vendor template. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import crypto from "node:crypto";
import { VM } from "vm2";
import { transform } from "sucrase";
import axios from "axios";
import FormData from "form-data";
import jsonwebtoken from "jsonwebtoken";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createZhipu } from "zhipu-ai-provider";
import { createQwen } from "qwen-ai-provider-v5";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createMinimax } from "vercel-minimax-ai-provider";
import { generateText, tool, jsonSchema, stepCountIs } from "ai";
import { buildDirectorPlanContext, readDirectorNarrative, DIRECTOR_PLAN_OUTPUT_CONTRACT, directorPlanTemperature, directorPlanOutputTokenLimit } from "../src/agents/productionAgent/directorPlanContext";
import { screenplayFacts, validateDirectorFacts } from "../src/agents/productionAgent/screenplay";
import { extractDirectorPlan } from "../src/agents/productionAgent/directorPlan";
import { validateDirectorExecution } from "../src/agents/productionAgent/directorPlanQuality";
import { withContentConstraints } from "../src/utils/contentConstraints";

const Database = createRequire(path.resolve("package.json"))("better-sqlite3") as new (file: string, options: { readonly: true }) => {
  prepare(sql: string): { get(...params: unknown[]): any };
  close(): void;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const secrets: string[] = [];
const redact = (message: string) => secrets.filter(Boolean).reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), message);

/** Match AiText's advanced/simple/fallback selection without importing application DB. */
export function resolveDirectorDeployment(mode: string | undefined, child: any, parent: any) {
  const config = mode === "1" ? child : mode === "0" ? parent : child?.modelName ? child : parent;
  if (!config?.modelName) throw new Error(`未找到当前模式的导演模型配置（agentUseMode=${mode ?? "未设置"}）`);
  return config;
}

/** Read an unchanged candidate and direct-review feedback; neither is new screenplay evidence. */
export async function readDirectorReviewFeedback(candidateFile?: string, feedbackFile?: string) {
  if (candidateFile === undefined && feedbackFile === undefined) return null;
  if (!candidateFile || !feedbackFile) throw new Error("--review-candidate 与 --review-feedback 必须成对指定");
  const candidatePath = path.resolve(candidateFile);
  const feedbackPath = path.resolve(feedbackFile);
  if (path.extname(candidatePath).toLowerCase() !== ".md") throw new Error("--review-candidate 必须为候选正文 .md 文件");
  if (![".txt", ".md"].includes(path.extname(feedbackPath).toLowerCase())) throw new Error("--review-feedback 必须为 .txt 或 .md 文件");
  const [candidate, feedback] = await Promise.all([fs.readFile(candidatePath, "utf8"), fs.readFile(feedbackPath, "utf8")]);
  if (!candidate.trim() || !feedback.trim()) throw new Error("直接审稿的候选与反馈均不能为空");
  if (/<\/?scriptPlan\b/i.test(candidate)) throw new Error("--review-candidate 必须是未经修改的候选 Markdown 正文，不含 scriptPlan XML 标签");
  return { candidatePath, candidateHash: hash(candidate), candidate, feedbackPath, feedbackHash: hash(feedback), feedback };
}

function readProductionEvidence(episodeId: number) {
  const db = new Database(path.resolve("data/db2.sqlite"), { readonly: true });
  try {
    const source = db.prepare("select * from o_script where id=?").get(episodeId);
    if (!source?.content) throw new Error("剧本不存在或为空");
    const project = db.prepare("select * from o_project where id=?").get(source.projectId);
    if (!project) throw new Error("剧本所属项目不存在");
    const agentUseMode = db.prepare("select value from o_setting where key='agentUseMode'").get()?.value;
    const child = db.prepare("select * from o_agentDeploy where key='productionAgent:directorPlanAgent'").get();
    const parent = db.prepare("select * from o_agentDeploy where key='productionAgent'").get();
    const config = resolveDirectorDeployment(agentUseMode, child, parent);
    const [vendorId, modelName] = String(config.modelName).split(/:(.+)/);
    if (!vendorId || !modelName || !/^[a-zA-Z0-9_-]+$/.test(vendorId)) throw new Error("当前导演模型配置无效");
    const vendor = db.prepare("select inputValues,models from o_vendorConfig where id=?").get(vendorId);
    if (!vendor) throw new Error(`当前导演供应商不存在：${vendorId}`);
    let inputValues: Record<string, string>;
    try { inputValues = JSON.parse(vendor.inputValues ?? "{}"); }
    catch { throw new Error("当前供应商输入配置不是有效 JSON"); }
    for (const [key, value] of Object.entries(inputValues)) {
      if (/key|token|secret|password/i.test(key) && typeof value === "string" && value) secrets.push(value, value.replace(/^Bearer\s+/i, ""));
    }
    const workspace = db.prepare("select data from o_agentWorkData where projectId=? and episodesId=? and key='productionAgent'").get(source.projectId, episodeId);
    const workspaceData = workspace?.data ?? "";
    const currentPlan = workspaceData ? JSON.parse(workspaceData).scriptPlan ?? "" : "";
    return { source, project, agentUseMode, child, config, vendorId, modelName, inputValues,
      customModels: JSON.parse(vendor.models ?? "[]"), currentPlan, workspaceHash: hash(workspaceData) };
  } finally { db.close(); }
}

/** Use the same SDK factories and actual textRequest as src/utils/vm.ts; no app imports. */
export function loadVendorTemplate(code: string, requestSettings: Array<Record<string, unknown>>) {
  const exports: Record<string, any> = {};
  const unsupported = () => { throw new Error("隔离导演评估不允许图片、视频或其他业务操作"); };
  const trackedFetch: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    // Keep only adapter settings, never headers, API keys or arbitrary request bodies.
    requestSettings.push({ model: body.model, temperature: body.temperature, max_tokens: body.max_tokens,
      thinking: body.thinking, reasoning_effort: body.reasoning_effort, stream: body.stream });
    return fetch(url, init);
  };
  const vm = new VM({ timeout: 0, compiler: "javascript", eval: false, wasm: false, sandbox: {
    createOpenAI, createDeepSeek, createZhipu, createQwen, createAnthropic, createOpenAICompatible,
    createXai, createMinimax, createGoogleGenerativeAI,
    fetch: trackedFetch, exports, axios, FormData, Buffer, jsonwebtoken, crypto, logger: () => {},
    zipImage: unsupported, zipImageResolution: unsupported, urlToBase64: unsupported,
    mergeImages: unsupported, pollTask: unsupported,
  } });
  vm.run(transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, ""));
  if (!exports.vendor || typeof exports.textRequest !== "function") throw new Error("供应商模板未提供 vendor/textRequest");
  return exports;
}

async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1]) throw new Error("使用 --episode ID --output 文件 [--skill 文件 --context legacy|current --existing-plan ignore|include --dry-run true|false --think true|false --think-level 0..3 --max-attempts 1..3 --review-candidate 候选.md --review-feedback 反馈.txt或.md]");
    args.set(process.argv[i].slice(2), process.argv[i + 1]);
  }
  const episodeId = Number(args.get("episode"));
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0 || !args.get("output")) throw new Error("必须指定有效集 ID 与独立输出文件");
  const existingPlan = args.get("existing-plan") ?? "include";
  if (!["ignore", "include"].includes(existingPlan)) throw new Error("--existing-plan 必须为 ignore 或 include");
  const dryRun = args.get("dry-run") === "true";
  const think = args.get("think") === "true";
  for (const key of ["dry-run", "think"]) {
    if (args.has(key) && !["true", "false"].includes(args.get(key)!)) throw new Error(`--${key} 必须为 true 或 false`);
  }
  const thinkLevel = Number(args.get("think-level") ?? 0);
  if (![0, 1, 2, 3].includes(thinkLevel)) throw new Error("--think-level 必须为 0..3");
  const maxAttempts = Number(args.get("max-attempts") ?? 3);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("--max-attempts 必须为 1..3");
  const directReview = await readDirectorReviewFeedback(args.get("review-candidate"), args.get("review-feedback"));
  const output = path.resolve(args.get("output")!);
  const outputRelative = path.relative(path.resolve("docs/director-plan-evaluation"), output);
  if (path.extname(output) !== ".md" || outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) throw new Error("输出必须位于 docs/director-plan-evaluation 且为 .md");
  const metadataOutput = output.replace(/\.md$/, ".json");
  const inputOutput = output.replace(/\.md$/, ".input.json");
  const rawOutput = output.replace(/\.md$/, ".response.xml");
  const attemptFiles = Array.from({ length: maxAttempts }, (_, index) => {
    const prefix = output.replace(/\.md$/, `.attempt-${index + 1}`);
    return { rawOutput: `${prefix}.response.xml`, planOutput: `${prefix}.md`, metadataOutput: `${prefix}.json` };
  });
  for (const file of [output, metadataOutput, inputOutput, rawOutput, ...attemptFiles.flatMap(files => Object.values(files))]) {
    try { await fs.access(file); throw new Error("评估输出或证据文件已存在，请指定新文件名"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const evidence = readProductionEvidence(episodeId);
  const { source, project, config, vendorId, modelName } = evidence;
  const currentPlan = existingPlan === "include" ? evidence.currentPlan : "";
  const skillsRoot = path.resolve("data/skills");
  const read = (file: string) => fs.readFile(file, "utf8");
  const skillPath = path.resolve(args.get("skill") ?? path.join(skillsRoot, "production_execution_director_plan.md"));
  const system = await read(skillPath);
  const legacy = args.get("context") === "legacy";
  if (args.has("context") && !["legacy", "current"].includes(args.get("context")!)) throw new Error("--context 必须为 legacy 或 current");
  const narrative = await readDirectorNarrative(skillsRoot, project.directorManual, read);
  const context = legacy ? `【程序解析的剧本事实】\n${screenplayFacts(source.content, currentPlan)}`
    : buildDirectorPlanContext(project, source.content, currentPlan, narrative);
  const vendorPath = path.resolve("data/vendor", `${vendorId}.ts`);
  const vendorCode = await read(vendorPath);
  const requestSettings: Array<Record<string, unknown>> = [];
  const running = loadVendorTemplate(vendorCode, requestSettings);
  Object.assign(running.vendor.inputValues, evidence.inputValues);
  const combinedModels = new Map<string, any>();
  for (const candidate of [...running.vendor.models, ...evidence.customModels]) combinedModels.set(candidate.modelName, candidate);
  const selectedModel = combinedModels.get(modelName);
  if (!selectedModel || selectedModel.type !== "text") throw new Error(`当前供应商未提供文本模型：${modelName}`);
  running.vendor.models = [...combinedModels.values()];
  const model = await running.textRequest(selectedModel, think, thinkLevel);
  // Production caps the child director temperature even when simple mode uses the parent model.
  const temperature = legacy ? config.temperature ?? 1 : directorPlanTemperature(evidence.child?.temperature);
  const maxOutputTokens = legacy ? config.maxOutputTokens || undefined : directorPlanOutputTokenLimit(config.maxOutputTokens);
  const actualSystem = withContentConstraints(system + DIRECTOR_PLAN_OUTPUT_CONTRACT);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: `根据当前完整剧本生成导演计划，让短剧更有吸引力且可执行。保持全部原文事实${existingPlan === "include" ? "和已有制作预算" : "，不参考已保存计划"}。${DIRECTOR_PLAN_OUTPUT_CONTRACT}\n${context}` }];
  if (directReview) messages.push({ role: "assistant", content: `<scriptPlan>\n${directReview.candidate}\n</scriptPlan>` }, {
    role: "user", content: `【外部直接审稿反馈：仅是上一候选的问题，不是剧本来源事实】\n${directReview.feedback}\n核对并修复上述问题，事实仍以初始消息的完整原剧本和程序事实为准，保留原文、台词、事件顺序与已确认制作预算，重新排拍并生成全部导演规划。只输出单份最终且唯一闭合的 <scriptPlan>…</scriptPlan>，每场仅一张最终节拍表；不输出草稿、修正版说明或自评。`,
  });
  const inputEvidence = {
    episodeId, projectId: source.projectId, agentUseMode: evidence.agentUseMode ?? null,
    deploymentKey: config.key, model: config.modelName, vendorId, vendorPath,
    skillPath, existingPlan, context: legacy ? "legacy" : "current", think, thinkLevel, temperature, maxAttempts,
    maxOutputTokens: maxOutputTokens ?? null,
    sourceHash: hash(source.content), savedProductionPlanHash: hash(evidence.currentPlan), productionWorkspaceHash: evidence.workspaceHash,
    skillHash: hash(system), narrativeHash: hash(narrative), vendorTemplateHash: hash(vendorCode),
    ...(directReview ? { hasDirectReviewFeedback: true, directReview } : {}),
    inputHash: hash(JSON.stringify({ system: actualSystem, messages })), system: actualSystem, messages,
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(inputOutput, JSON.stringify(inputEvidence, null, 2), { flag: "wx" });
  const metadataBase = { episodeId, projectId: source.projectId, model: config.modelName, vendorId,
    deploymentKey: config.key, agentUseMode: evidence.agentUseMode ?? null, temperature, maxOutputTokens: maxOutputTokens ?? null, think, thinkLevel,
    existingPlan, context: legacy ? "legacy" : "current", dryRun, maxAttempts,
    sourceHash: inputEvidence.sourceHash, savedProductionPlanHash: inputEvidence.savedProductionPlanHash,
    skillHash: inputEvidence.skillHash, vendorTemplateHash: inputEvidence.vendorTemplateHash, inputHash: inputEvidence.inputHash,
    productionWorkspaceHashBefore: evidence.workspaceHash,
    ...(directReview ? { hasDirectReviewFeedback: true,
      reviewCandidatePath: directReview.candidatePath, reviewCandidateHash: directReview.candidateHash,
      reviewFeedbackPath: directReview.feedbackPath, reviewFeedbackHash: directReview.feedbackHash } : {}),
  };
  if (dryRun) {
    const after = readProductionEvidence(episodeId);
    const metadata = { ...metadataBase, productionWorkspaceHashAfter: after.workspaceHash,
      productionWorkspaceUnchanged: after.workspaceHash === evidence.workspaceHash, generated: false, attempts: [] };
    await fs.writeFile(metadataOutput, JSON.stringify(metadata, null, 2), { flag: "wx" });
    console.log(JSON.stringify(metadata));
    return;
  }
  const started = Date.now();
  const attempts: Array<Record<string, any>> = [];
  let lastPlan = "", lastResponse = "", lastErrors: string[] = [];
  let providerError: string | undefined;
  try {
    for (let index = 0; index < maxAttempts; index++) {
      const files = attemptFiles[index];
      const attemptStarted = Date.now();
      const settingsStart = requestSettings.length;
      const inputHash = hash(JSON.stringify({ system: actualSystem, messages }));
      const feedback = index ? messages[messages.length - 1].content : null;
      const generateAttempt = () => generateText({
        model, system: actualSystem, messages,
        temperature, ...(maxOutputTokens ? { maxOutputTokens } : {}),
        abortSignal: AbortSignal.timeout(600000), stopWhen: stepCountIs(8),
        tools: {
          get_flowData: tool({
            description: "只读获取本次剧本与已保存计划；无写入权限",
            inputSchema: jsonSchema<{ key: string; offset?: number; limit?: number }>({ type: "object", properties: { key: { type: "string", enum: ["script", "scriptPlan"] }, offset: { type: "number" }, limit: { type: "number" } }, required: ["key"], additionalProperties: false }),
            execute: async ({ key, offset = 0, limit }) => {
              const text = key === "script" ? source.content : currentPlan;
              if (limit === undefined) return text;
              return { data: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null };
            },
          }),
        },
      });
      let result: Awaited<ReturnType<typeof generateAttempt>>;
      try {
        result = await generateAttempt();
      } catch (error) {
        providerError = redact(error instanceof Error ? error.message : "评估请求失败");
        const attempt = { attempt: index + 1, inputHash, feedback, elapsedMs: Date.now() - attemptStarted,
          generated: false, verdict: "ERROR", error: providerError, metadataOutput: files.metadataOutput,
          requestSettings: requestSettings.slice(settingsStart) };
        attempts.push(attempt);
        await fs.writeFile(files.metadataOutput, JSON.stringify({ ...metadataBase, ...attempt }, null, 2), { flag: "wx" });
        break;
      }
      // Save the untouched response before running any extractor or content checker.
      await fs.writeFile(files.rawOutput, result.text, { encoding: "utf8", flag: "wx" });
      let plan = "", extractionErrors: string[] = [], factErrors: string[] = [], executionErrors: string[] = [];
      try { plan = extractDirectorPlan(result.text); }
      catch (error) { extractionErrors = [redact(error instanceof Error ? error.message : "导演计划提取失败")]; }
      if (plan) {
        factErrors = validateDirectorFacts(source.content, plan).map(redact);
        executionErrors = validateDirectorExecution(source.content, plan).map(redact);
      }
      const errors = [...extractionErrors, ...factErrors, ...executionErrors];
      lastPlan = plan; lastResponse = result.text; lastErrors = errors;
      // Retain every untouched candidate, including failures; evaluation never commits to production.
      await fs.writeFile(files.planOutput, plan || result.text, { encoding: "utf8", flag: "wx" });
      const attempt = { attempt: index + 1, inputHash, feedback, elapsedMs: Date.now() - attemptStarted,
        finishReason: result.finishReason, usage: result.usage, steps: result.steps.length,
        readKeys: result.steps.flatMap(step => step.toolCalls.map(call => call.input)),
        characters: plan.length, rawResponseHash: hash(result.text), extractionErrors, factErrors, executionErrors,
        validationErrors: errors, verdict: errors.length ? "FAIL" : "PASS", generated: true, ...files,
        requestSettings: requestSettings.slice(settingsStart) };
      attempts.push(attempt);
      await fs.writeFile(files.metadataOutput, JSON.stringify({ ...metadataBase, ...attempt }, null, 2), { flag: "wx" });
      if (!errors.length) break;
      if (index + 1 < maxAttempts) {
        messages.push({ role: "assistant", content: result.text }, { role: "user", content:
          `上轮导演规划未通过检查，具体问题：\n${errors.map((error, errorIndex) => `${errorIndex + 1}. ${error}`).join("\n")}\n依据完整原剧本与原制作预算逐项修复并重新排拍，保留原文事实、台词和顺序，不增加预算。只输出单份最终、唯一闭合的 <scriptPlan>…</scriptPlan>；每场仅一张最终节拍表，不输出草稿、修正版说明或自评。` });
      }
    }
    const verdict = providerError ? "ERROR" : lastErrors.length ? "FAIL" : "PASS";
    const audit = ["# 导演规划隔离评估", "", `检查结果：${verdict}；最多 ${maxAttempts} 轮，实际 ${attempts.length} 轮。`, "",
      "| 轮次 | 结果 | 原始响应 | 原样候选 | 检查证据 |", "|---|---|---|---|---|",
      ...attempts.map(attempt => {
        const link = (file?: string) => file ? `[${path.basename(file)}](./${path.basename(file)})` : "无响应";
        return `| ${attempt.attempt} | ${attempt.verdict} | ${link(attempt.rawOutput)} | ${link(attempt.planOutput)} | ${link(attempt.metadataOutput)} |`;
      }), "", ...(providerError ? [`请求错误：${providerError}`, ""] : []),
      ...(lastResponse ? ["## 最后一份原样候选", "", lastPlan || lastResponse] : ["未取得模型响应。"]), "",
    ].join("\n");
    if (lastResponse) await fs.writeFile(rawOutput, lastResponse, { encoding: "utf8", flag: "wx" });
    await fs.writeFile(output, audit, { encoding: "utf8", flag: "wx" });
    const after = readProductionEvidence(episodeId);
    const lastGenerated = [...attempts].reverse().find(attempt => attempt.generated);
    const metadata = { ...metadataBase, elapsedMs: Date.now() - started, verdict, passed: verdict === "PASS",
      attemptCount: attempts.length, attempts, finalCandidateOutput: lastGenerated?.planOutput ?? null,
      finishReason: lastGenerated?.finishReason ?? null, usage: lastGenerated?.usage ?? null,
      steps: lastGenerated?.steps ?? 0, readKeys: lastGenerated?.readKeys ?? [],
      characters: lastPlan.length, rawResponseHash: lastResponse ? hash(lastResponse) : null,
      extractionErrors: lastGenerated?.extractionErrors ?? [], factErrors: lastGenerated?.factErrors ?? [],
      executionErrors: lastGenerated?.executionErrors ?? [], validationErrors: lastErrors, requestSettings,
      ...(providerError ? { error: providerError } : {}),
      productionWorkspaceHashAfter: after.workspaceHash, productionWorkspaceUnchanged: after.workspaceHash === evidence.workspaceHash,
      generated: attempts.some(attempt => attempt.generated) };
    await fs.writeFile(metadataOutput, JSON.stringify(metadata, null, 2), { flag: "wx" });
    console.log(JSON.stringify(metadata));
    if (verdict !== "PASS") process.exitCode = 1;
  } catch (error) {
    await fs.writeFile(metadataOutput, JSON.stringify({ ...metadataBase, elapsedMs: Date.now() - started,
      generated: attempts.some(attempt => attempt.generated), attempts, requestSettings,
      error: redact(error instanceof Error ? error.message : "评估失败") }, null, 2), { flag: "wx" });
    throw error;
  }
}
if (require.main === module) main().catch(error => { console.error(redact(error instanceof Error ? error.message : "评估失败")); process.exitCode = 1; });
