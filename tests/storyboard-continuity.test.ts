import test from "node:test";
import assert from "node:assert/strict";
import {
  continuityHandoff,
  extractSceneExitContinuity,
  validateStoryboardContinuity,
} from "../src/agents/productionAgent/storyboardContinuity";
import { validateStoryboardScene } from "../src/agents/productionAgent/storyboardValidator";

const contract = (value: Record<string, unknown>) =>
  `**连续性契约**：${JSON.stringify(value)}`;

const segment = (name: string, value: Record<string, unknown>, description = "角色继续动作") => `### ${name}（约5s）
${contract(value)}
**引用资产ID**：[1]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | ${description} | 5 | 中景 | 固定 | 无台词 | 风声 |`;

const base = {
  version: 1,
  continuityMode: "RESET",
  cutType: "SCENE_START",
  continuityGroup: "sc1-action-a",
  entryStateId: "sc1-p1-start",
  exitStateId: "sc1-p1-end",
  entrySummary: "角色A站在栏杆内侧，右手抬起",
  exitSummary: "角色A右手搭上栏杆",
  axisLock: "rail-axis-01",
  screenDirection: "角色A左→右",
};

test("片段内 PRESERVE 必须继承上一片段 exitStateId 与 continuityGroup", () => {
  const first = segment("片段一", base);
  const second = segment("片段二", {
    ...base,
    continuityMode: "PRESERVE",
    cutType: "CONTINUOUS_ACTION",
    entryStateId: "sc1-p1-end",
    exitStateId: "sc1-p2-end",
    entrySummary: "角色A右手仍搭在栏杆上",
    exitSummary: "角色A翻过栏杆开始下坠",
  });
  const ok = validateStoryboardContinuity(first + "\n" + second, undefined, { requireContracts: true });
  assert.deepEqual(ok.errors, []);

  const broken = validateStoryboardContinuity(
    first + "\n" + second.replace('"entryStateId":"sc1-p1-end"', '"entryStateId":"sc1-wrong"'),
    undefined,
    { requireContracts: true },
  );
  assert.match(broken.errors.join("；"), /entryStateId/);
});

test("跨场连续动作使用机器出口作为下一场入口，RESET 才允许状态重建", () => {
  const previous = `## 场1：甲板
${segment("片段一", {
    ...base,
    exitStateId: "fall-enter-water",
    exitSummary: "艾娃从船舷向下坠入浪面，运动方向保持向下",
    screenDirection: "艾娃=画面下方",
  })}`;
  const next = `## 场2：水下
${segment("片段一", {
    ...base,
    continuityMode: "PRESERVE",
    cutType: "CONTINUOUS_ACTION",
    continuityGroup: "sc1-action-a",
    entryStateId: "fall-enter-water",
    exitStateId: "underwater-sink-01",
    entrySummary: "艾娃刚穿过浪面进入水下，身体继续向下运动，水面在上方",
    exitSummary: "艾娃继续下沉，气泡上浮",
    screenDirection: "艾娃=画面下方",
  })}`;
  assert.deepEqual(validateStoryboardContinuity(next, previous, { requireContracts: true }).errors, []);
  assert.equal(extractSceneExitContinuity(previous)?.exitStateId, "fall-enter-water");
  assert.match(continuityHandoff(previous), /fall-enter-water/);

  const wrong = next.replace('"entryStateId":"fall-enter-water"', '"entryStateId":"fresh-start"');
  assert.match(validateStoryboardContinuity(wrong, previous, { requireContracts: true }).errors.join("；"), /跨场 PRESERVE/);
});

test("旧版分镜兼容读取但新生成可强制要求连续性契约", () => {
  const legacy = `### 片段一（约5s）
**引用资产ID**：[1]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 人物站在门口 | 5 | 中景 | 固定 | 无台词 | 风声 |`;
  const compatible = validateStoryboardContinuity(legacy);
  assert.deepEqual(compatible.errors, []);
  assert.match(compatible.warnings.join("；"), /旧版分镜兼容/);
  assert.match(validateStoryboardContinuity(legacy, undefined, { requireContracts: true }).errors.join("；"), /缺少/);

  const scene = `## 场1：门口
${legacy}`;
  assert.equal(validateStoryboardScene(1, scene, undefined).valid, true);
  assert.equal(validateStoryboardScene(1, scene, undefined, { requireContinuityContract: true }).valid, false);
});
