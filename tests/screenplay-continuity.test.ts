import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScriptScenes, screenplayFacts, spokenCharacterCount, productionSceneBudget } from "../src/agents/productionAgent/screenplay";
import { extractSourceScene, validateStoryboardScene } from "../src/agents/productionAgent/storyboardValidator";
import { storyboardPlanSceneCount } from "../src/agents/productionAgent/storyboardRebuildDispatch";

const source = "场景一 外·船舷（0–5秒）\n\n艾娃抓住栏杆。\n\n艾娃\n\n麦迪逊，拉我上去！\n\n场景二 水下（5–10秒）\n\n艾娃\n\n回去。\n\n【核心07】";
const scene = (dialogue = "艾娃：『麦迪逊，拉我上去！』") => `## 场1：船舷
### 片段一（约5s）
**引用资产ID**：[1, 2]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 艾娃挂在船外 | 5 | 全景 | 固定 | ${dialogue} | 风声 |`;

test("中文场景标题与空行人名对白解析，字数不计标点", () => {
  const parsed = parseScriptScenes(source);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].sourceDuration, 5);
  assert.deepEqual(parsed[0].dialogue, [{ speaker: "艾娃", text: "麦迪逊，拉我上去！" }]);
  assert.equal(spokenCharacterCount(parsed[0].dialogue[0].text), 7);
  assert.deepEqual(parsed[1].screenText, ["核心07"]);
  assert.ok(!extractSourceScene(source, 1)!.includes("核心07"));
  assert.equal(parseScriptScenes("## 场景十一 内·屋（10-12秒）")[0].scene, 11);
  assert.equal(JSON.parse(screenplayFacts(source))[0].dialogue_count, 1);
});

test("同一说话人跨镜拆句通过，错人、遗漏和画面栏夹带台词失败", () => {
  const original = extractSourceScene(source, 1)!;
  assert.equal(validateStoryboardScene(1, scene(), original).coverageVerified, true);
  assert.equal(validateStoryboardScene(1, scene("麦迪逊：『麦迪逊，拉我上去！』"), original).valid, false);
  assert.equal(validateStoryboardScene(1, scene("无台词").replace("艾娃挂在船外", "艾娃挂在船外，麦迪逊，拉我上去！"), original).valid, false);
  const split = scene("艾娃：『麦迪逊，』").replace("| 5 |", "| 2 |") + "\n| 2 | 继续求救 | 3 | 近景 | 固定 | 艾娃：『拉我上去！』 | 风声 |";
  assert.equal(validateStoryboardScene(1, split, original).valid, true);
});

test("制作预算与原标注分开，Sc 汇总表场数可解析", () => {
  const plan = "| 场次 | 制作预算（秒） |\n|---|---|\n| Sc1 | 7 |\n| Sc2 | 5 |";
  assert.equal(storyboardPlanSceneCount(plan), 2);
  assert.equal(productionSceneBudget(plan, 1, source), 7);
  assert.equal(productionSceneBudget("", 1, source), 5);
  assert.throws(() => storyboardPlanSceneCount(plan.replace("Sc2", "Sc3")), /不连续/);
  assert.equal(validateStoryboardScene(1, scene(), extractSourceScene(source, 1), { targetDuration: 7 }).valid, false);
  assert.equal(validateStoryboardScene(1, scene().replace("约5s", "约6s"), undefined).valid, false);
});

test("资产 ID 按当前项目校验，必要屏幕文字不可遗漏", () => {
  assert.equal(validateStoryboardScene(1, scene(), undefined, { assetIds: [1] }).valid, false);
  assert.equal(validateStoryboardScene(1, scene(), undefined, { assetIds: [1, 2] }).valid, true);
  const board = scene("艾娃：『回去。』").replace("场1", "场2");
  assert.equal(validateStoryboardScene(2, board, extractSourceScene(source, 2)).valid, false);
  assert.equal(validateStoryboardScene(2, board.replace("挂在船外", "看到【核心07】"), extractSourceScene(source, 2)).valid, true);
});
