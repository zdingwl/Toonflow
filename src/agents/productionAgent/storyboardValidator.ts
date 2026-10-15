import { extractDialogue, normalizeSpokenText, parseScriptScenes } from "./screenplay";
import type { StoryboardAssetParentMap } from "./storyboardContext";

export type SceneValidation = {
  valid: boolean;
  scene: number;
  errors: string[];
  warnings: string[];
  coverageVerified: boolean;
};

/** A row represents one continuous camera take; screen changes and row boundaries
 * are different from cutting to another camera inside that take. */
function containsInternalCameraCut(description: string): boolean {
  const text = description.replace(/【[^】]*】/g, "[屏幕文字]")
    .replace(/((?:显示|写着|文字为|字幕为)[：:]?\s*)[“「『][^”」』]*[”」』]/g, "$1[屏幕文字]");
  const cuts = [...text.matchAll(/硬切(?:回|到|入|至)?|跳切|插切|切镜|切入|切回|切到|再切|转切|切换|蒙太奇/g)];
  const negated = (prefix: string) => /(?:不|无需|无须|无|没有|不能|不得|避免|禁止|禁用)(?:再|会|应|要|做|用|进行|使用|采用|通过|任何|再次|额外|镜内|发生|的)*\s*$/.test(prefix);
  for (const cut of cuts) {
    const index = cut.index!, verb = cut[0];
    const prefix = text.slice(0, index);
    const before = prefix.split(/[，,。；;\n]/).at(-1)!.trim();
    const after = text.slice(index + verb.length);
    const destination = after.split(/[，,。；;\n]/)[0].trim();
    // Negation belongs to this operation, not to a later affirmative clause.
    if (negated(before)) continue;
    const screenSubject = /(?:页面|界面|文字|数字|数值|字幕|图标|屏幕内容|倒计时|UI)(?:中|内|上|的)?\s*$/.test(before) ||
      /(?:页面|界面|文字|数字|数值|字幕|图标|屏幕内容|倒计时|UI)[^，,。；;]{0,24}(?:从|由)[^，,。；;]*$/.test(before);
    const cameraDestination = /外部|主观|客观|视点|机位|角度|特写|全景|中景|近景|远景|镜头|眼部|手部|面部|正反打/.test(destination);
    const audioSubject = /(?:声音|音轨|声场|音效|声响|闷响|环境声|噪音|旁白|对白|画外音|配乐|背景音)\s*$/.test(before);
    if (audioSubject && !cameraDestination && /^(?:切入|切回|切到|切换)$/.test(verb)) continue;
    const orderedScreenChanges = /(?:页面|界面|文字|数字|字幕|图标|屏幕内容|系统叠层|信息叠层)[^。；;\n]{0,70}(?:依次|连续|逐项|逐个)\s*$/.test(prefix);
    const screenDestination = /^(?:到|至|为|成)?[^。；;，,]{0,45}(?:页面|界面|资料页|菜单|图标|屏幕文字|标题|数字)/.test(destination);
    const sameDeviceContent = /同一(?:台)?(?:手机|设备|平板|电脑|显示器|屏幕)[^。；;\n]{0,24}(?:设备|屏幕)?内(?:部)?\s*$/.test(before);
    if (!cameraDestination && ((verb === "切换" && (screenSubject || orderedScreenChanges || screenDestination)) ||
        (sameDeviceContent && screenDestination && /^(?:切入|切回|切到|切换)$/.test(verb)) ||
        (screenSubject && /^(?:到|至|为|成)?\s*(?:\[屏幕文字\]|\d|页面|界面|首页|列表|菜单|下一页|上一页)/.test(destination)))) continue;
    if (verb === "切入" && /即将$/.test(before) && !destination) continue;
    // Ending in black/white is a transition boundary, not a second photographed view.
    if (/^(?:到|至|为|成)?\s*(?:黑屏|白屏|黑场|白场|黑幕|白光|黑$)/.test(destination) &&
        !/随后|随即|接着|再(?:拍|显|切)|恢复(?:画面|拍摄)|重回|回到/.test(after)) continue;
    if (/^(?:末尾|结尾|最后)[^，,。；;]*(?:黑屏|白屏|黑场|白场|白光)$/.test(before) && !destination) continue;
    // A new row may begin by cutting in from the preceding row. It must not also
    // describe an earlier action/view in this same row or multiple connected cuts.
    const openingPrefix = prefix.trim().replace(/^\d+(?:\.\d+)?\s*[–—\-~～至]\s*\d+(?:\.\d+)?\s*(?:秒|s)\s*[，,：:。. ]?\s*/i, "");
    const opening = /^(?:独立\s*)?(?:(?:记忆(?:画面)?|回忆(?:画面)?|镜头|画面|本镜|首帧|开场|起始|开镜|场景开始|接前镜|承接前镜)(?:开始|开头|时|处|首先|先)?[：:]?\s*|从(?:黑屏|白屏|黑场|白场|前镜)\s*)?$/.test(openingPrefix);
    if (opening && /^(?:切入|切到|切回|转切|硬切(?:回|到|入|至))$/.test(verb)) continue;
    return true;
  }
  // Explicit alternation of different camera views also implies multiple takes.
  const alternations = [...text.matchAll(/(?:多(?:个)?机位|正反打|(?:主观|客观|外部|特写|近景|中景|全景|远景)[^，,。；;]{0,15}(?:与|和|、)[^，,。；;]{0,15}(?:主观|客观|外部|特写|近景|中景|全景|远景))[^，,。；;]{0,15}(?:交替|交叉剪辑)/g)];
  return alternations.some(match => !negated(text.slice(0, match.index).split(/[，,。；;\n]/).at(-1)!.trim()) &&
    !negated(match[0].replace(/(?:交替|交叉剪辑)$/, "")));
}

/** 严格校验结构与可辨识原文；无法定位原场次时不能宣称内容已全面覆盖。 */
export function validateStoryboardScene(scene: number, markdown: string, sourceScene?: string, options: { targetDuration?: number; assetIds?: number[]; assetParentMap?: StoryboardAssetParentMap } = {}): SceneValidation {
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
  const visualCells: string[] = [];
  const actualDialogue: {speaker:string; text:string}[] = [];
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
      visualCells.push(cells[1]);
      if (containsInternalCameraCut(cells[1]) || containsInternalCameraCut(cells[4])) {
        errors.push(`片段${i + 1}镜头${cells[0]}画面或运镜包含镜内切换，需另列镜头并分配时长`);
      }
      const spoken = [...cells[5].replace(/<br\s*\/?\s*>/gi, '\n').matchAll(/([^：:『「“；;\n]+?)[：:]\s*[『「“]([^』」”]+)[』」”]/g)].map(match => ({
        speaker: match[1].trim().replace(/[（(][^）)]*[）)]/g, '').replace(/说$/, ''), text: normalizeSpokenText(match[2]),
      }));
      actualDialogue.push(...spoken);
      if (!Number.isFinite(seconds) || seconds <= 0) errors.push(`片段${i + 1}存在无效时长`);
      else duration += seconds;
      if (Number.isFinite(seconds) && spoken.length && spoken.every(line => /\p{Script=Han}/u.test(line.text))) {
        const characters = spoken.reduce((n, line) => n + [...line.text].length, 0);
        const switches = spoken.slice(1).filter((line, j) => line.speaker !== spoken[j].speaker).length;
        // A local explicit fast delivery in the source can justify a faster passage.
        const sourceLines = (sourceScene ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const sourceFast = spoken.every(line => sourceLines.some((sourceLine, j) => normalizeSpokenText(sourceLine).includes(line.text) &&
          /急促|抢话|快速说|语速加快/.test(sourceLines.slice(Math.max(0,j-2),j).join(''))));
        if (!sourceFast && characters / 4 + switches * 0.5 > seconds + 0.05) errors.push(`片段${i + 1}镜头${cells[0]}台词负载${characters}字及说话人切换超过${seconds}秒，需重新分配`);
      }
    }
    if (duration > 15) errors.push(`片段${i + 1}时长${duration}秒，超过15秒`);
    sceneDuration += duration;
    const declared = segment.split("\n")[0].match(/[（(]约?\s*(\d+(?:\.\d+)?)\s*(?:s|秒)[）)]/i);
    if (declared && Math.abs(Number(declared[1]) - duration) > 0.05) errors.push(`片段${i + 1}标题时长与镜头合计${duration}秒不一致`);
    if (options.assetIds || options.assetParentMap) {
      const refs = [...segment.matchAll(/引用资产ID(?:（[^）]*）)?\*\*\s*[：:]\s*\[([^\]]*)\]/gi)];
      const ids = refs.flatMap(ref => ref[1].split(/[,，]/).map(id => Number(id.trim())));
      if (options.assetIds && (!ids.length || ids.some(id => !Number.isSafeInteger(id) || !options.assetIds!.includes(id)))) {
        errors.push(`片段${i + 1}引用资产缺失或不属于当前项目`);
      }
      const states = new Map<number, Set<number>>();
      for (const id of ids) {
        const parentId = options.assetParentMap?.[id];
        if (parentId === undefined) continue;
        if (!states.has(parentId)) states.set(parentId, new Set());
        states.get(parentId)!.add(id);
      }
      for (const [parentId, stateIds] of states) if (stateIds.size > 1) {
        errors.push(`片段${i + 1}引用同一角色父资产${parentId}的多套状态[${[...stateIds].join(",")}]，互斥状态须拆分片段并分别选择参考`);
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
    for (const line of actualDialogue) actualBySpeaker.set(line.speaker, (actualBySpeaker.get(line.speaker) ?? '') + line.text);
    const expectedBySpeaker = new Map<string, string>();
    for (const line of expectedDialogue) expectedBySpeaker.set(line.speaker, (expectedBySpeaker.get(line.speaker) ?? "") + normalizeSpokenText(line.text));
    for (const [speaker, spoken] of expectedBySpeaker) {
      if (actualBySpeaker.get(speaker) !== spoken) errors.push(`台词遗漏、改写、顺序或说话人不符：${speaker}`);
    }
    for (const speaker of actualBySpeaker.keys()) if (!expectedBySpeaker.has(speaker)) errors.push(`出现原场次没有的说话人：${speaker}`);
    const mergeAdjacent = (lines: {speaker:string; text:string}[]) => lines.reduce((merged: typeof lines, line) => {
      const previous = merged.at(-1);
      if (previous?.speaker === line.speaker) previous.text += normalizeSpokenText(line.text);
      else merged.push({speaker:line.speaker, text:normalizeSpokenText(line.text)});
      return merged;
    }, []);
    if (JSON.stringify(mergeAdjacent(actualDialogue)) !== JSON.stringify(mergeAdjacent(expectedDialogue))) errors.push('台词跨说话人的先后顺序与原文不符');
    coverageVerified = !errors.some(error => /台词|说话人/.test(error));
  } else if (sourceScene && expected.length) {
    const actual = normalizeSpokenText(dialogueCells.join(""));
    const missing = expected.filter(line => !actual.includes(normalizeSpokenText(line)));
    if (missing.length) errors.push(`疑似遗漏原剧本台词或VO：${missing.slice(0, 3).join("；")}`);
    else coverageVerified = true;
  } else {
    warnings.push("未识别可逐字核对的原场次台词；只完成结构校验，不能宣称剧情内容完全覆盖");
  }
  // Screen punctuation and units are content (71:58:41 is not 715841).
  const screenText = (s:string) => s.normalize('NFKC').replace(/\s/g,'');
  const screens = [...(sourceScene ?? "").matchAll(/【([^】]+)】/g)].map(match => screenText(match[1]));
  const shown = visualCells.flatMap(cell => [...cell.matchAll(/【([^】]+)】/g)].filter(match => {
    const prefix=cell.slice(0,match.index);
    const after=cell.slice((match.index??0)+match[0].length).split(/[。；;，,]/)[0];
    return !/(?:制作备注|备注)[：:][^。；]*$/.test(prefix) && !/(?:不(?:会|应)?显示|不得显示|不呈现|待补|另补)\s*$/.test(prefix) && !/后期另补/.test(after);
  }).map(match => screenText(match[1])));
  if (screens.some(screen => !shown.includes(screen))) {
    errors.push("遗漏或改写原剧本必须呈现的屏幕文字"); coverageVerified = false;
  }
  const firstAppearances = [...new Set(shown.filter(screen => screens.includes(screen)))];
  const expectedFirstAppearances = [...new Set(screens)];
  if (firstAppearances.length === expectedFirstAppearances.length && JSON.stringify(firstAppearances) !== JSON.stringify(expectedFirstAppearances)) {
    errors.push('必要屏幕文字首次出现顺序与原文不符'); coverageVerified=false;
  }
  let nextScreen=0;
  for(const screen of shown) if(screen===screens[nextScreen]) nextScreen++;
  if(nextScreen<screens.length && screens.every(screen=>shown.includes(screen))) {
    errors.push('必要屏幕事件重复呈现或先后顺序未完整覆盖原文'); coverageVerified=false;
  }
  if (coverageVerified) warnings.push("已核对可解析的台词和屏幕文字；人物动作、空间关系及参考图状态仍需审阅");
  return { valid: errors.length === 0, scene, errors, warnings, coverageVerified };
}

/** 无明确场次标题时返回 undefined，绝不猜测场次边界。 */
export function extractSourceScene(script: string, scene: number): string | undefined {
  return parseScriptScenes(script).find(item => item.scene === scene)?.text;
}
