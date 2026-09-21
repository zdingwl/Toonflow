import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
