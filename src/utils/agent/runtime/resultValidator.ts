/** 拒绝截断、重复或嵌套的顶层 XML 结果，避免把半份产物提交到工作区。 */
export function extractSingleXmlResult(response: string, tag: string): string {
  if (!/^[A-Za-z][\w-]*$/.test(tag)) throw new Error("结果标签无效");
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openings = [...response.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>`, "g"))];
  const closings = [...response.matchAll(new RegExp(`</${escaped}\\s*>`, "g"))];
  if (openings.length !== 1 || closings.length !== 1) throw new Error(`输出不完整：需要且只能有一份非空的 ${tag}`);
  const open = openings[0], close = closings[0];
  if (open.index === undefined || close.index === undefined || close.index < open.index + open[0].length) {
    throw new Error(`输出不完整：${tag} 标签顺序错误`);
  }
  const content = response.slice(open.index + open[0].length, close.index).trim();
  if (!content) throw new Error(`输出不完整：需要且只能有一份非空的 ${tag}`);
  return content;
}
