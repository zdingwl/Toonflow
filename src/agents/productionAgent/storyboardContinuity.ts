export type ContinuityMode = "PRESERVE" | "RESET";
export type ContinuityCutType = "SCENE_START" | "CONTINUOUS_ACTION" | "HARD_CUT" | "MATCH_CUT" | "TIME_JUMP" | "FX_TRANSITION";

export type StoryboardContinuityContract = {
  version: 1;
  continuityMode: ContinuityMode;
  cutType: ContinuityCutType;
  continuityGroup: string;
  entryStateId: string;
  exitStateId: string;
  entrySummary: string;
  exitSummary: string;
  entryAxisLock: string;
  exitAxisLock: string;
  entryScreenDirection: string;
  exitScreenDirection: string;
};

export type DirectorSceneTransition = {
  fromScene: number;
  toScene: number;
  continuityMode: ContinuityMode;
  cutType: Exclude<ContinuityCutType, "SCENE_START">;
};

export type StoryboardContinuityValidation = {
  errors: string[];
  warnings: string[];
  contracts: StoryboardContinuityContract[];
};

const contractLine = /^\*\*连续性契约\*\*\s*[：:]\s*(\{[^\n]+\})\s*$/m;
const segmentHeading = /^###\s*片段[^\n]*/gm;
const idPattern = /^[a-zA-Z0-9._:-]{3,128}$/;
const cutTypes = new Set<ContinuityCutType>(["SCENE_START", "CONTINUOUS_ACTION", "HARD_CUT", "MATCH_CUT", "TIME_JUMP", "FX_TRANSITION"]);

function splitSegments(markdown: string): string[] {
  const text = String(markdown || "");
  const headings = [...text.matchAll(segmentHeading)];
  return headings.map((heading, index) => text.slice(heading.index!, headings[index + 1]?.index ?? text.length).trim());
}

function parseContract(segment: string): StoryboardContinuityContract | undefined {
  const raw = contractLine.exec(segment)?.[1];
  if (!raw) return undefined;
  try { return JSON.parse(raw) as StoryboardContinuityContract; }
  catch { return undefined; }
}

function validateContractShape(contract: StoryboardContinuityContract, label: string, errors: string[]) {
  if (contract.version !== 1) errors.push(label + "连续性契约 version 必须为1");
  if (!["PRESERVE", "RESET"].includes(contract.continuityMode)) errors.push(label + "连续性契约 continuityMode 无效");
  if (!cutTypes.has(contract.cutType)) errors.push(label + "连续性契约 cutType 无效");
  if (!contract.continuityGroup?.trim()) errors.push(label + "连续性契约 continuityGroup 不能为空");
  if (!idPattern.test(contract.entryStateId || "")) errors.push(label + "连续性契约 entryStateId 无效");
  if (!idPattern.test(contract.exitStateId || "")) errors.push(label + "连续性契约 exitStateId 无效");
  if (!contract.entrySummary?.trim()) errors.push(label + "连续性契约 entrySummary 不能为空");
  if (!contract.exitSummary?.trim()) errors.push(label + "连续性契约 exitSummary 不能为空");
  if (!contract.entryAxisLock?.trim()) errors.push(label + "连续性契约 entryAxisLock 不能为空");
  if (!contract.exitAxisLock?.trim()) errors.push(label + "连续性契约 exitAxisLock 不能为空");
  if (!contract.entryScreenDirection?.trim()) errors.push(label + "连续性契约 entryScreenDirection 不能为空");
  if (!contract.exitScreenDirection?.trim()) errors.push(label + "连续性契约 exitScreenDirection 不能为空");
}

export function extractSceneContinuityContracts(markdown: string): StoryboardContinuityContract[] {
  return splitSegments(markdown).map(parseContract).filter(Boolean) as StoryboardContinuityContract[];
}

export function extractSceneExitContinuity(markdown: string): StoryboardContinuityContract | undefined {
  return extractSceneContinuityContracts(markdown).at(-1);
}

export function continuityHandoff(markdown: string): string {
  const last = extractSceneExitContinuity(markdown);
  if (!last) return "";
  return JSON.stringify({
    continuityGroup: last.continuityGroup,
    exitStateId: last.exitStateId,
    exitSummary: last.exitSummary,
    exitAxisLock: last.exitAxisLock,
    exitScreenDirection: last.exitScreenDirection,
  });
}

export function extractStoryboardSceneMarkdown(table: string, scene: number): string | undefined {
  const text = String(table || "");
  const headings = [...text.matchAll(/^##\s*场\s*(\d+)\s*[：:][^\n]*/gm)];
  const current = headings.find((heading) => Number(heading[1]) === scene);
  if (!current?.index && current?.index !== 0) return undefined;
  const currentIndex = headings.indexOf(current);
  return text.slice(current.index, headings[currentIndex + 1]?.index ?? text.length).trim();
}

export function readDirectorSceneTransition(plan: string, fromScene: number, toScene: number): DirectorSceneTransition | undefined {
  const rows = String(plan || "").split(/\r?\n/).filter(line => /^\s*\|\s*Sc\s*\d+\s*(?:→|->)\s*Sc\s*\d+\s*\|/i.test(line));
  for (const line of rows) {
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    const edge = /^Sc\s*(\d+)\s*(?:→|->)\s*Sc\s*(\d+)$/i.exec(cells[0] || "");
    if (!edge || Number(edge[1]) !== fromScene || Number(edge[2]) !== toScene) continue;
    const continuityMode = String(cells[1] || "").toUpperCase() as ContinuityMode;
    const cutType = String(cells[2] || "").toUpperCase() as DirectorSceneTransition["cutType"];
    if (!["PRESERVE", "RESET"].includes(continuityMode)) return undefined;
    if (!["CONTINUOUS_ACTION", "HARD_CUT", "MATCH_CUT", "TIME_JUMP", "FX_TRANSITION"].includes(cutType)) return undefined;
    return { fromScene, toScene, continuityMode, cutType };
  }
  return undefined;
}

export function validateStoryboardContinuity(
  markdown: string,
  previousScene?: string,
  options: { requireContracts?: boolean; expectedSceneTransition?: DirectorSceneTransition } = {},
): StoryboardContinuityValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const segments = splitSegments(markdown);
  const parsed = segments.map(parseContract);
  if (!segments.length) return { errors, warnings, contracts: [] };
  const missing = parsed.map((contract, index) => contract ? -1 : index).filter((index) => index >= 0);
  if (missing.length) {
    const message = "片段" + missing.map((index) => index + 1).join("、") + "缺少或无法解析 **连续性契约** JSON";
    if (options.requireContracts) errors.push(message); else warnings.push(message + "；按旧版分镜兼容读取，不能自动证明镜头连续");
  }
  const contracts = parsed.filter(Boolean) as StoryboardContinuityContract[];
  contracts.forEach((contract, index) => validateContractShape(contract, "片段" + (index + 1) + "：", errors));
  const seenExit = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const current = parsed[i];
    if (!current) continue;
    if (seenExit.has(current.exitStateId)) errors.push("片段" + (i + 1) + "重复使用 exitStateId：" + current.exitStateId);
    seenExit.add(current.exitStateId);
    const prior = i > 0 ? parsed[i - 1] : undefined;
    if (prior && current.continuityMode === "PRESERVE") {
      if (current.entryStateId !== prior.exitStateId) errors.push("片段" + (i + 1) + "声明 PRESERVE，但 entryStateId 未继承上一片段 exitStateId");
      if (current.continuityGroup !== prior.continuityGroup) errors.push("片段" + (i + 1) + "声明 PRESERVE，但 continuityGroup 与上一片段不一致");
      if (current.entryAxisLock !== prior.exitAxisLock) errors.push("片段" + (i + 1) + "声明 PRESERVE，但 entryAxisLock 未继承上一片段 exitAxisLock");
      if (current.entryScreenDirection !== prior.exitScreenDirection) errors.push("片段" + (i + 1) + "声明 PRESERVE，但 entryScreenDirection 未继承上一片段 exitScreenDirection");
    }
    if (prior && current.continuityMode === "RESET") {
      if (current.entryStateId === prior.exitStateId) errors.push("片段" + (i + 1) + "声明 RESET，但仍复用了上一片段 exitStateId");
      if (current.continuityGroup === prior.continuityGroup) errors.push("片段" + (i + 1) + "声明 RESET，但仍复用了上一片段 continuityGroup");
    }
  }
  const first = parsed[0];
  if (first && options.expectedSceneTransition) {
    if (first.continuityMode !== options.expectedSceneTransition.continuityMode) {
      errors.push("本场首片段 continuityMode 与导演规划不一致：应为 " + options.expectedSceneTransition.continuityMode);
    }
    if (first.cutType !== options.expectedSceneTransition.cutType) {
      errors.push("本场首片段 cutType 与导演规划不一致：应为 " + options.expectedSceneTransition.cutType);
    }
  }
  const previousExit = previousScene ? extractSceneExitContinuity(previousScene) : undefined;
  if (first && previousExit) {
    if (first.continuityMode === "PRESERVE") {
      if (first.entryStateId !== previousExit.exitStateId) errors.push("本场首片段声明跨场 PRESERVE，但 entryStateId 未继承上一场 exitStateId");
      if (first.continuityGroup !== previousExit.continuityGroup) errors.push("本场首片段声明跨场 PRESERVE，但 continuityGroup 与上一场不一致");
      if (first.entryAxisLock !== previousExit.exitAxisLock) errors.push("本场首片段声明跨场 PRESERVE，但 entryAxisLock 未继承上一场 exitAxisLock");
      if (first.entryScreenDirection !== previousExit.exitScreenDirection) errors.push("本场首片段声明跨场 PRESERVE，但 entryScreenDirection 未继承上一场 exitScreenDirection");
    } else {
      if (first.entryStateId === previousExit.exitStateId) errors.push("本场首片段声明 RESET，但仍复用了上一场 exitStateId");
      if (first.continuityGroup === previousExit.continuityGroup) errors.push("本场首片段声明 RESET，但仍复用了上一场 continuityGroup");
    }
  } else if (first && first.continuityMode === "PRESERVE" && !previousExit && previousScene) {
    errors.push("本场首片段要求跨场 PRESERVE，但上一场没有可读取的连续性出口契约");
  }
  return { errors, warnings, contracts };
}
