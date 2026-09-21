import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

function normalizeAiRegex(text: string, sample: string): string {
  const cleaned = text.trim()
    .replace(/^```(?:regex|javascript|js)?\s*\r?\n/i, "")
    .replace(/\r?\n```\s*$/, "")
    .trim();
  if (!cleaned) throw new Error("模型未识别到集数标题，请手动输入拆集正则");
  const literal = /^\/([\s\S]*)\/([a-z]*)$/i.exec(cleaned);
  const pattern = literal ? literal[1] : cleaned;
  const flags = literal ? literal[2] : "g";
  if (pattern.length > 512 || !/^[gimu]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error("AI返回的正则过长或包含不支持的标志");
  }
  // 只接受从独立集标题行开始的表达式；非行首匹配会把正文中的“第X集”误拆成新集。
  if (!pattern.startsWith("^")) {
    throw new Error("AI返回的正则未限定集标题行首，请重试或手动输入");
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, [...new Set(`${flags}gm`)].join(""));
  } catch {
    throw new Error("AI返回的正则语法不合法，请重试或手动输入");
  }
  let found = false;
  for (const match of sample.matchAll(regex)) {
    if (!match[0] || match[0].includes("\n") ||
      !/^[0-9０-９零〇一二三四五六七八九十百千万两]+$/.test(match[1]?.trim() ?? "") ||
      match[2] === undefined) {
      throw new Error("AI返回的正则无法正确提取独立集标题行，请重试或手动输入");
    }
    found = true;
  }
  if (!found) throw new Error("AI返回的正则未匹配到样本中的集标题，请检查剧本格式");
  return `/${pattern}/${regex.flags}`;
}

export default router.post(
  "/",
  validateFields({
    content: z.string().min(1).max(6000),
  }),
  async (req, res) => {
    const { content } = req.body as { content: string };
    // 匹配数量无法证明拆集正确：即使默认规则已匹配多集，用户点击 AI 解析时也必须真正分析格式。
    const systemPrompt = String.raw`你是一个正则表达式专家。用户提供的文本包含剧本片名、说明、正文及可能的集标题。请识别真正的每集标题行的格式，只返回 JavaScript 正则表达式。
要求：
1. 第一个捕获组只匹配集数（阿拉伯数字或中文数字）；第二个捕获组匹配该集标题，标题可为空。
2. 必须用 ^ 锚定标题行首，以 m 标志逐行匹配；行首允许用 [ \t]* 匹配空格，但不能用 \s* 跨行吞掉正文。只匹配真正的集标题，不得把片名候选、正文、对白或场次编号当作集标题。
3. 只匹配单行的集标题，不得跨行吞掉正文。返回格式如：/^[ \t]*第[ \t]*([0-9一二三四五六七八九十百千万]+)[ \t]*集[ \t]*([^\n\r]*)/gm。若剧本使用其他格式，请根据原文调整，不能套用示例。
4. 只返回正则表达式本身，不要说明、引号或 Markdown；如果样本中没有明显的分集标题，返回空字符串。`;

    try {
      const resText = await u.Ai.Text("universalAi").invoke({
        system: systemPrompt,
        messages: [{ role: "user", content }],
      });
      return res.status(200).send(success(normalizeAiRegex(resText.text || "", content)));
    } catch (reason) {
      console.error("[script/getAiRegex]", reason);
      const details = reason instanceof Error ? reason.message : "";
      const message = /未找到.*(?:配置|模型)|模型配置/.test(details)
        ? "未配置通用AI文本模型，请先在模型设置中完成配置；也可以手动填写拆集正则"
        : /AI返回|模型未识别/.test(details)
          ? details
          : "AI解析正则失败，请检查通用AI模型、网络连接或稍后重试；请勿在拆集结果不正确时保存";
      return res.status(400).send(error(message));
    }
  },
);
