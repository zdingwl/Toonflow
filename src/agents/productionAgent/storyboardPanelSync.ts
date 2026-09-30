import type { Knex } from "knex";
import { markStoryboardPromptsStale } from "@/utils/storyboardPromptFreshness";

export const storyboardSegments = (text: string) => text.split(/(?=^###\s*片段)/m).filter(part => /^###\s*片段/.test(part.trim())).map(part => part.trim());
const canonical = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** Reconcile only exact old/new segment matches. Independently edited panels are conflicts. */
export async function syncRevisedStoryboardPanels(trx: Knex.Transaction, projectId: number, episodesId: number, data: any, original: string, revised: string) {
  if (!(await trx.schema.hasTable("o_storyboard"))) return data.storyboard;
  const panels = await trx("o_storyboard").where({ projectId, scriptId: episodesId });
  if (!panels.length) return data.storyboard;
  const before = storyboardSegments(original), after = storyboardSegments(revised);
  if (before.length !== after.length) throw new Error("修订改变了片段数量；已有分镜和视频需要明确重新编排，未覆盖原面板");
  const workspace = Array.isArray(data.storyboard) ? data.storyboard.map((item: any) => ({ ...item })) : [];
  const used = new Set<number>();
  for (let i = 0; i < before.length; i++) {
    if (canonical(before[i]) === canonical(after[i])) continue;
    const candidates = panels.filter(panel => canonical(panel.videoDesc ?? "") === canonical(before[i]) || canonical(panel.videoDesc ?? "") === canonical(after[i]));
    if (candidates.length !== 1 || used.has(candidates[0].id)) throw new Error(`片段${i + 1}的执行面板有独立修改或映射不唯一，请核对后修订，未覆盖新版本`);
    const panel = candidates[0]; used.add(panel.id);
    const cells = after[i].split("\n").filter(line => /^\|\s*\d+\s*\|/.test(line)).map(line => line.split("|").slice(1, -1));
    const duration = cells.reduce((sum, row) => sum + Number(row[2]), 0);
    const refs = after[i].match(/引用资产ID(?:（[^）]*）)?\*\*\s*[：:]\s*\[([^\]]*)\]/i);
    if (!refs || !duration) throw new Error("修订片段缺少有效时长或资产引用");
    const ids = [...new Set(refs[1].split(/[,，]/).map(id => Number(id.trim())))];
    const changed = canonical(panel.videoDesc ?? "") !== canonical(after[i]);
    if (changed) {
      if (panel.trackId) await markStoryboardPromptsStale(trx, projectId, episodesId, panel.trackId);
      await trx("o_storyboard").where({ id: panel.id, projectId, scriptId: episodesId }).update({ videoDesc: after[i], duration: String(duration) });
      await trx("o_assets2Storyboard").where({ storyboardId: panel.id }).del();
      if (ids.length) await trx("o_assets2Storyboard").insert(ids.map(assetId => ({ storyboardId: panel.id, assetId })));
      if (panel.trackId) {
        const group = await trx("o_storyboard").where({ trackId: panel.trackId, projectId, scriptId: episodesId });
        await trx("o_videoTrack").where({ id: panel.trackId, projectId, scriptId: episodesId }).update({ duration: group.reduce((sum, row) => sum + Number(row.duration), 0) });
      }
    }
    const copy = workspace.find((item: any) => item.id === panel.id);
    if (copy) Object.assign(copy, { videoDesc: after[i], duration, associateAssetsIds: ids });
  }
  return workspace;
}
