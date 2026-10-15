export interface StoryboardShotTiming {
  scene: number;
  segment: number | null;
  shot: number;
  line: number;
  from: number | null;
  to: number | null;
  duration: number | null;
  durationRaw: string;
}

export interface StoryboardSegmentTiming {
  scene: number;
  segment: number;
  title: string;
  from: number | null;
  to: number | null;
  duration: number | null;
}

export interface StoryboardSceneTiming {
  scene: number;
  title: string;
  from: 0;
  to: number | null;
  duration: number | null;
}

export interface StoryboardTimelineLedger {
  scenes: StoryboardSceneTiming[];
  segments: StoryboardSegmentTiming[];
  shots: StoryboardShotTiming[];
  errors: string[];
}

type Decimal = { units: bigint; scale: number };
const zero = (): Decimal => ({ units: 0n, scale: 0 });
function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale), scale };
}
function seconds(decimal: Decimal): number {
  const digits = decimal.units.toString().padStart(decimal.scale + 1, "0");
  return Number(decimal.scale ? `${digits.slice(0, -decimal.scale)}.${digits.slice(-decimal.scale)}` : digits);
}
function duration(raw: string): Decimal | null {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) <= 0) return null;
  const [whole, fraction = ""] = raw.split(".");
  return { units: BigInt((whole || "0") + fraction), scale: fraction.length };
}

/** Split Markdown cells while retaining literal escaped pipes inside a cell. */
function cells(line: string): string[] {
  const result: string[] = [];
  let value = "";
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "\\" && line[index + 1] === "|") { value += "|"; index++; }
    else if (line[index] === "|") { result.push(value.trim()); value = ""; }
    else value += line[index];
  }
  result.push(value.trim());
  return result.slice(1, -1);
}

/** Parse shot durations, not approximate segment headings or source-world timestamps.
 * An unknown duration makes every later absolute timestamp in that scene unknown.
 */
export function parseStoryboardTimeline(markdown: string): StoryboardTimelineLedger {
  const ledger: StoryboardTimelineLedger = { scenes: [], segments: [], shots: [], errors: [] };
  let currentScene: StoryboardSceneTiming | undefined;
  let currentSegment: StoryboardSegmentTiming | undefined;
  let cursor: Decimal | null = null;
  let segmentDuration: Decimal | null = null;
  let segmentIndex = 0;

  for (const [index, rawLine] of markdown.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (/^##\s*场/.test(line)) {
      const heading = line.match(/^##\s*场\s*(\d+)\s*[：:]/);
      currentSegment = undefined;
      segmentIndex = 0;
      segmentDuration = null;
      if (!heading || Number(heading[1]) < 1 || !Number.isSafeInteger(Number(heading[1]))) {
        ledger.errors.push(`第${index + 1}行场头不可解析，后续镜头不能获得准确场内时间`);
        currentScene = undefined;
        cursor = null;
        continue;
      }
      currentScene = { scene: Number(heading[1]), title: line, from: 0, to: 0, duration: 0 };
      ledger.scenes.push(currentScene);
      cursor = zero();
      continue;
    }
    if (/^###\s*片段/.test(line)) {
      if (!currentScene) { ledger.errors.push(`第${index + 1}行片段缺少有效场头`); continue; }
      segmentIndex++;
      currentSegment = { scene: currentScene.scene, segment: segmentIndex, title: line,
        from: cursor ? seconds(cursor) : null, to: cursor ? seconds(cursor) : null, duration: 0 };
      ledger.segments.push(currentSegment);
      segmentDuration = zero();
      continue;
    }
    const shot = line.match(/^\|\s*(\d+)\s*\|/);
    if (!shot) continue;
    if (!currentScene) { ledger.errors.push(`第${index + 1}行镜头缺少有效场头，不能确定时间`); continue; }
    const row = cells(line);
    const durationRaw = row[2] ?? "";
    const parsed = row.length === 7 ? duration(durationRaw) : null;
    const from = cursor ? seconds(cursor) : null;
    if (!currentSegment) ledger.errors.push(`场${currentScene.scene}镜${shot[1]}缺少片段标题`);
    if (!parsed) {
      ledger.errors.push(`场${currentScene.scene}片段${currentSegment?.segment ?? "未知"}镜${shot[1]}第${index + 1}行时长或7列结构无效；本镜结束及本场后续起止未知`);
      cursor = null;
      segmentDuration = null;
    } else {
      if (cursor) cursor = add(cursor, parsed);
      if (segmentDuration) segmentDuration = add(segmentDuration, parsed);
      if (cursor && !Number.isFinite(seconds(cursor))) {
        ledger.errors.push(`场${currentScene.scene}镜${shot[1]}累计时长超出可表示范围，后续起止未知`);
        cursor = null;
      }
    }
    const to = cursor ? seconds(cursor) : null;
    ledger.shots.push({ scene: currentScene.scene, segment: currentSegment?.segment ?? null,
      shot: Number(shot[1]), line: index + 1, from, to, duration: parsed ? seconds(parsed) : null, durationRaw });
    currentScene.to = to;
    currentScene.duration = to;
    if (currentSegment) {
      currentSegment.to = to;
      currentSegment.duration = segmentDuration ? seconds(segmentDuration) : null;
    }
  }
  return ledger;
}
