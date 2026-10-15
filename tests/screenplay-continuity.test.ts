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

test('跨说话人调换顺序不能靠各自台词集合通过', () => {
  const source = '场景一 船舷（0–5秒）\n艾娃\n拉我。\n麦迪逊\n姐姐。';
  assert.equal(validateStoryboardScene(1, scene('麦迪逊：『姐姐。』；艾娃：『拉我。』'), source).valid, false);
  assert.equal(validateStoryboardScene(1, scene('艾娃：『拉我。』；麦迪逊：『姐姐。』'), source).valid, true);
});

test('备注中的屏幕文字和包含数字的其他文字不能假装落到画面', () => {
  const original='场景一 海中（0–5秒）\n艾娃\n回去。\n【3】';
  const notes=scene('艾娃：『回去。』')+'\n备注：需要【3】';
  assert.equal(validateStoryboardScene(1, notes, original).valid, false);
  assert.equal(validateStoryboardScene(1, scene('艾娃：『回去。』').replace('艾娃挂在船外','显示【30m³】'), original).valid, false);
  assert.equal(validateStoryboardScene(1, scene('艾娃：『回去。』').replace('艾娃挂在船外','显示【3】'), original).valid, true);
});

test('清晰普通中文台词的镜头不能明显超载', () => {
  const original='场景一 室内（0–5秒）\n艾娃\n工业滤芯、移动储水罐、救生设备，有现货的全部给我报价。';
  assert.equal(validateStoryboardScene(1, scene('艾娃：『工业滤芯、移动储水罐、救生设备，有现货的全部给我报价。』'), original).valid, false);
});

test('屏幕承载保留冒号单位和出现次序，不把明确不显示的备注认证为显示',()=>{
 const source='场景一 海中（0–5秒）\n艾娃\n回去。\n【3】\n【2】\n【1】\n【71:58:41】';
 const board=(visual:string)=>scene('艾娃：『回去。』').replace('艾娃挂在船外',visual);
 assert.equal(validateStoryboardScene(1,board('显示【3】、【2】、【1】、【71:58:41】'),source).valid,true);
 assert.equal(validateStoryboardScene(1,board('显示【1】、【2】、【3】、【71:58:41】'),source).valid,false);
 assert.equal(validateStoryboardScene(1,board('显示【3】、【2】、【1】、【715841】'),source).valid,false);
 assert.equal(validateStoryboardScene(1,board('制作备注：本镜不显示【3】、【2】、【1】、【71:58:41】，后期另补'),source).valid,false);
});

test('一个连续镜头不能把插切蒙太奇藏在运镜列',()=>{
 assert.equal(validateStoryboardScene(1,scene().replace('| 固定 |','| 静止后再切到另一角度 |'),extractSourceScene(source,1)).valid,false);
 assert.equal(validateStoryboardScene(1,scene().replace('| 固定 |','| 蒙太奇三次快速硬切 |'),extractSourceScene(source,1)).valid,false);
 assert.equal(validateStoryboardScene(1,scene().replace('| 固定 |','| 静止，末尾硬切黑屏 |'),extractSourceScene(source,1)).valid,true);
 assert.equal(validateStoryboardScene(1,scene().replace('| 固定 |','| 固定，不切入其他视点，仅界面切换 |'),extractSourceScene(source,1)).valid,true);
 assert.equal(validateStoryboardScene(1,scene().replace('| 固定 |','| 固定长镜头，不再切镜，无插切 |'),extractSourceScene(source,1)).valid,true);
});

test('旁物待补备注不抹除已呈现文字，否定显示和遗漏重复事件不能认证',()=>{
 const original='场景一 室内（0–5秒）\n艾娃\n回去。\n【71:58:41】';
 const board=(visual:string)=>scene('艾娃：『回去。』').replace('艾娃挂在船外',visual);
 assert.equal(validateStoryboardScene(1,board('手机清楚显示【71:58:41】；制作备注：墙上非剧情海报字样后期另补'),original).valid,true);
 assert.equal(validateStoryboardScene(1,board('手机不会显示【71:58:41】，显示空白页'),original).valid,false);
 const repeat='场景一 室内（0–5秒）\n艾娃\n回去。\n【A】\n【B】\n【A】';
 assert.equal(validateStoryboardScene(1,board('依次显示【A】、【B】'),repeat).valid,false);
 assert.equal(validateStoryboardScene(1,board('依次显示【A】、【B】、【A】'),repeat).valid,true);
});
