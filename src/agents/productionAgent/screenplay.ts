/** Pure screenplay facts. Never import the application DB here (it runs startup recovery). */
export type ScriptDialogue = { speaker: string; text: string };
export type ScriptScene = {
  scene: number; title: string; text: string;
  sourceDuration?: number; dialogue: ScriptDialogue[]; screenText: string[];
};

function sceneNumber(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits = "零一二三四五六七八九";
  let total = 0, digit = 0;
  for (const char of raw.replace(/两/g, "二")) {
    if (digits.includes(char)) digit = digits.indexOf(char);
    else { total += (digit || 1) * ({ 十: 10, 百: 100 }[char] ?? 0); digit = 0; }
  }
  return total + digit;
}

export const normalizeSpokenText = (text: string) => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
export const spokenCharacterCount = (text: string) => [...normalizeSpokenText(text)].length;

export function extractDialogue(text: string): ScriptDialogue[] {
  const lines = text.split(/\r?\n/).map(line => line.trim().replace(/^\*\*(.*?)\*\*$/, "$1")).filter(Boolean);
  const result: ScriptDialogue[] = [];
  const label = /^([\p{L}][\p{L}\p{N}· ._-]{0,24}?)(?:[（(](?:VO|OS|旁白|画外音|独白)[）)])?$/u;
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^([^：:【】。！？!?]{1,25}?)(?:[（(](?:VO|OS|旁白|画外音|独白)[）)])?[：:]\s*[『「“](.+)[』」”]$/);
    if (inline) { result.push({ speaker: inline[1].trim().replace(/说$/, ""), text: inline[2] }); continue; }
    const speaker = lines[i].match(label)?.[1]?.trim();
    const next = lines[i + 1];
    if (speaker && next && !/^【|^(?:#{1,4}\s*)?场(?:景)?[一二三四五六七八九十百\d]/.test(next) &&
        /[。！？!?…『「“]/.test(next) && !label.test(next)) {
      result.push({ speaker, text: next.replace(/^[『「“]|[』」”]$/g, "") }); i++;
    }
  }
  return result;
}

export function parseScriptScenes(script: string): ScriptScene[] {
  const headings = [...script.matchAll(/^(?:#{1,4}\s*)?(?:\*\*)?场(?:景)?\s*([零一二三四五六七八九十百两\d]+)(?=[\s：:、.（(])[^\r\n]*/gm)];
  return headings.map((heading, index) => {
    const text = script.slice(heading.index!, headings[index + 1]?.index ?? script.length).trim();
    const range = heading[0].match(/[（(]\s*(\d+(?:\.\d+)?)\s*[–—\-~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[）)]/i);
    const duration = range ? Number(range[2]) - Number(range[1]) : undefined;
    return { scene: sceneNumber(heading[1]), title: heading[0], text,
      sourceDuration: duration && duration > 0 ? duration : undefined,
      dialogue: extractDialogue(text), screenText: [...text.matchAll(/【([^】]+)】/g)].map(m => m[1]),
    };
  });
}

/** A separate, explicit production budget can supersede source annotations. */
export function productionSceneBudget(plan: string, scene: number, sourceScene?: string): number | undefined {
  const rows = plan.split(/\r?\n/).filter(line => /^\s*\|/.test(line))
    .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
  let budgetColumn = -1;
  for (const row of rows) {
    if (row[0] === "场次") { budgetColumn = row.findIndex(cell => /^制作预算[（(]秒[）)]$/.test(cell)); continue; }
    if (budgetColumn >= 0 && new RegExp(`^(?:Sc|场)\\s*${scene}$`, "i").test(row[0])) {
      if (row[budgetColumn] === "待确认" && (!sourceScene || !parseScriptScenes(sourceScene)[0]?.sourceDuration)) return undefined;
      const value = Number(row[budgetColumn]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`第${scene}场制作预算无效`);
      return value;
    }
  }
  return sourceScene ? parseScriptScenes(sourceScene)[0]?.sourceDuration : undefined;
}

export function screenplayFacts(script: string, plan = ""): string {
  const scenes = parseScriptScenes(script);
  if (!scenes.length) return "未识别明确场界；先核对原剧本，不能宣称已完成逐场统计。";
  return JSON.stringify(scenes.map(scene => ({
    scene: scene.scene, title: scene.title, source_duration: scene.sourceDuration,
    target_duration: productionSceneBudget(plan, scene.scene, scene.text),
    dialogue_count: scene.dialogue.length,
    dialogue_characters: scene.dialogue.reduce((sum, line) => sum + spokenCharacterCount(line.text), 0),
    dialogue: scene.dialogue, screen_text: scene.screenText,
  })), null, 2);
}

export function validateDirectorFacts(script: string, plan: string): string[] {
  const scenes = parseScriptScenes(script);
  if (!scenes.length) return [];
  const rows = plan.split(/\r?\n/).filter(line => /^\s*\|\s*Sc\d+\s*\|/i.test(line))
    .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
  const errors: string[] = [];
  if (rows.length !== scenes.length || rows.some((row, i) => row[0].toLowerCase() !== `sc${scenes[i]?.scene}`)) errors.push("导演规划分场表未按原剧本完整连续列出 Sc 场次");
  for (const source of scenes) {
    const row = rows.find(row => row[0].toLowerCase() === `sc${source.scene}`);
    if (!row) continue;
    if (source.dialogue.length && (Number(row[2]) !== source.dialogue.length || Number(row[3]) !== source.dialogue.reduce((sum, line) => sum + spokenCharacterCount(line.text), 0))) {
      errors.push(`Sc${source.scene}台词统计与原文不一致`);
    }
    try { productionSceneBudget(plan, source.scene, source.text); } catch (error) { errors.push((error as Error).message); }
  }

  const transitionRows = plan.split(/\r?\n/).filter(line => /^\s*\|\s*Sc\s*\d+\s*(?:→|->)\s*Sc\s*\d+\s*\|/i.test(line))
    .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
  const expectedTransitions = Math.max(0, scenes.length - 1);
  if (transitionRows.length !== expectedTransitions) {
    errors.push(`导演规划必须完整列出全部${expectedTransitions}个相邻场间连续性契约`);
  }
  const allowedModes = new Set(["PRESERVE", "RESET"]);
  const allowedTypes = new Set(["CONTINUOUS_ACTION", "HARD_CUT", "MATCH_CUT", "TIME_JUMP", "FX_TRANSITION"]);
  for (let i = 0; i < expectedTransitions; i++) {
    const expected = `sc${scenes[i]?.scene}->sc${scenes[i + 1]?.scene}`;
    const row = transitionRows[i];
    if (!row) continue;
    const actual = String(row[0] || "").replace(/\s+/g, "").replace("→", "->").toLowerCase();
    if (actual !== expected) errors.push(`场间连续性契约顺序错误：应为 Sc${scenes[i]?.scene} → Sc${scenes[i + 1]?.scene}`);
    if (!allowedModes.has(String(row[1] || "").toUpperCase())) errors.push(`${row[0]} continuity_mode 必须为 PRESERVE 或 RESET`);
    if (!allowedTypes.has(String(row[2] || "").toUpperCase())) errors.push(`${row[0]} transition_type 无效`);
    if (!String(row[3] || "").trim()) errors.push(`${row[0]} 缺少具体承接要求`);
    if (!String(row[4] || "").trim()) errors.push(`${row[0]} 缺少可重置项说明`);
  }
  return errors;
}
