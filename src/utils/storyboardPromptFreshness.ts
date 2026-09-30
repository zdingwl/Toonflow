import { createHash } from "node:crypto";
import type { Knex } from "knex";

const hash = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
const keyFor = (trackId: number) => `storyboardPromptStale:${trackId}`;

/** Keep old prompts/videos for history, but don't submit a known superseded prompt again. */
export async function markStoryboardPromptsStale(db: Knex, projectId: number, episodesId: number, trackId: number) {
  const scope = { projectId, episodesId, key: keyFor(trackId) };
  const old = await db("o_agentWorkData").where(scope).first();
  const hashes: string[] = old?.data ? JSON.parse(old.data).hashes ?? [] : [];
  const track = await db("o_videoTrack").where({ id: trackId, projectId, scriptId: episodesId }).first();
  const variants = await db.schema.hasTable("o_videoPromptVariant") ? await db("o_videoPromptVariant").where({ trackId }) : [];
  if (track?.state === "生成中" || variants.some(row => row.state === "生成中")) throw new Error("该分镜的视频提示词正在生成，请完成后再修订，避免覆盖正在写入的新提示词");
  const prompts = [track?.prompt, ...variants.map(row => row.prompt)].filter((value): value is string => typeof value === "string" && !!value.trim());
  const history = old?.data ? JSON.parse(old.data).history ?? [] : [];
  const data = JSON.stringify({ hashes: [...new Set([...hashes, ...prompts.map(hash)])],
    history: [...history, { basePrompt: track?.prompt, variants, createTime: Date.now() }], updatedAt: Date.now() });
  if (old) await db("o_agentWorkData").where({ id: old.id }).update({ data });
  else await db("o_agentWorkData").insert({ ...scope, data });
  const reason = "分镜已修订，请更新视频提示词；旧提示词和已有视频已保留";
  if (track) await db("o_videoTrack").where({ id: trackId, projectId, scriptId: episodesId }).update({ prompt: null, state: "未生成", reason });
  if (variants.length) await db("o_videoPromptVariant").where({ trackId }).update({ state: "未生成", reason });
}

export async function assertStoryboardPromptFresh(db: Knex, projectId: number, trackId: number, prompt: string) {
  if (!(await db.schema.hasTable("o_agentWorkData"))) return;
  const row = await db("o_agentWorkData").where({ projectId, key: keyFor(trackId) }).select("data").first();
  if (row?.data && JSON.parse(row.data).hashes?.includes(hash(prompt))) {
    throw new Error("分镜内容已修订，此提示词属于旧分镜，请重新生成视频提示词；已有视频保留");
  }
}
