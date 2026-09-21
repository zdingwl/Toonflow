type MemoryContext = {
  rag: Array<{ content: string }>;
  summaries: Array<{ content: string }>;
  shortTerm: Array<{ role?: string | null; content: string }>;
};

/**
 * 保守估算 Token：中日韩字符按约 1 token，其他连续文本按约 4 字符/token，
 * 再为标点与结构留少量余量。这里用于预算保护，不替代具体模型 tokenizer。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const rest = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, "");
  const nonWhitespace = rest.replace(/\s+/g, " ");
  return Math.max(1, cjk + Math.ceil(nonWhitespace.length / 4) + Math.ceil(text.length / 80));
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const clipped = text.slice(0, lo).trimEnd();
  return clipped ? clipped + "…" : "";
}

/**
 * 历史记忆使用独立 Token 预算；当前用户消息、系统规则、任务状态和激活 Skill
 * 由调用方单独传入，不参与这里的裁剪。
 */
export function buildMemoryPrompt(memory: MemoryContext, maxTokens = 2400): string {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new Error("记忆上下文 Token 预算无效");
  if (maxTokens < 80) return "";

  const prefix = "## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n";
  const reserve = estimateTokens(prefix) + 24;
  const usable = Math.max(0, maxTokens - reserve);
  const seen = new Set<string>();

  const take = (items: string[], allowance: number, keepNewest = true) => {
    const selected: string[] = [];
    let remaining = allowance;
    const ordered = keepNewest ? [...items].reverse() : [...items];
    for (const raw of ordered) {
      const content = raw.trim();
      if (!content || seen.has(content) || remaining <= 0) continue;
      const cost = estimateTokens(content);
      if (cost <= remaining) {
        seen.add(content);
        selected.push(content);
        remaining -= cost;
        continue;
      }
      // 近期记忆优先保留一部分，避免单条较长消息导致整个近期窗口为空。
      if (keepNewest && remaining >= 24) {
        const clipped = truncateToTokens(content, remaining);
        if (clipped) {
          seen.add(content);
          selected.push(clipped);
          remaining -= estimateTokens(clipped);
        }
      }
    }
    return keepNewest ? selected.reverse() : selected;
  };

  const recentBudget = Math.floor(usable * 0.5);
  const summaryBudget = Math.floor(usable * 0.25);
  const recent = take(memory.shortTerm.map((m) => `${m.role ?? "message"}: ${m.content}`), recentBudget);
  const summaries = take(memory.summaries.map((m) => m.content), summaryBudget);
  const used = recent.reduce((sum, item) => sum + estimateTokens(item), 0)
    + summaries.reduce((sum, item) => sum + estimateTokens(item), 0);
  const related = take(memory.rag.map((m) => m.content), Math.max(0, usable - used));

  const sections = [
    related.length ? `[相关记忆]\n${related.join("\n")}` : "",
    summaries.length ? `[历史摘要]\n${summaries.join("\n")}` : "",
    recent.length ? `[近期对话]\n${recent.join("\n")}` : "",
  ].filter(Boolean);
  if (!sections.length) return "";

  const prompt = prefix + sections.join("\n\n");
  return estimateTokens(prompt) <= maxTokens ? prompt : truncateToTokens(prompt, maxTokens);
}
