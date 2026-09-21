import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const backend = readFileSync(path.join(root, "src/routes/script/getAiRegex.ts"), "utf8");
const axios = readFileSync(path.join(root, "Toonflow-web-master/src/utils/axios.ts"), "utf8");
const frontend = readFileSync(path.join(root, "Toonflow-web-master/src/views/script/components/batchAddScript.vue"), "utf8");
const parserSource = readFileSync(path.join(root, "Toonflow-web-master/src/utils/parseScript.ts"), "utf8");
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true };
const compiled = ts.transpileModule(backend, {
  fileName: "getAiRegex.ts",
  reportDiagnostics: true,
  compilerOptions,
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

test("即使默认正则匹配到多集，点击 AI 解析也必须请求模型而不是复用错误拆集数量", async () => {
  const route = makeRoute(String.raw`/^[ \t]*第[ \t]*(\d+)[ \t]*集[ \t]*([^\n\r]*)/gm`);
  const result = await route.request("第1集 起点\n内容\n第2集 转折\n内容");
  assert.equal(result.statusCode, 200);
  assert.equal(route.calls, 1);
  assert.match(result.body.data, /\/gm$/);
});

test("AI 正则示例保留反斜杠，去除代码围栏并验证两组实际可匹配", async () => {
  const route = makeRoute("```regex\n/^EPISODE\\s*(\\d+):\\s*([^\\n\\r]*)/gm\n```");
  const result = await route.request("EPISODE 1: Opening\n正文\nEPISODE 2: Next");
  assert.equal(result.statusCode, 200);
  assert.equal(route.calls, 1);
  assert.equal(result.body.data, "/^EPISODE\\s*(\\d+):\\s*([^\\n\\r]*)/gm");
  assert.ok(route.prompt.includes(String.raw`第[ \t]*`), "提示词应保留行首锚定和行内空白要求");
});

test("AI 正则拒绝行内误匹配、跨行吞正文、无效语法及捕获组缺失", async () => {
  const sample = "第1集 起点\n正文\n第2集 转折";
  for (const value of [String.raw`/第(\d+)集([^\n]*)/g`, String.raw`/^\s*第(\d+)集(.*)/gm`, String.raw`/^[ \\t]*第((\d+))集[ \\t]*([^\n\r]*)/gm`, "/(/g", "/^S(\\d+)$/gm", ""]) {
    const result = await makeRoute(value).request(sample);
    assert.equal(result.statusCode, 400, value);
    assert.ok(result.body.message.length > 5);
  }
  const missing = await makeRoute(new Error("未找到部署配置 universalAi")).request(sample);
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.message, /通用AI/);
});

test("AI 正则拒绝同一集号在样本中重复命中，避免把结尾字幕再次当成集标题", async () => {
  const route = makeRoute(String.raw`/^[ \t]*第[ \t]*(\d+)[ \t]*集[ \t]*([^\n\r]*)/gm`);
  const result = await route.request("第1集 起点\n正文\n第1集 起点（结尾字幕）\n第2集 转折\n正文");
  assert.equal(result.statusCode, 400);
  assert.match(result.body.message, /重复匹配|结尾字幕/);
});

test("任何来源的错误拆集正则都必须在第一步被拦截，不能继续显示成 62 集", () => {
  const declaration = frontend.match(/function validateEpisodeSequence\(episodes: Array<\{ index: number \}>\): string \| null \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration, "必须有统一的分集语义校验");
  const js = ts.transpileModule(declaration, { fileName: "validate.ts", compilerOptions }).outputText;
  const validate = new Function(`${js}\nreturn validateEpisodeSequence;`)();

  assert.equal(validate([{ index: 1 }, { index: 2 }, { index: 3 }]), null);
  assert.match(validate([{ index: 1 }, { index: 1 }, { index: 2 }]), /重复集号/);
  assert.match(validate([{ index: 1 }, { index: 3 }]), /不连续集号/);
  assert.match(frontend, /const semanticError = customRegStr\.value\.trim\(\) \? validateEpisodeSequence\(episodes\) : null/);
  assert.match(frontend, /if \(semanticError\) return \{ rows: \[\], error: semanticError \}/);
  assert.match(frontend, /:disabled="!content \|\| !tableData\.length \|\| !!effectiveRegexError"/);
});

test("前端必须先用完整剧本验证 AI 正则，再允许覆盖当前规则", () => {
  assert.match(frontend, /function validateAiRegexAgainstFullText\(regexText: string\)/);
  assert.match(frontend, /duplicates\.size/);
  assert.match(frontend, /const fullTextError = validateAiRegexAgainstFullText\(data\);/);
  const validationIndex = frontend.indexOf("validateAiRegexAgainstFullText(data)");
  const assignmentIndex = frontend.indexOf("customRegStr.value = data");
  assert.ok(validationIndex >= 0 && assignmentIndex > validationIndex, "全文校验必须发生在覆盖正则之前");
});

test("默认拆集只识别独立集标题行，不把正文的‘第X集’计为新集", () => {
  const js = ts.transpileModule(parserSource, { fileName: "parseScript.ts", compilerOptions }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", js)(module, module.exports);
  const episodes = module.exports.default("片名候选：\n1、候选标题\n第1集 开始\n对白：上一季第12集讲过此事\n第2集 转折\n正文结束");
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes.map((e) => e.index), [1, 2]);
  assert.match(episodes[0].text, /上一季第12集/);
});

test("AI 采样覆盖长剧本中后段而非只发送开头 2000 字", () => {
  const declaration = frontend.match(/function getEpisodeRegexSample\(text: string\): string \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration);
  const js = ts.transpileModule(declaration, { fileName: "sample.ts", compilerOptions }).outputText;
  const sample = new Function(`${js}\nreturn getEpisodeRegexSample;`)();
  const text = `${"片名候选：作品介绍\n".repeat(250)}第1集 起点\n${"正文内容\n".repeat(350)}第2集 发展\n${"情节描述\n".repeat(350)}第3集 结局\n`;
  const result = sample(text);
  assert.ok(result.length <= 6000);
  assert.match(result, /片名候选/);
  assert.match(result, /第3集 结局/);
  assert.match(frontend, /getEpisodeRegexSample\(content\.value\)/);
});

test("HTTP 超时没有 Axios response 时，错误处理器不会二次抛出 TypeError", () => {
  assert.match(axios, /error\.response\?\.data\?\.message === "Network Error"/);
});
