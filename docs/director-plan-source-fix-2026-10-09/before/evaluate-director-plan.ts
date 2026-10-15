/** Isolated text evaluation: read-only DB, configured Ollama only, no production writes or generation tools. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool, jsonSchema, stepCountIs } from "ai";
import { buildDirectorPlanContext, readDirectorNarrative, DIRECTOR_PLAN_OUTPUT_CONTRACT, directorPlanTemperature } from "../src/agents/productionAgent/directorPlanContext";
import { screenplayFacts, validateDirectorFacts } from "../src/agents/productionAgent/screenplay";
import { extractDirectorPlan } from "../src/agents/productionAgent/directorPlan";
import { withContentConstraints } from "../src/utils/contentConstraints";

const Database = createRequire(path.resolve("package.json"))("better-sqlite3") as new (file: string, options: { readonly: true }) => {
  prepare(sql: string): { get(...params: unknown[]): any };
  close(): void;
};

async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1]) throw new Error("使用 --episode ID --output 文件 [--skill 文件 --context legacy|current]");
    args.set(process.argv[i].slice(2), process.argv[i + 1]);
  }
  const episodeId = Number(args.get("episode"));
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0 || !args.get("output")) throw new Error("必须指定有效集 ID 与独立输出文件");
  const output = path.resolve(args.get("output")!);
  const outputRelative = path.relative(path.resolve("docs/director-plan-evaluation"), output);
  if (path.extname(output) !== ".md" || outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) throw new Error("输出必须位于 docs/director-plan-evaluation 且为 .md");
  try { await fs.access(output); throw new Error("评估文件已存在，请指定新文件名"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const db = new Database(path.resolve("data/db2.sqlite"), { readonly: true });
  let source: any, project: any, config: any, vendor: any, currentPlan: string;
  try {
    source = db.prepare("select * from o_script where id=?").get(episodeId);
    if (!source?.content) throw new Error("剧本不存在或为空");
    project = db.prepare("select * from o_project where id=?").get(source.projectId);
    config = db.prepare("select * from o_agentDeploy where key='productionAgent:directorPlanAgent'").get();
    if (config?.vendorId !== "ollama") throw new Error("此独立评估只支持当前配置的 Ollama；不切换供应商");
    vendor = JSON.parse((db.prepare("select inputValues from o_vendorConfig where id=?").get("ollama") as any).inputValues);
    const workspace: any = db.prepare("select data from o_agentWorkData where projectId=? and episodesId=? and key='productionAgent'").get(source.projectId, episodeId);
    currentPlan = workspace?.data ? JSON.parse(workspace.data).scriptPlan ?? "" : "";
  } finally { db.close(); }
  const skillsRoot = path.resolve("data/skills");
  const read = (file: string) => fs.readFile(file, "utf8");
  const system = await read(args.get("skill") ?? path.join(skillsRoot, "production_execution_director_plan.md"));
  const legacy = args.get("context") === "legacy";
  const context = legacy ? `【程序解析的剧本事实】\n${screenplayFacts(source.content, currentPlan)}`
    : buildDirectorPlanContext(project, source.content, currentPlan, await readDirectorNarrative(skillsRoot, project.directorManual, read));
  const address = vendor.baseUrl.trim().replace(/\/+$/, "");
  const provider = createOpenAICompatible({
    name: "ollama", baseURL: address.endsWith("/v1") ? address : `${address}/v1`,
    ...(vendor.apiKey?.trim() ? { apiKey: vendor.apiKey.trim().replace(/^Bearer\s+/i, "") } : {}),
    fetch: (url, init) => fetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(String(init?.body)), reasoning_effort: "none", seed: 42 }) }),
  });
  const model = config.modelName.replace(/^ollama:/, "");
  const temperature = legacy ? config.temperature ?? 1 : directorPlanTemperature(config.temperature);
  const started = Date.now();
  const result = await generateText({
    model: provider.chatModel(model), system: withContentConstraints(system + DIRECTOR_PLAN_OUTPUT_CONTRACT),
    messages: [{ role: "user", content: `根据当前完整剧本生成导演计划，让短剧更有吸引力且可执行。保持全部原文事实和已有制作预算。${DIRECTOR_PLAN_OUTPUT_CONTRACT}\n${context}` }],
    temperature, maxOutputTokens: config.maxOutputTokens || 12000,
    abortSignal: AbortSignal.timeout(600000), stopWhen: stepCountIs(8),
    tools: {
      get_flowData: tool({
        description: "只读获取本次剧本与已保存计划；无写入权限",
        inputSchema: jsonSchema<{ key: string; offset?: number; limit?: number }>({ type: "object", properties: { key: { type: "string", enum: ["script", "scriptPlan"] }, offset: { type: "number" }, limit: { type: "number" } }, required: ["key"], additionalProperties: false }),
        execute: async ({ key, offset = 0, limit }) => {
          const text = key === "script" ? source.content : currentPlan;
          if (limit === undefined) return { data: text, nextOffset: null };
          return { data: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null };
        },
      }),
    },
  });
  let plan = "", errors: string[] = [];
  try { plan = extractDirectorPlan(result.text); errors = validateDirectorFacts(source.content, plan); }
  catch (error) { errors = [(error as Error).message]; }
  // Never overwrite a skill, database, bundle or another production artifact.
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, plan || result.text, { encoding: "utf8", flag: "wx" });
  const metadata = { episodeId, projectId: source.projectId, model, temperature, reasoning: "none", seed: 42, context: legacy ? "legacy" : "current", elapsedMs: Date.now() - started, finishReason: result.finishReason, usage: result.usage, steps: result.steps.length, readKeys: result.steps.flatMap(step => step.toolCalls.map(call => call.input)), characters: plan.length, factErrors: errors };
  await fs.writeFile(output.replace(/\.md$/, ".json"), JSON.stringify(metadata, null, 2), { flag: "wx" });
  console.log(JSON.stringify(metadata));
  if (errors.length) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : "评估失败"); process.exitCode = 1; });
