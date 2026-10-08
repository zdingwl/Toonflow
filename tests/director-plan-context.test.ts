import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildDirectorPlanContext, readDirectorNarrative, directorPlanTemperature } from "../src/agents/productionAgent/directorPlanContext";
import { validateDirectorFacts, productionSceneBudget } from "../src/agents/productionAgent/screenplay";
import { storyboardPlanSceneCount } from "../src/agents/productionAgent/storyboardRebuildDispatch";

test("导演输入携带完整动作、项目画幅和已确认预算，不让统计替代正文", () => {
  const script = "场景一 外·船（0–25秒）\n她逐根掰开手指。\n艾娃\n拉我上去！\n场景二 水下（25–45秒）\n白光爆开。";
  const plan = "| 场次 | 制作预算（秒） |\n|---|---|\n| Sc1 | 25 |\n| Sc2 | 22 |";
  const context = buildDirectorPlanContext({ name: "海洋", directorManual: "Scifi_post_apocalypse", videoRatio: "16:9" }, script, plan, "题材参考");
  const lines = context.split("\n");
  assert.equal(JSON.parse(lines[1]).aspectRatio, "16:9");
  assert.equal(JSON.parse(lines[3]), script);
  const facts = JSON.parse(context.split("target_duration 为当前制作预算】\n")[1].split("\n【已有计划")[0]);
  assert.equal(facts[1].source_duration, 20);
  assert.equal(facts[1].target_duration, 22);
  assert.deepEqual(facts[1].target_timeline, { start: 0, end: 22 });
  assert.equal(facts[0].dialogue_characters, 4);
  assert.deepEqual(facts[0].speaker_names, ["艾娃"]);
  assert.ok(context.includes(JSON.stringify(plan)));
});

test("导演采样限制保留较低的用户配置，减少事实规划时的随机漂移", () => {
  assert.equal(directorPlanTemperature(1), 0.6);
  assert.equal(directorPlanTemperature(0), 0);
  assert.equal(directorPlanTemperature(0.3), 0.3);
  assert.equal(directorPlanTemperature(null), 0.6);
});

test("只读取所选题材规划文件且使用快照回调，未选择/不存在时无额外读取", async () => {
  const root = path.resolve("data/skills");
  const reads: string[] = [];
  const read = async (file: string) => { reads.push(file); return "run-snapshot"; };
  assert.equal(await readDirectorNarrative(root, "Scifi_post_apocalypse", read), "run-snapshot");
  assert.deepEqual(reads, [path.join(root, "story_skills/Scifi_post_apocalypse/driector_skills/director_planning_narrative.md")]);
  assert.equal(await readDirectorNarrative(root, "", read), "");
  assert.equal(await readDirectorNarrative(root, "not_installed", read), "");
  assert.equal(reads.length, 1);
  await assert.rejects(readDirectorNarrative(root, "../../outside", read), /名称无效/);
  const focused = await readDirectorNarrative(root, "Scifi_post_apocalypse", file => fs.readFile(file, "utf8"));
  assert.ok(focused.includes("资源即冲突"));
  assert.ok(!focused.includes("50%"));
  assert.ok(!focused.includes("配乐覆盖率"));
});

test("题材目录链接不能读取技能根目录外的文件", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "director-narrative-"));
  try {
    const root = path.join(temp, "skills"), outside = path.join(temp, "outside");
    await fs.mkdir(path.join(root, "story_skills"), { recursive: true });
    await fs.mkdir(path.join(outside, "driector_skills"), { recursive: true });
    await fs.writeFile(path.join(outside, "driector_skills/director_planning_narrative.md"), "outside");
    await fs.symlink(outside, path.join(root, "story_skills/escape"), "junction");
    await assert.rejects(readDirectorNarrative(root, "escape", async () => "must not read"), /超出/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("新增节拍表与场标题仍兼容预算、事实验证和下游场数解析", () => {
  const script = "场景一 内·屋（0–10秒）\n小林\n我回来了。";
  const plan = `### 整集导演意图\n主角回家。\n### 分场汇总表
| 场次 | 场景名 | 台词条数 | 台词字数 | 情绪浓度 | 情绪基调（含 X→Y） | 原剧本时段 | 制作预算（秒） |
|---|---|---|---|---|---|---|---|
| Sc1 | 内·屋 | 1 | 4 | 2 | 不安→放松 | 0–10秒 | 10 |
### 逐场导演设计\n#### Sc1：内·屋
| 节拍 | 场内区间（秒）/顺序 | 来源锚点 | 局势/信息变化 | 可见表演与调度 | 注意力与节奏理由 |
|---|---|---|---|---|---|
| B1 | 0–10 | 我回来了。 | 未归→归来 | 小林进屋 | 看回家的结果 |`;
  assert.deepEqual(validateDirectorFacts(script, plan), []);
  assert.equal(productionSceneBudget(plan, 1), 10);
  assert.equal(storyboardPlanSceneCount(plan), 1);
  assert.match(validateDirectorFacts(script, plan.replace("| B1 | 0–10", "| B1 | 50–60"))[0], /从0连续/);
  assert.match(validateDirectorFacts(script, plan.replace("| B1 | 0–10", "| B1 | 0–9"))[0], /制作预算10/);
  const split = plan.replace("| B1 | 0–10", "| B1 | 0–5") + "\n| B2 | 5–10 | 我回来了。 | 结果 | 停顿 | 回报 |";
  assert.deepEqual(validateDirectorFacts(script, split), []);
  assert.match(validateDirectorFacts(script, split.replace("5–10", "4–10"))[0], /重叠/);
  assert.match(validateDirectorFacts(script, split.replace("5–10", "6–10"))[0], /留空/);
  assert.deepEqual(validateDirectorFacts(script, plan.split("### 逐场导演设计")[0]), []);
});
