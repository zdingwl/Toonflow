import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const component = readFileSync(new URL("../Toonflow-web-master/src/views/script/components/batchAddScript.vue", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/script/batchAddScript.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

test("批量导入只要求勾选剧集，不按所有剧集的总字数禁用保存", () => {
  const saveButton = component.match(/<t-button\s+theme="primary"\s+style="margin-left: 10px"\s+:disabled="([^"]+)"\s+:loading="nextLoading"\s+@click="keep">\s*保存\s*<\/t-button>/)?.[1];
  assert.equal(saveButton, "!selectedRows.length");
  assert.doesNotMatch(component, /selectedTextLength\s*>\s*otherSetting\.scriptEpisodeLength/);
  assert.match(component, /selectedTextLength\s*=\s*computed\(/, "仍展示已选字数");
});

test("批量保存接口接收多集完整文本，服务端 JSON 容量大于单次选中剧本", () => {
  assert.match(route, /scriptData:\s*z\.string\(\)/);
  assert.match(route, /u\.db\("o_script"\)\.insert\(/);
  assert.match(server, /express\.json\(\{\s*limit:\s*"100mb"\s*\}\)/);
});

test("AI 正则失败时保留接口错误或提供明确兜底，不再只弹出空白图标", () => {
  const declaration = component.match(/function getAiRegexErrorMessage\(reason: unknown\): string \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration, "必须解析 API 错误及网络错误");
  const js = ts.transpileModule(declaration, { fileName: "error.ts", compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const explain = new Function(`${js}\nreturn getAiRegexErrorMessage;`)();
  assert.equal(explain({ message: "未配置通用AI文本模型" }), "未配置通用AI文本模型");
  assert.equal(explain({ response: { data: { message: "AI返回的正则语法不合法" } } }), "AI返回的正则语法不合法");
  assert.equal(explain({ message: "   " }).length > 0, true);
  assert.equal(explain(null).length > 0, true);
  assert.match(component, /v-if="aiRegexError"\s+role="alert"/);
  assert.match(component, /window\.\$message\.error\(aiRegexError\.value\)/);
  assert.match(component, /const \{ data \} = await axios\.post\("\/script\/getAiRegex"/);
});
