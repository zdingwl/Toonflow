import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateAssetPrompt, type AssetPromptContext } from "../src/utils/assetPromptGeneration";

const validPrompt = "购物车独立静物设计参考，银灰色金属车架、四轮结构，材质和受力关系清晰，纯色背景，无人物、文字或水印。";
const context: AssetPromptContext = {
  input: { projectId: 1, assetsId: 126, type: "tool", name: "购物车", describe: "银灰色金属购物车，四轮结构" },
  asset: { id: 126, assetsId: null, type: "tool", name: "购物车", describe: "银灰色金属购物车，四轮结构", prompt: "旧提示词", selectedImagePath: null },
  parent: null, derivativeStates: [], references: [],
};
const manual = "写实3D道具，采用可读的金属材质，保留原设定，不新增人物。";

function offlineSdk(reply: (request: any, index: number) => string, modelName = "doubao-seed-2-1-pro-260915") {
  const requests: any[] = [];
  let providerOptions: any;
  const fakeFetch = async (_url: unknown, options?: RequestInit) => {
    const request = JSON.parse(String(options?.body));
    requests.push(request);
    return new Response(JSON.stringify({
      id: "offline-" + requests.length, object: "chat.completion", created: 0, model: modelName,
      choices: [{ index: 0, message: { role: "assistant", content: reply(request, requests.length - 1) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  // Load the deployed adapter, preserving its request wrapper and capability options.
  // The lexical fetch is always fake: neither credentials nor a network call are needed.
  const adapter: any = {};
  const code = transform(readFileSync("data/vendor/volcengine.ts", "utf8"), { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  new Function("exports", "createOpenAICompatible", "fetch", code)(adapter, (options: any) => {
    providerOptions = options;
    return createOpenAICompatible(options);
  }, fakeFetch);
  adapter.vendor.inputValues.apiKey = "offline-placeholder";
  adapter.vendor.inputValues.baseUrl = "http://unused.invalid/v1";
  const model = adapter.textRequest({ modelName, type: "text" }, false, 0);
  return {
    requests, providerOptions,
    deps: {
      loadImage: async () => { throw new Error("This text-only fixture must not load images"); },
      invoke: (input: any) => generateText({ ...input, model }),
    },
  };
}

for (const modelName of ["doubao-seed-2-1-pro-260915", "doubao-seed-2-0-pro-260215"]) {
  test(modelName + " uses strict SDK JSON schema for audit, leaves writer as text, and retries malformed JSON once", async () => {
    const sdk = offlineSdk((_request, index) => [validPrompt, '{ "passed":false,issues":["格式错误"]}', '{"passed":true,"issues":[]}'][index], modelName);
    assert.equal(await generateAssetPrompt(sdk.deps, context, manual), validPrompt);
    assert.equal(sdk.providerOptions.supportsStructuredOutputs, true);
    assert.equal(sdk.requests.length, 3);
    assert.equal(sdk.requests[0].response_format, undefined);
    for (const request of sdk.requests.slice(1)) {
      assert.equal(request.model, modelName);
      assert.equal(request.response_format.type, "json_schema");
      assert.equal(request.response_format.json_schema.strict, true);
      const schema = request.response_format.json_schema.schema;
      assert.equal(schema.type, "object");
      assert.deepEqual(schema.required, ["passed", "issues"]);
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.passed.type, "boolean");
      assert.equal(schema.properties.issues.type, "array");
      assert.equal(schema.properties.issues.items.type, "string");
    }
  });
}

for (const modelName of ["offline-unknown-model", "doubao-seed-2-1-pro-260915-custom"]) {
  test(modelName + " keeps default provider capabilities and falls back to JSON object audit", async () => {
    const sdk = offlineSdk(request => request.response_format ? '{"passed":true,"issues":[]}' : validPrompt, modelName);
    assert.equal(await generateAssetPrompt(sdk.deps, context, manual), validPrompt);
    assert.equal(Object.hasOwn(sdk.providerOptions, "supportsStructuredOutputs"), false);
    assert.equal(sdk.requests.length, 2);
    assert.equal(sdk.requests[0].response_format, undefined);
    assert.deepEqual(sdk.requests[1].response_format, { type: "json_object" });
  });
}

test("valid negative audit JSON remains a content failure and never becomes an approval", async () => {
  let writerCalls = 0, auditCalls = 0;
  const sdk = offlineSdk(request => {
    if (request.response_format) {
      auditCalls++;
      return '{"passed":false,"issues":["目标要求金属车架，待审提示词却改成塑料车架"]}';
    }
    writerCalls++;
    return validPrompt;
  });
  await assert.rejects(generateAssetPrompt(sdk.deps, context, manual), /目标要求金属车架/);
  assert.equal(writerCalls, 2); assert.equal(auditCalls, 2);
  assert.deepEqual(sdk.requests.map(request => Boolean(request.response_format)), [false, true, false, true]);
});

test("repeated malformed SDK audit responses fail closed after one formatting retry", async () => {
  let writerCalls = 0, auditCalls = 0;
  const sdk = offlineSdk(request => {
    if (request.response_format) { auditCalls++; return '{ "passed":false,issues":["bad JSON"]}'; }
    writerCalls++; return validPrompt;
  });
  await assert.rejects(generateAssetPrompt(sdk.deps, context, manual));
  assert.equal(writerCalls, 1); assert.equal(auditCalls, 2);
});

function textClientFixture(configTemperature: number) {
  const calls: any[] = [];
  const localRequire = createRequire(process.cwd() + "/package.json");
  const modelConfig = { modelName: "offline:model", temperature: configTemperature, maxOutputTokens: 0 };
  const imports: Record<string, unknown> = {
    "@/utils": {
      db: (table: string) => ({ where: () => ({ first: async () => table === "o_setting" ? { value: "0" } : modelConfig }) }),
    },
    "./contentConstraints": { withContentConstraints: (system: unknown) => system, withNonGraphicVisuals: (prompt: string) => prompt },
    "ai": {
      ...localRequire("ai"),
      generateText: async (input: any) => { calls.push(input); return { text: "mock" }; },
      streamText: (input: any) => { calls.push(input); return { text: Promise.resolve("mock") }; },
    },
  };
  const mod = { exports: {} as any };
  const code = transform(readFileSync("src/utils/ai.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => imports[id] || localRequire(id), mod, mod.exports);
  const client = mod.exports.default.Text("universalAi");
  client.resolveModel = async () => ({ modelId: "offline-model" });
  return { client, calls };
}

for (const method of ["invoke", "stream"] as const) {
  test(method + " respects an explicit zero or nonzero temperature before deployment defaults", async () => {
    const f = textClientFixture(1);
    await f.client[method]({ prompt: "audit", temperature: 0 });
    await f.client[method]({ prompt: "writer", temperature: 0.2 });
    await f.client[method]({ prompt: "use configured default" });
    assert.deepEqual(f.calls.map(call => call.temperature), [0, 0.2, 1]);
    const zero = textClientFixture(0);
    await zero.client[method]({ prompt: "configured zero" });
    assert.equal(zero.calls[0].temperature, 0);
  });
}
