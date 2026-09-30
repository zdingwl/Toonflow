import fs from "node:fs";
import { createRequire } from "node:module";
import knex from "knex";
import { tool, jsonSchema } from "ai";
import { screenplayFacts, validateDirectorFacts } from "../../../src/agents/productionAgent/screenplay";
import { extractDirectorPlan } from "../../../src/agents/productionAgent/directorPlan";
import { extractStoryboardTable } from "../../../src/agents/productionAgent/storyboardTable";
import { extractSourceScene, validateStoryboardScene } from "../../../src/agents/productionAgent/storyboardValidator";

async function main() {
  const dir = "data/backups/director-storyboard-repair-20260930";
  const db = knex({ client: "better-sqlite3", connection: { filename: `${dir}/before.sqlite` }, useNullAsDefault: true });
  const localRequire = createRequire(`${process.cwd()}/package.json`);
  const module = localRequire.resolve("./src/utils/db.ts");
  localRequire.cache[module] = { id: module, filename: module, loaded: true, exports: { __esModule: true, default: db, db } } as any;
  const u = localRequire("./src/utils").default;
  try {
    const script = (await db("o_script").where({ id: 1, projectId: 1790665121730 }).first()).content;
    const assets = await db("o_assets").where({ projectId: 1790665121730 }).select("id", "name", "type", "assetsId");
    const budget = "| 场次 | 制作预算（秒） |\n|---|---|\n| Sc1 | 25 |\n| Sc2 | 22 |\n| Sc3 | 62.5 |";
    const facts = screenplayFacts(script, budget);
    const directorSystem = fs.readFileSync("data/skills/production_execution_director_plan.md", "utf8");
    const planResult = await u.Ai.Text("productionAgent:directorPlanAgent").invoke({
      system: directorSystem,
      messages: [{ role: "user", content: `生成本集导演规划。当前制作预算保留109.5秒（25/22/62.5），原剧本95秒单独作来源。艾娃开场身体悬在船舷外、双脚无支撑，不是站在栏杆旁。\n程序事实：${facts}` }],
      tools: { get_flowData: tool({ description: "读取完整剧本", inputSchema: jsonSchema({ type: "object", properties: { type: { type: "string" } } }), execute: async () => ({ script }) }) },
    });
    fs.writeFileSync(`${dir}/model-director-response.txt`, planResult.text);
    const plan = extractDirectorPlan(planResult.text);
    const planErrors = validateDirectorFacts(script, plan);
    if (planErrors.length) throw new Error(planErrors.join("；"));
    fs.writeFileSync(`${dir}/model-director-plan.md`, plan);
    console.log("Director model output passed scene/dialogue fact checks.");
    const sourceScene = extractSourceScene(script, 1)!;
    const sceneRequest = `仅生成第1场，共3场，task=storyboard_probe_20260930。输出一份 <storyboardTable scene="1" total="3" task="storyboard_probe_20260930">Markdown</storyboardTable>。\n` +
      `原剧本：${sourceScene}\n导演规划：${plan}\n程序事实：${screenplayFacts(sourceScene, budget)}\n当前资产：${JSON.stringify(assets)}\n` +
      "原剧本要求艾娃在船舷外悬空抓住固定栏杆，双手在头上承重，身体和脚在船外无支撑，麦迪逊站在甲板内侧上方。保持因果：麦迪逊逐根掰开手指，另一只手也被掰离，最后一指被掰开后才坠海。资产202是艾娃雨夜状态、205是麦迪逊雨夜状态，215的攻击图时段不符，使用15仅参考鲨鱼外观。不得把当前设定图的站姿当剧情姿势。";
    fs.writeFileSync(`${dir}/model-storyboard-request.txt`, sceneRequest);
    const sceneResult = await u.Ai.Text("productionAgent:storyboardTableAgent").invoke({
      system: fs.readFileSync("data/skills/production_execution_storyboard_table.md", "utf8") + "\n所需完整数据已在本轮用户上下文提供，直接核对并输出。",
      messages: [{ role: "user", content: sceneRequest }],
    });
    fs.writeFileSync(`${dir}/model-storyboard-response.txt`, sceneResult.text);
    const parsed = extractStoryboardTable(sceneResult.text);
    const checked = validateStoryboardScene(1, parsed.content, sourceScene, { targetDuration: 25, assetIds: assets.map((asset: any) => asset.id) });
    fs.writeFileSync(`${dir}/model-probe-validation.json`, JSON.stringify({ planErrors, storyboard: checked }, null, 2));
    console.log(JSON.stringify(checked));
    if (!checked.valid) throw new Error(checked.errors.join("；"));
  } finally { await db.destroy(); }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
