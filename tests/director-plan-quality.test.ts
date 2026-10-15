import assert from "node:assert/strict";
import { test } from "node:test";
import knex from "knex";
import { validateDirectorExecution } from "../src/agents/productionAgent/directorPlanQuality";
import { saveDirectorPlan } from "../src/agents/productionAgent/directorPlan";

const script = "场景一 内·屋（0–50秒）\n艾娃\n卖车。今天成交。\n下一通。\n艾娃\n仓库短租，越偏越好。\n再下一通。\n艾娃\n工业滤芯、移动储水罐、救生设备，有现货的全部给我报价。";
const header = "| 节拍 | 场内区间（秒） | 来源锚点 | 局势变化 | 可见表演 | 注意力与节奏理由 |\n|---|---|---|---|---|---|";
const scene = (table: string) => `### 逐场导演设计\n#### Sc1：内·屋\n${table}`;
const row = (end: number, reason = "完整原句清晰说完") => `| B1 | 0–${end} | 卖车。今天成交。 | 询价 | 第一通说“卖车。今天成交。”；下一通说“仓库短租，越偏越好。”；再下一通说“工业滤芯、移动储水罐、救生设备，有现货的全部给我报价。” | ${reason} |`;

test("合拍按三句完整口播求和并计换通，不只核算最长一句", () => {
  const errors = validateDirectorExecution(script, scene(`${header}\n${row(8)}`));
  assert.ok(errors.some(error => error.includes("37字") && error.includes("10.3秒") && error.includes("仅8秒")));
  assert.deepEqual(validateDirectorExecution(script, scene(`${header}\n${row(14)}`)), []);
});

test("不覆盖来源明确要求快语速的表演，不把外语按汉字估算", () => {
  const fast = "场景一 内·屋（0–5秒）\n她飞快地说。\n艾娃\n三天后，这座城会先停下来。";
  assert.deepEqual(validateDirectorExecution(fast, scene(`${header}\n| B1 | 0–1 | 三天后，这座城会先停下来。 | 决定 | 原句快速说完 | 快语速沿用原文 |`)), []);
  const english = "场景一 内·屋（0–5秒）\nEva\nGo now!";
  assert.deepEqual(validateDirectorExecution(english, scene(`${header}\n| B1 | 0–1 | Go now! | 决定 | Eva: Go now! | 急促 |`)), []);
});

test("重复台词按真实轮次计时，来源锚点与执行引用不重复计费", () => {
  const repeated = "场景一 内·屋（0–5秒）\n艾娃\n快走。\n艾娃\n快走。";
  assert.ok(validateDirectorExecution(repeated, scene(`${header}\n| B1 | 0–0.5 | 快走。 | 催促 | 连续说“快走。快走。” | 原文两轮 |`)).some(error => error.includes("4字") && error.includes("至少1秒")));
  assert.deepEqual(validateDirectorExecution(repeated, scene(`${header}\n| B1 | 0–0.5 | 快走。 | 催促 | 说“快走。” | 第一轮 |\n| B2 | 0.5–1 | 快走。 | 再催促 | 说“快走。” | 第二轮 |`)), []);
});

test("一个角色的快语速不能豁免同场其他角色的普通台词", () => {
  const mixed = "场景一 内·屋（0–5秒）\n贝拉语速飞快。\n贝拉\n快走。\n艾娃慢慢地说。\n艾娃\n三天后，这座城会先停下来。";
  assert.ok(validateDirectorExecution(mixed, scene(`${header}\n| B1 | 0–1 | 三天后，这座城会先停下来。 | 决定 | 艾娃说原句 | 平静 |`)).some(error => error.includes("11字") && error.includes("仅1秒")));
});

test("拒绝缺列、缺分隔行及同场保留草稿和第二张表", () => {
  const missingColumn = header.replace(" | 注意力与节奏理由", "");
  assert.ok(validateDirectorExecution(script, scene(`${missingColumn}\n${row(14)}`)).some(error => error.includes("表头必须六列")));
  assert.ok(validateDirectorExecution(script, scene(`${header.split("\n")[0]}\n${row(14)}`)).some(error => error.includes("分隔行")));
  assert.ok(validateDirectorExecution(script, scene(`${header}\n${row(14)}\n${header}\n${row(14)}`)).some(error => error.includes("一张最终")));
});

test("执行说明声称的分配不能大于实际区间，遗留摘要仍兼容", () => {
  const simple = "场景一 内·屋（0–5秒）\n小林\n回来。";
  const plan = scene(`${header}\n| B1 | 0–5 | 回来。 | 归来 | 回来。 | 6秒承载原句及动作 |`);
  assert.ok(validateDirectorExecution(simple, plan).some(error => error.includes("说明称6秒") && error.includes("仅5秒")));
  assert.deepEqual(validateDirectorExecution(script, "已有分场摘要"), []);
});

test("台词耗时与另留末尾动作不能在说明中超过该拍预算", () => {
  const simple = "场景一 外·边缘（0–5秒）\n艾娃\n你干什么？！\n麦迪逊\n我只是想活。";
  const body = "| B1 | 0–4 | 你干什么？！ | 质问后坠落 | 艾娃质问，麦迪逊说我只是想活。之后脱离 | 台词合计约2.3–3秒，最后2秒留给脱离与坠落终态 |";
  assert.ok(validateDirectorExecution(simple, scene(`${header}\n${body}`)).some(error => error.includes("至少4.3秒") && error.includes("分配4秒")));
  assert.deepEqual(validateDirectorExecution(simple, scene(`${header}\n${body.replace("0–4", "0–5")}`)), []);
});

test("双手抓握必须交代第二只手到最后一指，不能只描述第一只手", () => {
  const hanging = "场景一 外·栏（0–10秒）\n她双手抓住边缘。\n对方逐根掰开。\n最后一根手指被掰开。";
  const incomplete = scene(`${header}\n| B1 | 0–6 | 双手抓住 | 支撑减少 | 一只手被逐根掰开，另一只手继续抓着 | 动作可读 |\n| B2 | 6–10 | 最后一根手指 | 脱离 | 最后一根手指被主动掰开 | 坠落 |`);
  assert.ok(validateDirectorExecution(hanging, incomplete).some(error => error.includes("第二只手")));
  assert.deepEqual(validateDirectorExecution(hanging, incomplete.replace("另一只手继续抓着", "麦迪逊再掰开剩余手上的手指，直到只余最后一根")), []);
});

test("已采用的兼容方案不因假设改要求而变成审批缺口", () => {
  const body = scene(`${header}\n${row(14)}`);
  const hypothetical = body + "\n### 需确认问题\n采用主观声音；若主创要求被其他人听见，需要上游补充载体。";
  assert.ok(validateDirectorExecution(script, hypothetical).some(error => error.includes("假设替代要求")));
  assert.deepEqual(validateDirectorExecution(script, body + "\n### 需确认问题\n无。"), []);
});

test("逐行屏幕字数不能继承外部审稿或旧候选的计数错误", () => {
  const screen = "场景一 内·系统（0–6秒）\n【海洋基建核心·07】\n【宿主生命终止确认】\n【时序锚点仍可连接】\n【是否执行一次回溯？】\n【3】\n【2】\n【1】";
  const body = scene(`${header}\n| B1 | 0–6 | 海洋基建核心·07 | 宿主生命终止确认 | 时序锚点仍可连接；是否执行一次回溯？ | 四行有效字符为8、8、9、9，共34；六秒读取 |`);
  assert.ok(validateDirectorExecution(screen, body).some(error => error.includes("8、8、8、8，共32")));
  assert.deepEqual(validateDirectorExecution(screen, body.replace("8、8、9、9，共34", "8、8、8、8，共32")), []);
  assert.ok(validateDirectorExecution(screen, body.replace("有效字符为8、8、9、9，共34", "有效字符均为9，共36")).some(error => error.includes("共32")));
  assert.deepEqual(validateDirectorExecution(screen, body.replace("有效字符为8、8、9、9，共34", "有效字符均为8，共32")), []);
});

test("执行时间失败不能覆盖已确认规划、分镜与视频，修正后才保存", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_script", table => { table.integer("id").primary(); table.integer("projectId"); table.text("content"); });
    await db.schema.createTable("o_agentWorkData", table => {
      table.increments("id").primary(); table.integer("projectId"); table.integer("episodesId"); table.string("key"); table.text("data"); table.integer("updateTime");
    });
    await db("o_script").insert({ id: 1, projectId: 12, content: script });
    const before = { scriptPlan: "已确认规划", storyboardTable: "已确认分镜", workbench: { videoList: [{ id: 19, state: "成功" }] } };
    await db("o_agentWorkData").insert({ projectId: 12, episodesId: 1, key: "productionAgent", data: JSON.stringify(before) });
    const summary = "| 场次 | 场景名 | 台词条数 | 台词字数 | 情绪浓度 | 情绪基调 | 原剧本时段 | 制作预算（秒） |\n|---|---|---|---|---|---|---|---|\n| Sc1 | 内·屋 | 3 | 37 | 5 | 决断 | 0–50秒 | 50 |\n";
    const bad = summary + scene(`${header}\n${row(8)}\n| B2 | 8–50 | 下一通。 | 等待 | 等待回电 | 看反馈 |`);
    await assert.rejects(saveDirectorPlan(db, 12, 1, bad, "已确认规划"), /37字.*仅8秒/);
    assert.deepEqual(JSON.parse((await db("o_agentWorkData").first()).data), before);
    const good = bad.replace("0–8", "0–14").replace("8–50", "14–50");
    await saveDirectorPlan(db, 12, 1, good, "已确认规划");
    const after = JSON.parse((await db("o_agentWorkData").first()).data);
    assert.equal(after.scriptPlan, good);
    assert.equal(after.storyboardTable, before.storyboardTable);
    assert.deepEqual(after.workbench, before.workbench);
  } finally { await db.destroy(); }
});
