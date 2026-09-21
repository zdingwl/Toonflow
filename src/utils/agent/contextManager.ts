type MemoryContext = {
  rag: Array<{ content: string }>;
  summaries: Array<{ content: string }>;
  shortTerm: Array<{ role?: string | null; content: string }>;
};

/** 历史记忆有独立预算；当前用户消息、系统规则与执行状态始终由调用方单独传入。 */
export function buildMemoryPrompt(memory: MemoryContext, maxChars = 8000): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new Error("记忆上下文预算无效");
  if (maxChars < 120) return "";
  const usable = maxChars - 120;
  const seen = new Set<string>();
  const take = (items: string[], allowance: number) => {
    const selected: string[] = [];
    let used = 0;
    for (const raw of items.reverse()) {
      const content = raw.trim();
      if (!content || seen.has(content) || used + content.length > allowance) continue;
      seen.add(content);
      selected.push(content);
      used += content.length;
    }
    return selected.reverse();
  };
  const recent = take(memory.shortTerm.map((m) => `${m.role ?? "message"}: ${m.content}`), Math.floor(usable * 0.5));
  const summaries = take(memory.summaries.map((m) => m.content), Math.floor(usable * 0.25));
  const related = take(memory.rag.map((m) => m.content), Math.max(0, usable - recent.join("\n").length - summaries.join("\n").length));
  const sections = [
    related.length ? `[相关记忆]\n${related.join("\n")}` : "",
    summaries.length ? `[历史摘要]\n${summaries.join("\n")}` : "",
    recent.length ? `[近期对话]\n${recent.join("\n")}` : "",
  ].filter(Boolean);
  return sections.length ? `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${sections.join("\n\n")}` : "";
}
