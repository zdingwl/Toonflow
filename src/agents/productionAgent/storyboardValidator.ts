export type SceneValidation = {
  valid: boolean;
  scene: number;
  errors: string[];
  warnings: string[];
  coverageVerified: boolean;
};

/** 严格校验结构与可辨识原文；无法定位原场次时不能宣称内容已全面覆盖。 */
export function validateStoryboardScene(scene: number, markdown: string, sourceScene?: string): SceneValidation {
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
  for (const [i, segment] of segments.entries()) {
    if (!/\|\s*序号\s*\|\s*画面描述\s*\|/.test(segment)) errors.push(`片段${i + 1}缺少分镜表头`);
    const lines = segment.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line));
    if (!lines.length) errors.push(`片段${i + 1}没有镜头行`);
    let duration = 0;
    for (const line of lines) {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length !== 7) { errors.push(`片段${i + 1}表格必须恰好7列`); continue; }
      const seconds = Number(cells[2]);
      if (!Number.isFinite(seconds) || seconds <= 0) errors.push(`片段${i + 1}存在无效时长`);
      else duration += seconds;
    }
    if (duration > 15) errors.push(`片段${i + 1}时长${duration}秒，超过15秒`);
  }
  const expected = [...(sourceScene ?? "").matchAll(/[『「“]([^』」”]+)[』」”]/g)]
    .map((match) => match[1].replace(/\s+/g, ""));
  let coverageVerified = false;
  if (sourceScene && expected.length) {
    const actual = text.replace(/\s+/g, "");
    const missing = expected.filter((line) => !actual.includes(line));
    if (missing.length) errors.push(`疑似遗漏原剧本台词或VO：${missing.slice(0, 3).join("；")}`);
    else coverageVerified = true;
  } else {
    warnings.push("未识别可逐字核对的原场次台词；只完成结构校验，不能宣称剧情内容完全覆盖");
  }
  return { valid: errors.length === 0, scene, errors, warnings, coverageVerified };
}

/** 无明确场次标题时返回 undefined，绝不猜测场次边界。 */
export function extractSourceScene(script: string, scene: number): string | undefined {
  const matches = [...script.matchAll(/^(?:#{1,4}\s*)?场\s*(\d+)\s*[：:、.\s]/gm)];
  const index = matches.findIndex((match) => Number(match[1]) === scene);
  if (index < 0) return undefined;
  return script.slice(matches[index].index!, matches[index + 1]?.index ?? script.length);
}
