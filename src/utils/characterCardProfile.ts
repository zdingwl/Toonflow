import type { CharacterAgeBand } from "./characterCards";

/** Matching uses explicit source facts and user settings, never a name or an old AI appearance. */
export function characterCardProfile(facts: { fact: string }[], userConstraints: string) {
  const source = facts.map(item => item.fact).join("；");
  const text = source + "；" + userConstraints;
  const numbers: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const ageNumber = (value: string) => /^\d+$/u.test(value) ? Number(value)
    : value.includes("十") ? (numbers[value.split("十")[0]] || 1) * 10 + (numbers[value.split("十")[1]] || 0) : numbers[value];
  let lower: number | null = null, upper: number | null = null;
  const numberPattern = "(?:[0-9]{1,3}|[零一二两三四五六七八九十]{1,3})";
  const negative = /未(?:经|明确)?确认|尚未确认|不是|并非|不要|不(?:确认|默认|推断|设为|写|能|得)|禁止|不得|年龄未知/u;
  const prefixAt = (index: number) => text.slice(Math.max(0, index - 16), index).split(/[。；\n]/u).at(-1) || "";
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(new RegExp(`(${numberPattern})\\s*(?:岁)?\\s*(?:至|到|[-–~～])\\s*(${numberPattern})\\s*(?:周)?岁`, "gu"))) {
    const min = ageNumber(match[1]), max = ageNumber(match[2]);
    ranges.push([match.index!, match.index! + match[0].length]);
    if (negative.test(prefixAt(match.index!)) || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 120) continue;
    lower = Math.max(lower ?? 0, min); upper = Math.min(upper ?? 120, max);
  }
  for (const match of text.matchAll(new RegExp(`(${numberPattern})\\s*(?:周)?岁(以上|以下|左右)?`, "gu"))) {
    if (ranges.some(([start, end]) => match.index! >= start && match.index! < end)) continue;
    const age = ageNumber(match[1]), prefix = prefixAt(match.index!);
    if (!Number.isFinite(age) || age < 0 || age > 120 || negative.test(prefix) || match[2] === "左右") continue;
    if (/未满|不满/u.test(prefix)) upper = Math.min(upper ?? 120, age - 1);
    else if (match[2] === "以上" || /已满|年满|至少/u.test(prefix)) lower = Math.max(lower ?? 0, age);
    else if (match[2] === "以下") upper = Math.min(upper ?? 120, age);
    else { lower = Math.max(lower ?? 0, age); upper = Math.min(upper ?? 120, age); }
  }
  for (const match of text.matchAll(/未成年|成年人?|18\+/gu)) {
    if (negative.test(prefixAt(match.index!))) continue;
    if (match[0] === "未成年") upper = Math.min(upper ?? 120, 17);
    else lower = Math.max(lower ?? 0, 18);
  }
  if (lower !== null && upper !== null && lower > upper) throw new Error("人物的原文年龄与用户年龄设定互相冲突，请核对");
  const categoryRules: { band: CharacterAgeBand; pattern: RegExp; min: number; max: number }[] = [
    { band: "child", pattern: /儿童|孩童|女童|男童/gu, min: 0, max: 11 },
    { band: "teen", pattern: /青少年|少年|少女/gu, min: 12, max: 17 },
    { band: "middle", pattern: /中年/gu, min: 40, max: 59 },
    { band: "elderly", pattern: /老年|老人|长者/gu, min: 60, max: 120 },
  ];
  const categories = categoryRules.filter(rule => [...text.matchAll(rule.pattern)].some(match => !negative.test(prefixAt(match.index!))));
  if (categories.length > 1 || categories.some(rule => (lower !== null && lower > rule.max) || (upper !== null && upper < rule.min)))
    throw new Error("人物的明确年龄段与年龄范围互相冲突，请核对");
  let ageBand: CharacterAgeBand = "unknown";
  if (lower !== null && lower >= 18) ageBand = upper === null ? "adult"
    : lower >= 60 ? "elderly" : lower >= 40 && upper < 60 ? "middle" : "adult";
  else if (lower !== null && upper !== null) ageBand = upper < 12 ? "child" : lower >= 12 && upper < 18 ? "teen" : "unknown";
  const category = categories[0];
  if (category) ageBand = category.band;
  // Library classification never invents a bound; original bounds remain in project metadata.
  const ageMin = ageBand === "unknown" || (category && lower !== null && lower < category.min) ? null : lower;
  const ageMax = ageBand === "unknown" || (category && upper !== null && upper > category.max) ? null : upper;
  const searchAgeMin = lower, searchAgeMax = lower === null && upper === 18 ? 17 : upper;
  const searchAgeBand = category?.band || (lower !== null || upper !== null ? undefined : "unknown" as CharacterAgeBand);
  const hasGender = (pattern: RegExp) => [...text.matchAll(pattern)].some(match => !negative.test(prefixAt(match.index!)));
  const female = hasGender(/女性|女人|女孩|女童|女主(?:角)?/gu);
  const male = hasGender(/男性|男人|男孩|男童|男主(?:角)?/gu);
  const gender = female && !male ? "female" : male && !female ? "male" : "unknown";
  return { ageMin, ageMax, ageBand, searchAgeBand, searchAgeMin, searchAgeMax, ageBounds: { min: lower, max: upper }, gender };
}
