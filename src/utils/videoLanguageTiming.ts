import type { Knex } from "knex";

type SpeechProfile = { unit: "word" | "char"; rate: number };

const speechProfiles: Record<string, SpeechProfile> = {
  Chinese: { unit: "char", rate: 3.4 },
  Japanese: { unit: "char", rate: 4.0 },
  Korean: { unit: "char", rate: 3.8 },
  English: { unit: "word", rate: 2.5 },
  French: { unit: "word", rate: 2.6 },
  German: { unit: "word", rate: 2.35 },
  Spanish: { unit: "word", rate: 2.8 },
  Portuguese: { unit: "word", rate: 2.7 },
  Italian: { unit: "word", rate: 2.75 },
  Russian: { unit: "word", rate: 2.35 },
  Arabic: { unit: "word", rate: 2.3 },
  Hindi: { unit: "word", rate: 2.45 },
  Thai: { unit: "char", rate: 4.2 },
  Vietnamese: { unit: "word", rate: 2.8 },
  Indonesian: { unit: "word", rate: 2.8 },
};

const localeToSpeechName: Record<string, string> = {
  "zh-CN": "Chinese", "en-US": "English", "en-GB": "English", "ja-JP": "Japanese", "ko-KR": "Korean",
  "fr-FR": "French", "de-DE": "German", "es-ES": "Spanish", "es-MX": "Spanish", "pt-BR": "Portuguese",
  "it-IT": "Italian", "ru-RU": "Russian", "ar-SA": "Arabic", "hi-IN": "Hindi", "th-TH": "Thai",
  "vi-VN": "Vietnamese", "id-ID": "Indonesian",
};

function estimateDialogueSeconds(prompt: string, fallbackLanguage?: string): number {
  const fallbackName = fallbackLanguage ? localeToSpeechName[fallbackLanguage] : undefined;
  let total = 0;
  for (const match of String(prompt || "").matchAll(/<d(?:\s[^>]*)?>([\s\S]*?)<\/d>/gi)) {
    const raw = match[1].trim();
    const tagged = /^\[([^\]]+)\]\s*/.exec(raw);
    const name = tagged?.[1]?.trim() || fallbackName || "English";
    const text = raw.replace(/^\[[^\]]+\]\s*/, "").replace(/^\(spoken locale:[^)]+\)\s*/i, "").trim();
    if (!text) continue;
    const profile = speechProfiles[name] || speechProfiles.English;
    const units = profile.unit === "char"
      ? [...text.replace(/[\p{P}\p{S}\s]/gu, "")].length
      : (text.match(/[\p{L}\p{N}]+(?:[\u0027’\-][\p{L}\p{N}]+)*/gu) || []).length;
    const pauses = (text.match(/[,，、;；:：]/g) || []).length * 0.18
      + (text.match(/[.!?。！？…]/g) || []).length * 0.32;
    total += Math.max(0.65, units / profile.rate + pauses);
  }
  return total;
}

export function planLanguageVariantDuration(
  sourcePrompt: string, translatedPrompt: string, language: string, baseDuration: number,
): number {
  const base = Number.isFinite(baseDuration) && baseDuration > 0 ? baseDuration : 5;
  const sourceSpeech = estimateDialogueSeconds(sourcePrompt);
  const targetSpeech = estimateDialogueSeconds(translatedPrompt, language);
  // Only retime when the source prompt exposes machine-readable dialogue timing.
  // Legacy free-form prompts have no reliable way to distinguish speech time from visual time.
  if (!sourceSpeech || !targetSpeech) return base;
  const visualBudget = Math.max(0.75, base - sourceSpeech);
  const planned = Math.ceil((visualBudget + targetSpeech) * 2) / 2;
  if (planned > 15) {
    throw new Error("LANGUAGE_TIMING_REVIEW: " + language + " natural dialogue requires about " + planned.toFixed(1) + "s, exceeding the 15s clip limit; split the clip or revise the dialogue structure");
  }
  return Math.max(4, planned);
}

export function retimeLanguagePromptInstruction(language: string, duration: number): string {
  return "This is an already translated " + language + " language variant. Retiming only: do not retranslate or rewrite dialogue, add/remove shots, change event order, character actions, reference indices, or visual content. Return the complete prompt only.\n" +
    "The new target duration is " + duration + "s. Let all target-language speech play at a natural pace and redistribute shot timing, action holds and pauses across this duration; never speed-read, truncate or delete information.\n" +
    "For H3 keep the same six-section structure. [Shot 1] has no timestamp; every later [Shot N] At MM:SS.mmm must be replanned against the new " + duration + "s target, strictly increasing and below target_duration. Keep every <d>...</d> line verbatim.";
}

export async function migrateLanguageDurationColumns(db: Knex): Promise<void> {
  if (await db.schema.hasTable("o_videoPromptVariant")) {
    if (!(await db.schema.hasColumn("o_videoPromptVariant", "duration")))
      await db.schema.alterTable("o_videoPromptVariant", (table) => table.float("duration"));
  }
  if (await db.schema.hasTable("o_videoLanguage")) {
    if (!(await db.schema.hasColumn("o_videoLanguage", "duration")))
      await db.schema.alterTable("o_videoLanguage", (table) => table.float("duration"));
  }
}
