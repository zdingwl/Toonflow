import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const component = readFileSync(new URL("../Toonflow-web-master/src/views/script/components/batchAddScript.vue", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/script/batchAddScript.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const add = readFileSync(new URL("../Toonflow-web-master/src/views/script/components/addScript.vue", import.meta.url), "utf8");
const edit = readFileSync(new URL("../Toonflow-web-master/src/views/script/components/editScript.vue", import.meta.url), "utf8");
const addRoute = readFileSync(new URL("../src/routes/script/addScript.ts", import.meta.url), "utf8");
const editRoute = readFileSync(new URL("../src/routes/script/updateScript.ts", import.meta.url), "utf8");

test("批量导入按单集字数校验，30 集合计超过 5000 字仍可保存", () => {
  const saveButton = component.match(/<t-button\s+theme="primary"\s+style="margin-left: 10px"\s+:disabled="([^"]+)"\s+:loading="nextLoading"\s+@click="keep">\s*保存\s*<\/t-button>/)?.[1];
  assert.equal(saveButton, "!selectedRows.length || !!selectedOversizedRows.length");
  assert.doesNotMatch(component, /selectedTextLength\s*>\s*otherSetting\.scriptEpisodeLength/);
  assert.match(component, /selectedTextLength\s*=\s*computed\(/, "仍展示已选剧集的总字数");
  assert.match(component, /selectedOversizedRows\s*=\s*computed\(\(\) => selectedRows\.value\.filter\(\(item\) => item\.scriptData\.length > otherSetting\.value\.scriptEpisodeLength\)\)/);
  assert.match(component, /v-if="selectedOversizedRows\.length"\s+role="alert"/);
  assert.match(component, /if \(selectedOversizedRows\.value\.length\)/, "提交前再次核对逐集限制");
  const rows = Array.from({ length: 30 }, (_, index) => ({ index: index + 1, scriptData: "文".repeat(1900) }));
  assert.ok(rows.reduce((sum, item) => sum + item.scriptData.length, 0) > 5000);
  assert.deepEqual(rows.filter((item) => item.scriptData.length > 5000), []);
  rows[11].scriptData = "文".repeat(5001);
  assert.deepEqual(rows.filter((item) => item.scriptData.length > 5000).map((item) => item.index), [12]);
});

test("新建和编辑仅按当前单集字数判断，保留正文必填与完整保存", () => {
  assert.match(add, /:disabled="scriptData\.length > otherSetting\.scriptEpisodeLength"/);
  assert.match(edit, /:disabled="props\.item\.content\.length > otherSetting\.scriptEpisodeLength"/);
  assert.match(add, /if \(scriptData\.value\.length > otherSetting\.value\.scriptEpisodeLength\)/);
  assert.match(edit, /if \(props\.item\.content\.length > otherSetting\.value\.scriptEpisodeLength\)/);
  assert.match(add, /if \(!scriptData\.value\.trim\(\)\)/);
  assert.match(add, /if \(!scriptName\.value\.trim\(\)\)/);
  assert.match(add, /scriptData\.length\s*\}\}\/\{\{ otherSetting\.scriptEpisodeLength \}\}/);
  assert.match(edit, /props\.item\.content\.length\s*\}\}\/\{\{ otherSetting\.scriptEpisodeLength \}\}/);
});

test("新增、编辑及批量保存接口均不截断剧本正文", () => {
  assert.match(addRoute, /content:\s*z\.string\(\)/);
  assert.match(editRoute, /content:\s*z\.string\(\)/);
  assert.match(route, /scriptData:\s*z\.string\(\)/);
  assert.match(addRoute, /content,\s*projectId,/);
  assert.match(editRoute, /name,\s*content,/);
  assert.match(route, /content:\s*i\.scriptData/);
  assert.match(server, /express\.json\(\{\s*limit:\s*"100mb"\s*\}\)/);
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
