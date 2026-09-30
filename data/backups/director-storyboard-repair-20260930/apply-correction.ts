import fs from "node:fs";
import assert from "node:assert/strict";
import knex from "knex";
import { reviseStoryboardScene, storyboardSceneHash } from "../../../src/agents/productionAgent/storyboardRevision";
import { hashStoryboardSource, readStoryboardProgress } from "../../../src/agents/productionAgent/storyboardProgress";
import { validateDirectorFacts } from "../../../src/agents/productionAgent/screenplay";
import { storyboardSegments } from "../../../src/agents/productionAgent/storyboardPanelSync";

async function main() {
  const dir = "data/backups/director-storyboard-repair-20260930";
  const live = process.argv.includes("--live");
  const file = live ? "data/db2.sqlite" : `${dir}/repair-test.sqlite`;
  if (!live) fs.copyFileSync(`${dir}/before.sqlite`, file);
  const db = knex({ client: "better-sqlite3", connection: { filename: file }, useNullAsDefault: true });
  const projectId = 1790665121730, episodesId = 1;
  const scope = { projectId, episodesId, key: "productionAgent" };
  const original = JSON.parse(fs.readFileSync("data/backups/director-storyboard-audit-20260930/workspace-1.json", "utf8"));
  const corrected = JSON.parse(fs.readFileSync(`${dir}/corrected-scenes.json`, "utf8"));
  const plan = fs.readFileSync(`${dir}/corrected-plan.md`, "utf8").trim();
  try {
    const beforeVideos = await db("o_video").select("id", "filePath");
    const selections = await db("o_videoTrack").select("id", "selectVideoId");
    await db.transaction(async trx => {
      const row = await trx("o_agentWorkData").where(scope).first();
      const data = JSON.parse(row.data);
      assert.equal(data.scriptPlan, original.scriptPlan, "导演计划已被其他操作修改，停止");
      assert.deepEqual(data.storyboardTableProgress.scenes, original.storyboardTableProgress.scenes, "分镜已被其他操作修改，停止");
      assert.equal(data.storyboardTableProgress.revision, original.storyboardTableProgress.revision);
      const script = await trx("o_script").where({ id: episodesId, projectId }).first();
      assert.deepEqual(validateDirectorFacts(script.content, plan), []);
      if (live) fs.writeFileSync(`${dir}/live-workspace-before.json`, JSON.stringify(data, null, 2));
      data.directorPlanRevisionHistory = [...(data.directorPlanRevisionHistory ?? []), { original: data.scriptPlan, revised: plan, reason: "修复剧本统计、悬挂动作与制作预算，保留现有109.5秒制作长度", createTime: Date.now() }];
      data.scriptPlan = plan;
      data.storyboardTableProgress.planHash = hashStoryboardSource(plan);
      await trx("o_agentWorkData").where({ id: row.id, data: row.data }).update({ data: JSON.stringify(data) });
      for (const scene of [1, 2, 3]) {
        const current = JSON.parse((await trx("o_agentWorkData").where(scope).first()).data);
        await reviseStoryboardScene(trx as any, {
          projectId, episodesId, scene, taskId: current.storyboardTableProgress.taskId,
          expectedRevision: current.storyboardTableProgress.revision,
          expectedSceneHash: storyboardSceneHash(current.storyboardTableProgress.scenes[scene]),
          revisedScene: corrected[scene], reason: "根据剧本审计修复动作因果、资产引用、界面时间和版本同步；保留视频历史",
        });
      }
      const stored = JSON.parse((await trx("o_agentWorkData").where(scope).first()).data);
      const panels = await trx("o_storyboard").where({ projectId, scriptId: episodesId }).orderBy("id");
      const expected = [1, 2, 3].flatMap(scene => storyboardSegments(corrected[scene]));
      assert.equal(panels.length, expected.length);
      for (let i = 0; i < panels.length; i++) {
        assert.equal(panels[i].videoDesc.trim(), expected[i].trim());
        assert.equal(stored.storyboard.find((panel: any) => panel.id === panels[i].id).videoDesc.trim(), expected[i].trim());
      }
      assert.equal(panels.reduce((sum, panel) => sum + Number(panel.duration), 0), 109.5);
      assert.deepEqual(await trx("o_video").select("id", "filePath"), beforeVideos);
      assert.deepEqual(await trx("o_videoTrack").select("id", "selectVideoId"), selections);
    });
    const progress = await readStoryboardProgress(db, projectId, episodesId);
    assert.equal(progress.valid, true); assert.equal(progress.complete, true);
    const saved = JSON.parse((await db("o_agentWorkData").where(scope).first()).data);
    const report = { live, revision: progress.revision, complete: progress.complete, valid: progress.valid, totalDuration: 109.5,
      videosPreserved: beforeVideos.map(row => row.id), selectionsPreserved: true,
      staleTracks: (await db("o_agentWorkData").where({ projectId, episodesId }).where("key", "like", "storyboardPromptStale:%").select("key")).map(row => row.key),
    };
    fs.writeFileSync(`${dir}/${live ? "live" : "test"}-verification.json`, JSON.stringify(report, null, 2));
    if (live) fs.writeFileSync(`${dir}/live-workspace-after.json`, JSON.stringify(saved, null, 2));
    console.log(JSON.stringify(report));
  } finally { await db.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
