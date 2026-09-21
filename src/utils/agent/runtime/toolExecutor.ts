import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";

type ToolRecord = {
  execute?: (...args: any[]) => any;
  [key: string]: any;
};

const REQUEST_ID_TOOLS = new Set(["add_flowData_storyboard", "add_deriveAsset", "del_deriveAsset"]);

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true, type: typeof value });
  }
}

function parseStored(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function wrapAgentTools(
  tools: Record<string, ToolRecord>,
  options: {
    db: Knex;
    runId?: string;
    stepKey?: string;
    sideEffectTools?: Iterable<string>;
  },
): Record<string, ToolRecord> {
  if (!options.runId) return tools;
  const sideEffects = new Set(options.sideEffectTools ?? []);
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, definition]) => {
      if (typeof definition?.execute !== "function") return [toolName, definition];
      const original = definition.execute.bind(definition);
      return [
        toolName,
        {
          ...definition,
          execute: async (...args: any[]) => {
            const sideEffect = sideEffects.has(toolName);
            let input = args[0];
            if (
              sideEffect &&
              REQUEST_ID_TOOLS.has(toolName) &&
              input &&
              typeof input === "object" &&
              !Array.isArray(input) &&
              !(typeof input.requestId === "string" && input.requestId)
            ) {
              const seed = json(input);
              const requestId = "agent_" + createHash("sha256")
                .update(`${options.runId}\n${options.stepKey ?? "run"}\n${toolName}\n${seed}`)
                .digest("hex")
                .slice(0, 32);
              input = { ...input, requestId };
              args[0] = input;
            }
            const inputJson = json(input);
            const inputHash = createHash("sha256").update(inputJson).digest("hex");
            const operationKey = sideEffect
              ? createHash("sha256").update(`${options.runId}\n${options.stepKey ?? "run"}\n${toolName}\n${inputHash}`).digest("hex")
              : null;

            let id = randomUUID();
            const now = Date.now();
            if (operationKey) {
              const prior = await options.db("o_agentToolCall").where({ operationKey }).first();
              if (prior) {
                if (prior.status === "completed") return parseStored(prior.outputJson);
                if (prior.status !== "retryable") {
                  throw new Error(`工具 ${toolName} 的相同写操作当前状态为 ${prior.status}，必须先核对结果，不能重复执行`);
                }
                id = prior.id;
                const claimed = await options.db("o_agentToolCall").where({ id, status: "retryable" }).update({
                  status: "running",
                  error: null,
                  outputJson: null,
                  updateTime: now,
                });
                if (claimed !== 1) throw new Error(`工具 ${toolName} 的重试状态已变化，请重新核对`);
              } else {
                await options.db("o_agentToolCall").insert({
                  id,
                  runId: options.runId,
                  stepKey: options.stepKey ?? null,
                  toolName,
                  operationKey,
                  inputHash,
                  inputJson,
                  sideEffect: sideEffect ? 1 : 0,
                  status: "running",
                  createTime: now,
                  updateTime: now,
                });
              }
            } else {
              await options.db("o_agentToolCall").insert({
                id,
                runId: options.runId,
                stepKey: options.stepKey ?? null,
                toolName,
                operationKey,
                inputHash,
                inputJson,
                sideEffect: sideEffect ? 1 : 0,
                status: "running",
                createTime: now,
                updateTime: now,
              });
            }

            try {
              const result = await original(...args);
              await options.db("o_agentToolCall").where({ id, status: "running" }).update({
                status: "completed",
                outputJson: json(result),
                error: null,
                updateTime: Date.now(),
              });
              return result;
            } catch (error) {
              await options.db("o_agentToolCall").where({ id, status: "running" }).update({
                status: sideEffect ? "reconciling" : "failed",
                error: error instanceof Error ? error.message : String(error),
                updateTime: Date.now(),
              });
              throw error;
            }
          },
        },
      ];
    }),
  );
}
