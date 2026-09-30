import type { Knex } from "knex";
import { z } from "zod";
import { migrateLanguageDurationColumns, planLanguageVariantDuration, retimeLanguagePromptInstruction } from "./videoLanguageTiming";

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

const h3DialogueLanguageNames: Record<string, string> = {
  "zh-CN": "Chinese",
  "en-US": "English",
  "en-GB": "English",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "fr-FR": "French",
  "de-DE": "German",
  "es-ES": "Spanish",
  "es-MX": "Spanish",
  "pt-BR": "Portuguese",
  "it-IT": "Italian",
  "ru-RU": "Russian",
  "ar-SA": "Arabic",
  "hi-IN": "Hindi",
  "th-TH": "Thai",
  "vi-VN": "Vietnamese",
  "id-ID": "Indonesian",
};

// A completed language variant must contain target-language dialogue, not merely English prose
// surrounding dialogue copied from the source language.
export function assertTranslatedDialogueLanguage(prompt: string, language: string) {
  const expected = h3DialogueLanguageNames[language];
  if (!expected) return;
  const dialogue = [...String(prompt || "").matchAll(/<d(?:\s[^>]*)?>([\s\S]*?)<\/d>/gi)].map((match) => match[1].trim());
  for (const line of dialogue) {
    const tag = line.match(/^\[([^\]]+)\]/)?.[1]?.trim();
    if (tag !== expected) throw new Error(`PROMPT_DIALOGUE_LANGUAGE: ${language} 对白必须使用 [${expected}] 标签，不能保留 ${tag ? `[${tag}]` : "源语言"} 对白`);
    if (expected === "English" && /\p{Script=Han}/u.test(line.replace(/^\[[^\]]+\]\s*/, ""))) {
      throw new Error(`PROMPT_DIALOGUE_LANGUAGE: ${language} 对白仍包含中文字符`);
    }
  }
  const localeCodes = [...String(prompt || "").matchAll(/spoken\s+(?:language|locale)\s*:\s*([a-z]{2}-[A-Z]{2})/gi)].map((match) => match[1].toLowerCase());
  if (localeCodes.some((code) => code !== language.toLowerCase())) {
    throw new Error(`PROMPT_DIALOGUE_LANGUAGE: spoken language 必须全部为 ${language}`);
  }
  if (expected === "English" && /\p{Script=Han}/u.test(String(prompt || ""))) {
    throw new Error(`PROMPT_VISIBLE_TEXT_LANGUAGE: ${language} 版本仍包含中文画面文字`);
  }
  if (expected === "English" && (
    /\bChinese\s+(?:system\s+lines?|interface\s+text|warning\s+text|characters?|text|labels?|buttons?|subtitles?|signs?)\b/i.test(prompt)
    || /\b(?:visible|required|on-screen|screen|display|interface|button|label|subtitle|sign)\s+(?:\w+[\s-]+){0,3}Chinese\s+(?:text|characters?|lines?|labels?|buttons?)\b/i.test(prompt)
  )) {
    throw new Error(`PROMPT_VISIBLE_TEXT_LANGUAGE: ${language} 版本仍要求生成中文画面文字`);
  }
}

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
      table.float("duration");
      table.primary(["trackId", "language"]);
    });
  if (!(await db.schema.hasTable("o_videoLanguage")))
    await db.schema.createTable("o_videoLanguage", (table) => {
      table.integer("videoId").primary();
      table.text("language").notNullable();
      table.text("prompt").notNullable();
      table.float("duration");
    });
  await migrateLanguageDurationColumns(db);
}

export function translationInstruction(language: string) {
  return `制作同一视频的${languageLabel(language)}（${language}）对白版本。只返回完整视频提示词，不要解释。
将所有人物对白、独白和旁白翻译成该地区自然地道的目标语言；存在发声台词时明确标注 spoken language 为 ${language}，画面内实际开口说话的人物才需要口型与目标语言同步。没有发声台词的片段保持原样，不必给风声、海浪等环境音添加地区语言标签。系统电子声、旁白、画外音保持原声源方式，不附加口型同步，不让界面或手机张嘴，也不让听者替声源动嘴。
保持原提示词的章节名称、结构和视觉指令语言（原来是英文就仍用英文）。如使用 <d>[Chinese] 台词</d>，把发声台词及其语言标记改为目标语言；画面中明确可见的按钮、界面、招牌、字幕和屏幕文字也必须翻译成目标语言，目标语言版本不得残留源语言文字。
英语版本中不得保留“Chinese text”“Chinese system lines”“Chinese interface text”“Chinese characters”等要求画面生成中文文字的英文描述；必须同步改成 English text/lines/interface wording。描述“中国风三维动画”等画风的 Chinese 3D donghua 不属于文字语言指令，可以保留。
H3 对白必须保持 <d>[Language] 台词</d>，语言名称用 English、Chinese、Japanese 等英文名称；地区和口音写在标签外，禁止把地区编码写成 d 标签的属性。保持原提示词的自由结构、Subject/Picture 对应关系和具体画风要求；不要新增固定章节，也不能用泛化的 cinematic 或 high quality 替换具体视觉描述。
保持剧情、角色姓名与身份、场景、服装、镜头顺序、视觉描述、参考图编号和素材标记不变；不能将角色或场景搬到目标国家。
对白称谓和亲属关系必须准确保留，例如姐姐/妹妹不能改成 darling 等泛称；原文区分长幼时，目标语也要保留这个区别，例如英语的 Big sister / little sister，不能只用不区分长幼的 sister；不添加原文没有的调侃、昵称或新台词。
视觉描述保留以全局内容表现约束为前提：旧文的红色血液、红色伤口及血色环境须改为遮挡包扎、必要的少量绿色或黑色血迹、自然环境色，并同步修正反射光；已有绿色或黑色沿用，不得在翻译中还原成红色。此例外不改变剧情因果、对白含义、正常红衣红灯或参考图编号。
原文无对白的镜头保持无对白，不得添加台词。不要把原语言对白或中文译文混入发声内容。声音参考只用于音色，不得复制其原语言台词。
不要为了迁就源语言时长而加速、删减或截断目标语言对白。先按目标语言自然表达并保留原有镜头顺序；后端会根据译文重新计算该语言的独立时长，并在需要时进行第二次时间轴重排。`;
}

const pendingVariants = new WeakMap<Knex, Map<number, Promise<unknown>>>();
// Serialize overlapping requests for the same track and recheck saved versions after waiting.
export async function generateLanguageVariants(
  db: Knex,
  trackId: number,
  languages: string[],
  generateBase: () => Promise<string>,
  translate: (system: string, source: string, language: string, targetDuration?: number) => Promise<string>,
  regenerate = false,
  validateReferenceLabels = true,
  validateCompletedPrompt?: (prompt: string, language: string, duration: number) => void | Promise<void>,
  validateBasePrompt?: (prompt: string) => void | Promise<void>,
) {
  let pending = pendingVariants.get(db);
  if (!pending) {
    pending = new Map();
    pendingVariants.set(db, pending);
  }
  const previous = pending.get(trackId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => generateMissingVariants(db, trackId, languages, generateBase, translate, regenerate, validateReferenceLabels, validateCompletedPrompt, validateBasePrompt));
  pending.set(trackId, next);
  try {
    return await next;
  } finally {
    if (pending.get(trackId) === next) pending.delete(trackId);
  }
}

// Batch fill preserves existing versions; explicit regeneration refreshes requested languages only.
async function generateMissingVariants(
  db: Knex,
  trackId: number,
  languages: string[],
  generateBase: () => Promise<string>,
  translate: (system: string, source: string, language: string, targetDuration?: number) => Promise<string>,
  regenerate: boolean,
  validateReferenceLabels: boolean,
  validateCompletedPrompt?: (prompt: string, language: string, duration: number) => void | Promise<void>,
  validateBasePrompt?: (prompt: string) => void | Promise<void>,
) {
  dialogueLanguagesSchema.parse(languages);
  const track = await db("o_videoTrack").where({ id: trackId }).first();
  if (!track) throw new Error("视频段不存在");
  const existing = await db("o_videoPromptVariant").where({ trackId });
  const baseDuration = Number(track.duration) || 5;
  const completedVariantIsValid = async (row: any, language: string) => {
    if (row.language !== language || !row.prompt?.trim() || row.state !== "已完成") return false;
    try {
      assertTranslatedDialogueLanguage(row.prompt, language);
      const duration = Number(row.duration) || planLanguageVariantDuration(track.prompt || "", row.prompt, language, baseDuration);
      // Old variants had no language-specific duration. If natural target speech changes
      // the clip length, force one regeneration/retiming pass instead of silently
      // blessing old timestamps against the new budget.
      if (!Number(row.duration) && Math.abs(duration - baseDuration) > 0.05) return false;
      if (!Number(row.duration)) {
        await db("o_videoPromptVariant").where({ trackId, language }).update({ duration });
        row.duration = duration;
      }
      await validateCompletedPrompt?.(row.prompt, language, duration);
      return true;
    } catch { return false; }
  };
  const missing: string[] = [];
  for (const language of languages) {
    let valid = false;
    for (const row of existing) {
      if (await completedVariantIsValid(row, language)) { valid = true; break; }
    }
    if (regenerate || !valid) missing.push(language);
  }
  if (!missing.length) return existing;
  for (const language of missing) {
    await db("o_videoPromptVariant")
      .insert({ trackId, language, state: "生成中", reason: null })
      .onConflict(["trackId", "language"])
      .merge({ state: "生成中", reason: null });
  }
  let base = track.prompt;
  try {
    let baseIsValid = Boolean(base?.trim());
    if (baseIsValid && validateBasePrompt) {
      try { await validateBasePrompt(base); } catch { baseIsValid = false; }
    }
    if (regenerate || !baseIsValid) {
      base = await generateBase();
      if (!base?.trim()) throw new Error("原版提示词为空");
      if (!track.prompt?.trim()) await db("o_videoTrack").where({ id: trackId }).update({ prompt: base });
    }
  } catch (cause) {
    await db("o_videoPromptVariant")
      .where({ trackId })
      .whereIn("language", missing)
      // A rejected base may be in another language. Keep every prior variant and video link.
      .update({ state: "生成失败", reason: (cause as Error).message });
    throw cause;
  }
  for (const language of missing) {
    try {
      let prompt = (await translate(translationInstruction(language), base, language, baseDuration)).trim();
      if (!prompt || prompt.startsWith("LANGUAGE_TIMING_REVIEW:")) throw new Error(prompt || "模型未返回提示词");
      assertTranslatedDialogueLanguage(prompt, language);
      const duration = planLanguageVariantDuration(base, prompt, language, baseDuration);
      if (Math.abs(duration - baseDuration) > 0.05) {
        prompt = (await translate(retimeLanguagePromptInstruction(language, duration), prompt, language, duration)).trim();
        if (!prompt || prompt.startsWith("LANGUAGE_TIMING_REVIEW:")) throw new Error(prompt || "模型未返回重排后的完整提示词");
        assertTranslatedDialogueLanguage(prompt, language);
      }
      const slots = (text: string) =>
        [...new Set([...text.replace(/<d\b[^>]*>[\s\S]*?<\/d>/g, "").matchAll(/<(?:Picture|Subject|Image|Video|Audio)\s+\d+>/g)]
          .map((match) => match[0]))]
          .sort()
          .join(",");
      if (validateReferenceLabels && slots(base) !== slots(prompt)) throw new Error("翻译改变了参考图编号，请重试该语言");
      await validateCompletedPrompt?.(prompt, language, duration);
      await db("o_videoPromptVariant").where({ trackId, language }).update({ prompt, duration, state: "已完成", reason: null });
    } catch (cause) {
      await db("o_videoPromptVariant")
        .where({ trackId, language })
        // Failed candidates are diagnostic output, not a replacement for saved language text.
        .update({ state: "生成失败", reason: (cause as Error).message });
    }
  }
  return db("o_videoPromptVariant").where({ trackId });
}

export async function resolveLanguageVariant(
  db: Knex, trackId: number, language: string | undefined, fallbackPrompt: string, fallbackDuration?: number, audio?: boolean,
): Promise<{ prompt: string; duration: number }> {
  if (!language) return { prompt: fallbackPrompt, duration: Number(fallbackDuration) || 5 };
  dialogueLanguageSchema.parse(language);
  if (audio === false) throw new Error("生成对白语言版本前，请开启声音");
  const variant = await db("o_videoPromptVariant").where({ trackId, language }).first();
  if (!variant?.prompt?.trim() || variant.state !== "已完成") throw new Error(`${languageLabel(language)}提示词尚未就绪，请先生成并检查提示词`);
  const track = await db("o_videoTrack").where({ id: trackId }).select("prompt", "duration").first();
  const baseDuration = Number(track?.duration) || Number(fallbackDuration) || 5;
  const storedDuration = Number(variant.duration);
  const plannedDuration = storedDuration || planLanguageVariantDuration(
    track?.prompt || fallbackPrompt, variant.prompt, language, baseDuration,
  );
  if (!storedDuration && Math.abs(plannedDuration - baseDuration) > 0.05) {
    throw new Error(`${languageLabel(language)}旧版提示词需要按目标语言重新规划时间轴，请先重新生成该语言提示词`);
  }
  if (!storedDuration) await db("o_videoPromptVariant").where({ trackId, language }).update({ duration: plannedDuration });
  return { prompt: variant.prompt, duration: plannedDuration };
}

export async function resolveLanguagePrompt(db: Knex, trackId: number, language: string | undefined, fallback: string, audio?: boolean) {
  return (await resolveLanguageVariant(db, trackId, language, fallback, undefined, audio)).prompt;
}
