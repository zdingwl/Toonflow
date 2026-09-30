import { extractDialogue, normalizeSpokenText, parseScriptScenes } from "./screenplay";
import { validateStoryboardContinuity, type DirectorSceneTransition } from "./storyboardContinuity";

export type SceneValidation = {
  valid: boolean;
  scene: number;
  errors: string[];
  warnings: string[];
  coverageVerified: boolean;
};

/** 严格校验结构与可辨识原文；无法定位原场次时不能宣称内容已全面覆盖。 */
export function validateStoryboardScene(scene: number, markdown: string, sourceScene?: string, options: { targetDuration?: number; assetIds?: number[]; previousScene?: string; requireContinuityContract?: boolean; expectedSceneTransition?: DirectorSceneTransition } = {}): SceneValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = markdown.trim();
  const headings = [...text.matchAll(/^##\s*场\s*(\d+)\s*[：:]/gm)];
  if (headings.length !== 1 || Number(headings[0]?.[1]) !== scene || headings[0]?.index !== 0) {
    errors.push(`必须有且只有“## 场${scene}：”场头`);
  }
  const parts = [...text.matchAll(/^###\s*片段[^\n]*/gm)];
  if (!parts.length) errors.push("当前场没有任何分镜片段");
  const segments = parts.map((part, i) => text.slice(part.index!, parts[i + 1]?.index ?? text.length));
  const dialogueCells: string[] = [];
  let sceneDuration = 0;
  for (const [i, segment] of segments.entries()) {
    if (!/\|\s*序号\s*\|\s*画面描述\s*\|/.test(segment)) errors.push(`片段${i + 1}缺少分镜表头`);
    const lines = segment.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line));
    if (!lines.length) errors.push(`片段${i + 1}没有镜头行`);
    let duration = 0;
    for (const line of lines) {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length !== 7) { errors.push(`片段${i + 1}表格必须恰好7列`); continue; }
      const seconds = Number(cells[2]);
      dialogueCells.push(cells[5]);
      if (!Number.isFinite(seconds) || seconds <= 0) errors.push(`片段${i + 1}存在无效时长`);
      else duration += seconds;
    }
    if (duration > 15) errors.push(`片段${i + 1}时长${duration}秒，超过15秒`);
    sceneDuration += duration;
    const declared = segment.split("\n")[0].match(/[（(]约?\s*(\d+(?:\.\d+)?)\s*(?:s|秒)[）)]/i);
    if (declared && Math.abs(Number(declared[1]) - duration) > 0.05) errors.push(`片段${i + 1}标题时长与镜头合计${duration}秒不一致`);
    if (options.assetIds) {
      const refs = segment.match(/引用资产ID(?:（[^）]*）)?\*\*\s*[：:]\s*\[([^\]]*)\]/i);
      const ids = refs?.[1].split(/[,，]/).map(id => Number(id.trim())) ?? [];
      if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || !options.assetIds!.includes(id))) {
        errors.push(`片段${i + 1}引用资产缺失或不属于当前项目`);
      }
    }
  }
  if (options.targetDuration !== undefined && Math.abs(sceneDuration - options.targetDuration) > 0.05) {
    errors.push(`第${scene}场合计${sceneDuration}秒，与制作预算${options.targetDuration}秒不一致`);
  }
  const expectedDialogue = extractDialogue(sourceScene ?? "");
  const expected = [...(sourceScene ?? "").matchAll(/[『「“]([^』」”]+)[』」”]/g)].map(match => match[1]);
  let coverageVerified = false;
  if (expectedDialogue.length) {
    const actualBySpeaker = new Map<string, string>();
    for (const cell of dialogueCells) {
      for (const match of cell.matchAll(/([^：:『「“；;]+?)[：:]\s*[『「“]([^』」”]+)[』」”]/g)) {
        const speaker = match[1].trim().replace(/[（(][^）)]*[）)]/g, "").replace(/说$/, "");
        actualBySpeaker.set(speaker, (actualBySpeaker.get(speaker) ?? "") + normalizeSpokenText(match[2]));
      }
    }
    const expectedBySpeaker = new Map<string, string>();
    for (const line of expectedDialogue) expectedBySpeaker.set(line.speaker, (expectedBySpeaker.get(line.speaker) ?? "") + normalizeSpokenText(line.text));
    for (const [speaker, spoken] of expectedBySpeaker) {
      if (actualBySpeaker.get(speaker) !== spoken) errors.push(`台词遗漏、改写、顺序或说话人不符：${speaker}`);
    }
    for (const speaker of actualBySpeaker.keys()) if (!expectedBySpeaker.has(speaker)) errors.push(`出现原场次没有的说话人：${speaker}`);
    coverageVerified = !errors.some(error => /台词|说话人/.test(error));
  } else if (sourceScene && expected.length) {
    const actual = normalizeSpokenText(dialogueCells.join(""));
    const missing = expected.filter(line => !actual.includes(normalizeSpokenText(line)));
    if (missing.length) errors.push(`疑似遗漏原剧本台词或VO：${missing.slice(0, 3).join("；")}`);
    else coverageVerified = true;
  } else {
    warnings.push("未识别可逐字核对的原场次台词；只完成结构校验，不能宣称剧情内容完全覆盖");
  }
  const screens = [...(sourceScene ?? "").matchAll(/【([^】]+)】/g)].map(match => normalizeSpokenText(match[1]));
  const shown = [...text.matchAll(/【([^】]+)】/g)].map(match => normalizeSpokenText(match[1])).join("");
  if (screens.some(screen => !shown.includes(screen))) {
    errors.push("遗漏或改写原剧本必须呈现的屏幕文字"); coverageVerified = false;
  }
  const continuity = validateStoryboardContinuity(text, options.previousScene, {
    requireContracts: options.requireContinuityContract,
    expectedSceneTransition: options.expectedSceneTransition,
  });
  errors.push(...continuity.errors);
  warnings.push(...continuity.warnings);
  if (coverageVerified) warnings.push("已核对可解析的台词和屏幕文字；人物动作、空间关系及参考图状态仍需审阅");
  return { valid: errors.length === 0, scene, errors, warnings, coverageVerified };
}

/** 无明确场次标题时返回 undefined，绝不猜测场次边界。 */
export function extractSourceScene(script: string, scene: number): string | undefined {
  return parseScriptScenes(script).find(item => item.scene === scene)?.text;
}
