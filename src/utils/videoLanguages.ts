import type { Knex } from "knex";
import { z } from "zod";

export const dialogueLanguages = [
  { value: "zh-CN", label: "中文（普通话）" },
  { value: "en-US", label: "英语（美国）" },
  { value: "en-GB", label: "英语（英国）" },
  { value: "ja-JP", label: "日语" },
  { value: "ko-KR", label: "韩语" },
  { value: "fr-FR", label: "法语（法国）" },
  { value: "de-DE", label: "德语" },
  { value: "es-ES", label: "西班牙语（西班牙）" },
  { value: "es-MX", label: "西班牙语（墨西哥）" },
  { value: "pt-BR", label: "葡萄牙语（巴西）" },
  { value: "it-IT", label: "意大利语" },
  { value: "ru-RU", label: "俄语" },
  { value: "ar-SA", label: "阿拉伯语（沙特）" },
  { value: "hi-IN", label: "印地语" },
  { value: "th-TH", label: "泰语" },
  { value: "vi-VN", label: "越南语" },
  { value: "id-ID", label: "印度尼西亚语" },
];
export const dialogueLanguageSchema = z.string().refine((value) => dialogueLanguages.some((item) => item.value === value), "不支持的对白语言");
export const dialogueLanguagesSchema = z
  .array(dialogueLanguageSchema)
  .min(1)
  .max(17)
  .refine((values) => new Set(values).size === values.length, "对白语言不能重复");
export const languageLabel = (language: string) => dialogueLanguages.find((item) => item.value === language)?.label || "原版（未标注语言）";

export async function migrateVideoLanguages(db: Knex) {
  if (!(await db.schema.hasTable("o_videoLanguageSelection")))
    await db.schema.createTable("o_videoLanguageSelection", (table) => {
      table.integer("projectId").notNullable();
      table.integer("scriptId").notNullable();
      table.text("languages").notNullable();
      table.primary(["projectId", "scriptId"]);
    });
  if (!(await db.schema.hasTable("o_videoPromptVariant")))
    await db.schema.createTable("o_videoPromptVariant", (table) => {
      table.integer("trackId").notNullable();
      table.text("language").notNullable();
      table.text("prompt").notNullable().defaultTo("");
      table.text("state").notNullable().defaultTo("未生成");
      table.text("reason");
      table.integer("videoId");
      table.primary(["trackId", "language"]);
    });
  if (!(await db.schema.hasTable("o_videoLanguage")))
    await db.schema.createTable("o_videoLanguage", (table) => {
      table.integer("videoId").primary();
      table.text("language").notNullable();
      table.text("prompt").notNullable();
    });
}

export function translationInstruction(language: string) {
  return `制作同一视频的${languageLabel(language)}（${language}）对白版本。只返回完整视频提示词，不要解释。
将所有人物对白、独白和旁白翻译成该地区自然地道的目标语言，并明确标注 spoken language 为 ${language}；口型与目标语言同步。
保持原提示词的章节名称、结构和视觉指令语言（原来是英文就仍用英文）。如使用 <d>[Chinese] 台词</d>，仅把发声台词及其语言标记改为目标语言；不要翻译明确标注为可见场景文字的内容。
保持剧情、角色姓名与身份、场景、服装、镜头顺序、视觉描述、参考图编号和素材标记不变；不能将角色或场景搬到目标国家。
原文无对白的镜头保持无对白，不得添加台词。不要把原语言对白或中文译文混入发声内容。声音参考只用于音色，不得复制其原语言台词。
保留时长和时间轴，在给定时长内自然表达，不可加速塞入过长台词、删去剧情信息或截断对白；如果无法容纳，返回以 LANGUAGE_TIMING_REVIEW: 开头的简短原因，不要生成不完整提示词。`;
}

const pendingVariants = new WeakMap<Knex, Map<number, Promise<unknown>>>();
// Serialize overlapping requests for the same track and recheck saved versions after waiting.
export async function generateLanguageVariants(
  db: Knex,
  trackId: number,
  languages: string[],
  generateBase: () => Promise<string>,
  translate: (system: string, source: string) => Promise<string>,
) {
  let pending = pendingVariants.get(db);
  if (!pending) {
    pending = new Map();
    pendingVariants.set(db, pending);
  }
  const previous = pending.get(trackId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => generateMissingVariants(db, trackId, languages, generateBase, translate));
  pending.set(trackId, next);
  try {
    return await next;
  } finally {
    if (pending.get(trackId) === next) pending.delete(trackId);
  }
}

// Called by both prompt routes. Existing variants and the original prompt are preserved.
async function generateMissingVariants(
  db: Knex,
  trackId: number,
  languages: string[],
  generateBase: () => Promise<string>,
  translate: (system: string, source: string) => Promise<string>,
) {
  dialogueLanguagesSchema.parse(languages);
  const track = await db("o_videoTrack").where({ id: trackId }).first();
  if (!track) throw new Error("视频段不存在");
  const existing = await db("o_videoPromptVariant").where({ trackId });
  const missing = languages.filter((language) => !existing.some((row) => row.language === language && row.prompt?.trim()));
  if (!missing.length) return existing;
  for (const language of missing) {
    await db("o_videoPromptVariant")
      .insert({ trackId, language, state: "生成中", reason: null })
      .onConflict(["trackId", "language"])
      .merge({ state: "生成中", reason: null });
  }
  let base = track.prompt;
  try {
    if (!base?.trim()) {
      base = await generateBase();
      if (!base?.trim()) throw new Error("原版提示词为空");
      await db("o_videoTrack").where({ id: trackId }).update({ prompt: base });
    }
  } catch (cause) {
    await db("o_videoPromptVariant")
      .where({ trackId })
      .whereIn("language", missing)
      .update({ state: "生成失败", reason: (cause as Error).message });
    throw cause;
  }
  for (const language of missing) {
    try {
      const prompt = (await translate(translationInstruction(language), base)).trim();
      if (!prompt || prompt.startsWith("LANGUAGE_TIMING_REVIEW:")) throw new Error(prompt || "模型未返回提示词");
      const slots = (text: string) =>
        [...text.matchAll(/<(?:Picture|Subject|Image|Video|Audio)\s+\d+>/g)]
          .map((match) => match[0])
          .sort()
          .join(",");
      if (slots(base) !== slots(prompt)) throw new Error("翻译改变了参考图编号，请重试该语言");
      await db("o_videoPromptVariant").where({ trackId, language }).update({ prompt, state: "已完成", reason: null });
    } catch (cause) {
      await db("o_videoPromptVariant")
        .where({ trackId, language })
        .update({ state: "生成失败", reason: (cause as Error).message });
    }
  }
  return db("o_videoPromptVariant").where({ trackId });
}

export async function resolveLanguagePrompt(db: Knex, trackId: number, language: string | undefined, fallback: string, audio?: boolean) {
  if (!language) return fallback;
  dialogueLanguageSchema.parse(language);
  if (audio === false) throw new Error("生成对白语言版本前，请开启声音");
  const variant = await db("o_videoPromptVariant").where({ trackId, language }).first();
  if (!variant?.prompt?.trim() || variant.state !== "已完成") throw new Error(`${languageLabel(language)}提示词尚未就绪，请先生成并检查提示词`);
  return variant.prompt;
}
