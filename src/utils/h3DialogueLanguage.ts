export const H3_DIALOGUE_LOCALES = {
  original: { label: "跟随剧本原语言", tag: null, speechUnitsPerSecond: 0 },
  "zh-CN": { label: "中国·普通话", tag: "Chinese", speechUnitsPerSecond: 3.1 },
  "en-US": { label: "美国·美式英语", tag: "English", speechUnitsPerSecond: 2.35 },
  "en-GB": { label: "英国·英式英语", tag: "English", speechUnitsPerSecond: 2.35 },
  "ja-JP": { label: "日本·日语", tag: "Japanese", speechUnitsPerSecond: 4.0 },
  "ko-KR": { label: "韩国·韩语", tag: "Korean", speechUnitsPerSecond: 3.4 },
  "fr-FR": { label: "法国·法语", tag: "French", speechUnitsPerSecond: 2.35 },
  "de-DE": { label: "德国·德语", tag: "German", speechUnitsPerSecond: 2.25 },
  "es-ES": { label: "西班牙·西班牙语", tag: "Spanish", speechUnitsPerSecond: 2.55 },
  "es-MX": { label: "墨西哥·西班牙语", tag: "Spanish", speechUnitsPerSecond: 2.55 },
  "ru-RU": { label: "俄罗斯·俄语", tag: "Russian", speechUnitsPerSecond: 2.3 },
  "pt-BR": { label: "巴西·葡萄牙语", tag: "Portuguese", speechUnitsPerSecond: 2.4 },
} as const;

export type H3DialogueLocale = keyof typeof H3_DIALOGUE_LOCALES;

export function resolveH3DialogueLocale(value: unknown): H3DialogueLocale {
  if (value == null || value === "") return "original";
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(H3_DIALOGUE_LOCALES, value)) {
    return value as H3DialogueLocale;
  }
  throw new Error(`不支持的 H3 对白语言：${String(value)}`);
}

export function h3DialogueLocaleInstruction(value: unknown): string {
  const locale = resolveH3DialogueLocale(value);
  if (locale === "original") return "dialogue_locale=original. Preserve every script dialogue/VO line verbatim in its original language; do not translate.";
  const spec = H3_DIALOGUE_LOCALES[locale];
  return `dialogue_locale=${locale} (${spec.label}). Translate ONLY spoken dialogue and spoken voice-over into natural ${spec.tag} appropriate to ${locale}, preserving speaker, meaning, names, and emotional intent. Retain the exact source-language script for comparison; do not translate scene descriptions, asset names, or visual instructions. Use <d>[${spec.tag}] translated dialogue</d>. Do not copy original dialogue into a second spoken line.`;
}

/** A conservative advisory for single-voice speech time, not a forced duration extension. */
export function estimateH3SpeechSeconds(dialogue: string, localeValue: unknown): number {
  const locale = resolveH3DialogueLocale(localeValue);
  const rate = H3_DIALOGUE_LOCALES[locale].speechUnitsPerSecond;
  if (!rate) return 0; // original-language timing requires a separate locale estimate
  const normalized = dialogue.trim();
  if (!normalized) return 0;
  const words = normalized.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  const units = /^(zh|ja|ko)-/.test(locale)
    ? (normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length
    : words.length;
  const punctuationPauses = (normalized.match(/[,，、;；。.!?？！]/gu) || []).length * 0.2;
  return Number((units / rate + punctuationPauses + 0.25).toFixed(2));
}

/** Do not add durations blindly: speech may overlap with action, but must fit real playback time. */
export function checkH3DialogueBudget(dialogues: string[], locale: unknown, clipSeconds: number): { estimatedSeconds: number; fits: boolean } {
  const estimatedSeconds = Number(dialogues.reduce((sum, line) => sum + estimateH3SpeechSeconds(line, locale), 0).toFixed(2));
  return { estimatedSeconds, fits: estimatedSeconds <= clipSeconds };
}
