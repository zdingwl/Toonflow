import u from "@/utils";
import sharp from "sharp";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { generateAssetPrompt, reviewAssetImage } from "./assetPromptGeneration";
import type { CharacterCard, CharacterCardImageAttempt } from "./characterCards";
import { buildCharacterCardImagePromptContext } from "./characterCardImagePromptContext";

/** Use the same visual manual and full-sheet provider as project characters. */
export async function renderCharacterCardImage(card: CharacterCard, attempt: CharacterCardImageAttempt) {
  const resolution = z.enum(["1K", "2K", "4K"]).parse(attempt.resolution);
  const context = buildCharacterCardImagePromptContext(card);
  const vision = { loadImage: (path: string) => u.oss.getImageBase64(path),
    invoke: (input: any) => u.Ai.Text("universalAi").invoke(input) };
  const prompt = await generateAssetPrompt(vision, context,
    u.getArtPrompt(card.artStyle, "art_skills", "art_character"));
  await u.db("o_characterCardImage").where({ id: attempt.id, state: "running" }).update({ prompt, updatedAt: Date.now() });
  const runtimePrompt = `The visible rendering medium and art direction stated in CURRENT ASSET FACTS are authoritative.\nInternal project preset id "${card.artStyle}" is metadata only and must not change that medium.\nCurrent character and state: ${card.name}.\nAuthoritative visible identity, wardrobe and state facts: ${prompt}`;
  const image = await u.Ai.Image(attempt.model as `${string}:${string}`).run({ prompt: runtimePrompt,
    // This provider treats its first reference as the finished front panel. A previous
    // full sheet is vision evidence above, not a front anchor: regenerate all four views.
    referenceList: [],
    size: resolution, aspectRatio: "2:3" }, { taskClass: "角色卡图片生成", describe: `生成角色卡完整四视图：${card.name}`,
    projectId: card.sourceProjectId || 0, relatedObjects: JSON.stringify({ cardId: card.id, cardVersion: card.version, imageAttemptId: attempt.id }) });
  const filePath = `/characterCards/${card.id}/${randomUUID()}.jpg`;
  await image.save(filePath);
  // Preserve any provider output in history even when layout validation rejects it.
  await u.db("o_characterCardImage").where({ id: attempt.id }).update({ filePath, updatedAt: Date.now() });
  const metadata = await sharp(await u.oss.getFile(filePath)).metadata();
  if (!metadata.width || !metadata.height || metadata.width / metadata.height < 1.7) throw new Error("角色卡未返回完整四视图，请重试；已保留原图与本次结果");
  await reviewAssetImage(vision, context, prompt, filePath, { fourViewEvidence: true });
  return { filePath, prompt };
}
