import assert from "node:assert/strict";
import test from "node:test";
import { parseStoryboardTimeline } from "../src/agents/productionAgent/storyboardTimeline";

const row = (shot: number, duration: string | number, visual = "角色观察门口") =>
  `| ${shot} | ${visual} | ${duration} | 近景 | 固定 | 无台词 | 脚步声 |`;

test("每场从0重置、镜号保留，片段边界延续真实镜头累计而不使用标题估计", () => {
  const ledger = parseStoryboardTimeline([
    "## 场1：甲", "### 片段一（约99s）", row(1, 2), row(2, 1.5),
    "### 片段二（约99s）", row(3, 0.5),
    "## 场2：乙", "### 片段一（约99s）", row(1, 3), row(2, 2),
  ].join("\n"));
  assert.deepEqual(ledger.errors, []);
  assert.deepEqual(ledger.shots.map(({ scene, segment, shot, from, to, duration }) => ({ scene, segment, shot, from, to, duration })), [
    { scene: 1, segment: 1, shot: 1, from: 0, to: 2, duration: 2 },
    { scene: 1, segment: 1, shot: 2, from: 2, to: 3.5, duration: 1.5 },
    { scene: 1, segment: 2, shot: 3, from: 3.5, to: 4, duration: 0.5 },
    { scene: 2, segment: 1, shot: 1, from: 0, to: 3, duration: 3 },
    { scene: 2, segment: 1, shot: 2, from: 3, to: 5, duration: 2 },
  ]);
  assert.deepEqual(ledger.segments.map(({ scene, segment, from, to, duration }) => ({ scene, segment, from, to, duration })), [
    { scene: 1, segment: 1, from: 0, to: 3.5, duration: 3.5 },
    { scene: 1, segment: 2, from: 3.5, to: 4, duration: 0.5 },
    { scene: 2, segment: 1, from: 0, to: 5, duration: 5 },
  ]);
  assert.deepEqual(ledger.scenes.map(({ scene, from, to, duration }) => ({ scene, from, to, duration })), [
    { scene: 1, from: 0, to: 4, duration: 4 }, { scene: 2, from: 0, to: 5, duration: 5 },
  ]);
});

test("十进制小数按原值累计，不向审核模型输出浮点尾差", () => {
  const ledger = parseStoryboardTimeline(["## 场1：甲", "### 片段一（约1s）", row(1, "0.1"), row(2, "0.2"), row(3, ".3")].join("\n"));
  assert.deepEqual(ledger.shots.map(shot => [shot.from, shot.to]), [[0, 0.1], [0.1, 0.3], [0.3, 0.6]]);
  assert.equal(ledger.segments[0].duration, 0.6); assert.equal(ledger.scenes[0].duration, 0.6);
});

test("无效时长后本场后续起止保持未知，换片段不补猜，下一场独立恢复", () => {
  for (const invalid of ["", "0", "-1", "NaN", "Infinity", "三", "4s"]) {
    const ledger = parseStoryboardTimeline([
      "## 场1：甲", "### 片段一（约8s）", row(1, 2), row(2, invalid), row(3, 1),
      "### 片段二（约2s）", row(4, 2),
      "## 场2：乙", "### 片段一（约3s）", row(1, 3),
    ].join("\n"));
    assert.equal(ledger.shots[1].durationRaw, invalid);
    assert.deepEqual(ledger.shots.map(shot => [shot.from, shot.to, shot.duration]), [
      [0, 2, 2], [2, null, null], [null, null, 1], [null, null, 2], [0, 3, 3],
    ], `invalid duration ${invalid}`);
    assert.deepEqual(ledger.segments.map(segment => [segment.from, segment.to, segment.duration]), [[0, null, null], [null, null, 2], [0, 3, 3]]);
    assert.equal(ledger.scenes[0].duration, null); assert.equal(ledger.scenes[1].duration, 3);
    assert.match(ledger.errors[0], /本场后续起止未知/);
  }
});

test("拆分片段只改变分组，账本总时间和镜头边界相同", () => {
  const shots = [row(1, 2.25), row(2, 1.75), row(3, 3)];
  const one = parseStoryboardTimeline(["## 场1：甲", "### 片段一（约7s）", ...shots].join("\n"));
  const split = parseStoryboardTimeline(["## 场1：甲", "### 片段一（约4s）", ...shots.slice(0, 2), "### 片段二（约3s）", shots[2]].join("\n"));
  assert.deepEqual(one.shots.map(shot => [shot.shot, shot.from, shot.to]), split.shots.map(shot => [shot.shot, shot.from, shot.to]));
  assert.equal(split.segments[1].from, 4); assert.equal(split.scenes[0].duration, 7);
});

test("结构损坏不取错列时长，转义竖线保留在画面单元格", () => {
  const valid = parseStoryboardTimeline(["## 场1：甲", "### 片段一（约2s）", row(1, 2, "角色看到A\\|B")].join("\n"));
  assert.deepEqual(valid.errors, []); assert.equal(valid.shots[0].to, 2);
  const broken = parseStoryboardTimeline(["## 场1：甲", "### 片段一（约5s）", "| 1 | 画面 | 2 | 近景 | 固定 | 无台词 |", row(2, 3)].join("\n"));
  assert.equal(broken.shots[0].duration, null); assert.equal(broken.shots[1].from, null); assert.equal(broken.shots[1].to, null);
});
