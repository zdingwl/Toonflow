import type { Knex } from "knex";
import { parseScriptScenes, productionSceneBudget } from "./screenplay";
import { extractSourceScene, validateStoryboardScene } from "./storyboardValidator";

/** Validate inside the write transaction, so revisions and full-table saves cannot bypass it. */
export async function guardStoryboardContent(
  trx: Knex.Transaction, projectId: number, script: string, plan: string, scene: number, markdown: string,
  options: { previousScene?: string; requireContinuityContract?: boolean } = {},
) {
  const source = extractSourceScene(script, scene);
  const facts = source ? parseScriptScenes(source)[0] : undefined;
  // Old workspaces can contain non-tabular notes. Keep those readable, without certifying coverage.
  if (!/^###\s*片段/m.test(markdown) && !facts?.dialogue.length && !facts?.sourceDuration && !facts?.screenText.length) return;
  const assets = await trx.schema.hasTable("o_assets") ? await trx("o_assets").where({ projectId }).select("id") : undefined;
  const validation = validateStoryboardScene(scene, markdown, source, {
    targetDuration: productionSceneBudget(plan, scene, source),
    assetIds: assets?.map(asset => Number(asset.id)),
    previousScene: options.previousScene,
    requireContinuityContract: options.requireContinuityContract,
  });
  if (!validation.valid) throw new Error(`第${scene}场未通过内容校验：${validation.errors.join("；")}`);
}
