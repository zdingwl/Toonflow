import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const backend = readFileSync(path.join(root, "src/routes/script/getAiRegex.ts"), "utf8");
const axios = readFileSync(path.join(root, "Toonflow-web-master/src/utils/axios.ts"), "utf8");
const compiled = ts.transpileModule(backend, {
  fileName: "getAiRegex.ts",
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
});
assert.deepEqual((compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error), []);

function makeRoute(reply = "") {
  let calls = 0;
  let prompt = "";
  const fakeAi = {
    Ai: { Text: () => ({ invoke: async (input) => {
      calls++;
      prompt = input.system;
      if (reply instanceof Error) throw reply;
      return { text: reply };
    } }) },
  };
  const chain = { min() { return this; }, max() { return this; } };
  const requireMock = (name) => {
    if (name === "express") return { Router: () => ({ post: (_, __, handler) => handler }) };
    if (name === "@/utils") return fakeAi;
    if (name === "zod") return { z: { string: () => chain } };
    if (name === "@/lib/responseFormat") return {
      success: (data) => ({ code: 200, data }),
      error: (message) => ({ code: 400, message, data: null }),
    };
    if (name === "@/middleware/middleware") return { validateFields: () => () => {} };
    throw new Error(`Unexpected import: ${name}`);
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputText)(requireMock, module, module.exports);
  const handler = module.exports.default;
  return {
    get calls() { return calls; },
    get prompt() { return prompt; },
    async request(content) {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        send(body) { this.body = body; return this; },
      };
      await handler({ body: { content } }, res);
      return res;
    },
  };
}

test("已可按默认规则拆集时复用原规则，无需调用通用AI模型", async () => {
  const route = makeRoute(new Error("未找到部署配置 universalAi"));
  const result = await route.request("第1集 起点\n内容\n第2集 转折\n内容");
  assert.equal(result.statusCode, 200);
  assert.equal(route.calls, 0);
  assert.match(result.body.data, /\\s\*/);
  assert.ok(new RegExp(result.body.data.slice(1, -2), "g").exec("第1集 起点"));
});

test("AI 正则示例保留反斜杠，去除代码围栏并验证两组实际可匹配", async () => {
  const route = makeRoute("```regex\n/^EPISODE\\s*(\\d+):\\s*([^\\n\\r]*)/gm\n```");
  const result = await route.request("EPISODE 1: Opening\n正文\nEPISODE 2: Next");
  assert.equal(result.statusCode, 200);
  assert.equal(route.calls, 1);
  assert.equal(result.body.data, "/^EPISODE\\s*(\\d+):\\s*([^\\n\\r]*)/gm");
  assert.ok(route.prompt.includes(String.raw`第\s*`), "提示词示例不能吞掉正则转义字符");
});

test("无效模型输出不覆盖手工拆集规则，模型配置缺失给出可读错误", async () => {
  for (const value of ["/(/g", "/^S(\\d+)$/gm", ""]) {
    const result = await makeRoute(value).request("S1: 起点\nS2: 后续");
    assert.equal(result.statusCode, 400);
    assert.ok(result.body.message.length > 5);
  }
  const missing = await makeRoute(new Error("未找到部署配置 universalAi")).request("S1: 起点");
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.message, /通用AI/);
});

test("HTTP 超时没有 Axios response 时，错误处理器不会二次抛出 TypeError", () => {
  assert.match(axios, /error\.response\?\.data\?\.message === "Network Error"/);
});
