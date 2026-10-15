import { normalizeSpokenText, parseScriptScenes, spokenCharacterCount } from "./screenplay";

const cells = (row: string) => row.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
const fastDeliveryInSource = (source: string) => /(?:语速|说话|念|读)[^\n。]{0,12}(?:飞快|快速|急促)|(?:飞快|急促)[^\n。]{0,12}(?:说|念|读)|快板|饶舌|抢话/.test(source);
const occurrences = (text: string, quote: string) => text.split(quote).length - 1;

/** Planning checks only: exact source lines, readable tables, and conservative clear-speech estimates.
 * Legacy summary plans and explicitly fast source performances retain their existing contract.
 * These checks do not certify a recording, acting performance, or finished film.
 */
export function validateDirectorExecution(script: string, plan: string): string[] {
  if (!/^###\s+逐场导演设计\s*$/m.test(plan)) return [];
  const sections = [...plan.matchAll(/^####\s+Sc(\d+)[：:][^\r\n]*/gm)];
  const errors: string[] = [];
  for (const source of parseScriptScenes(script)) {
    const indexes = sections.flatMap((section, index) => Number(section[1]) === source.scene ? [index] : []);
    if (indexes.length !== 1) { errors.push(`Sc${source.scene}必须只有一个最终逐场设计`); continue; }
    const index = indexes[0];
    const section = plan.slice(sections[index].index!, sections[index + 1]?.index ?? plan.length);
    const rows = section.split(/\r?\n/).filter(row => /^\s*\|/.test(row));
    const headers = rows.filter(row => /^\s*\|\s*节拍\s*\|/.test(row));
    if (headers.length !== 1) errors.push(`Sc${source.scene}只能输出一张最终节拍表，不能保留草稿或修正版`);
    const header = headers[0];
    if (header) {
      const position = rows.indexOf(header);
      const divider = rows[position + 1];
      if (cells(header).length !== 6 || !/注意力|节奏|意图/.test(cells(header)[5] ?? "")) {
        errors.push(`Sc${source.scene}节拍表表头必须六列并含注意力与节奏理由`);
      }
      if (!divider || cells(divider).length !== 6 || cells(divider).some(cell => !/^:?-{3,}:?$/.test(cell))) {
        errors.push(`Sc${source.scene}节拍表缺少六列Markdown分隔行`);
      }
    }
    const beatRows = rows.filter(row => /^\s*\|\s*B\d+\s*\|/.test(row)).map(cells);
    if (/双手[^。；\n]{0,40}(?:抓|扣|握)/.test(source.text) && /最后一根手指/.test(source.text)) {
      const execution = beatRows.map(beat => beat[4] ?? "").join("\n");
      const remainingHand = [...execution.matchAll(/[^。；\n]*(?:另一只|第二只|剩余|余下)[^。；\n]*手[^。；\n]*/g)];
      const complete = remainingHand.some(match => /掰|扳|剥|松|解除/.test(match[0]) && /(?:只余|仅余|只剩|剩下|最后一根)/.test(match[0]));
      if (!complete) errors.push(`Sc${source.scene}双手抓握到最后一根缺少第二只手的中间解除：执行栏必须交代剩余手如何逐根松脱到仅余最后一根，不能由审核者补想`);
    }
    const seen = new Set<string>();
    let sourceOffset = 0;
    const dialogue = source.dialogue.map(line => {
      const at = source.text.indexOf(line.text, sourceOffset);
      const preceding = at < 0 ? "" : source.text.slice(0, at).split(/\r?\n/).map(text => text.trim()).filter(Boolean).slice(-2).join("\n");
      sourceOffset = at < 0 ? sourceOffset : at + line.text.length;
      return { ...line, fast: fastDeliveryInSource(preceding) };
    });
    const assigned = new Map<string, number>();
    for (const beat of beatRows) {
      const label = `Sc${source.scene} ${beat[0]}`;
      if (seen.has(beat[0])) errors.push(`${label}重复，只能保留最终节拍`);
      seen.add(beat[0]);
      if (beat.length !== 6) { errors.push(`${label}必须与表头同为六列`); continue; }
      const range = beat[1].match(/^(\d+(?:\.\d+)?)\s*[–—\-~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?$/i);
      if (!range) continue; // Continuous ranges are checked by validateDirectorFacts.
      const allocated = Number(range[2]) - Number(range[1]);
      if (allocated <= 0) continue;
      const body = beat.slice(2).join("\n");
      const screen = source.screenText.filter(text => /^\d+$/.test(text)
        ? body.includes(`【${text}】`) : body.includes(text));
      const screenCount = beat[5].match(/有效字符为([\d、，,\s]+)[，,]共(\d+)/);
      const uniformScreenCount = beat[5].match(/有效字符均为(\d+)[，,]共(\d+)/);
      if (screen.length && (screenCount || uniformScreenCount)) {
        const actual = screen.map(spokenCharacterCount);
        const claimed = screenCount ? screenCount[1].split(/[、，,\s]+/).filter(Boolean).map(Number)
          : actual.map(() => Number(uniformScreenCount![1]));
        if (claimed.length === screen.length && (claimed.some((count, i) => count !== actual[i]) || Number((screenCount ?? uniformScreenCount)![2]) !== actual.reduce((sum, count) => sum + count, 0))) {
          errors.push(`${label}屏幕有效字符应按原文和程序口径为${actual.join("、")}，共${actual.reduce((sum, count) => sum + count, 0)}；不能让上次候选或审稿中的算术错误覆盖程序事实，保留全部原屏幕文字并修正统计`);
        }
      }
      const groups = new Map<string, typeof dialogue>();
      for (const line of dialogue.filter(line => body.includes(line.text))) {
        const key = `${line.speaker}\0${line.text}`;
        groups.set(key, [...(groups.get(key) ?? []), line]);
      }
      const matched = [...groups].flatMap(([key, lines]) => {
        const used = assigned.get(key) ?? 0;
        // An anchor and its execution quote describe one utterance; two source turns
        // quoted twice in one execution cell still require both utterances' time.
        const count = Math.min(lines.length - used, Math.max(...beat.slice(2).map(cell => occurrences(cell, lines[0].text))));
        assigned.set(key, used + count);
        return lines.slice(used, used + count);
      });
      const ordinaryChinese = matched.filter(line => !line.fast && /^(?=.*\p{Script=Han})[\p{Script=Han}\p{N}]+$/u.test(normalizeSpokenText(line.text)));
      if (ordinaryChinese.length) {
        const characters = ordinaryChinese.reduce((sum, line) => sum + spokenCharacterCount(line.text), 0);
        const callSwitches = matched.length > 1 && /下一通|再拨|挂断|换通|三通|第二通|第一通/.test(body) ? (matched.length - 1) * 0.5 : 0;
        const estimate = characters / 4 + callSwitches;
        if (estimate > allocated + 0.05) {
          errors.push(`${label}含${ordinaryChinese.length}句顺序原台词共${characters}字，按清晰口播4字/秒及必要换通纸面估计至少${Math.ceil(estimate * 10) / 10}秒，实际仅${allocated}秒；请重分配低信息节拍，不用无依据快语速或合拍复用时间`);
        }
      }
      for (const claimed of beat[5].matchAll(/(\d+(?:\.\d+)?)\s*秒(?:承载|完成|分配)/g)) {
        if (Number(claimed[1]) > allocated + 0.05) errors.push(`${label}说明称${claimed[1]}秒，但实际区间仅${allocated}秒，请统一最终表和耗时核算`);
      }
      for (const stages of beat[5].matchAll(/台词[^；。\n]{0,24}?(?:约|需|合计)(\d+(?:\.\d+)?)(?:\s*[–—\-~～]\s*\d+(?:\.\d+)?)?\s*秒[，,；;]\s*(?:最后|另留|再留)(\d+(?:\.\d+)?)\s*秒(?:留给|用于|用来)/g)) {
        const speech = Number(stages[1]), ending = Number(stages[2]);
        if (speech + ending > allocated + 0.05) {
          errors.push(`${label}自己估计台词至少${speech}秒，再为末尾动作保留${ending}秒，合计至少${Math.ceil((speech + ending) * 10) / 10}秒却仅分配${allocated}秒；请重排预算或明确兼容动作的实际并行区间，最终脱离等结果仍须发生在原文原因之后`);
        }
      }
    }
  }
  const confirmation = plan.split(/^###\s+需确认问题\s*$/m)[1] ?? "";
  if (/(?:采用|通过|已选择|仅在)[\s\S]*(?:若|如果)[^。\n]{0,80}(?:要求|主创)[\s\S]*(?:需上游|需要上游|需[^。\n]{0,20}确认)/.test(confirmation)) {
    errors.push("需确认问题混入已采用方案的假设替代要求；兼容原文的声音/时间省略/全局约束直接执行，只列当前真实来源缺口或实际预算冲突");
  }
  return [...new Set(errors)];
}
