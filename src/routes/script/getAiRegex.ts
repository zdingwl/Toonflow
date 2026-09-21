import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

// 已能按原有规则拆集的剧本不需要额外请求模型；返回与客户端默认拆集器一致的表达式。
const DEFAULT_EPISODE_REGEX = String.raw`/第\s*([0-9０-９零一二三四五六七八九十百千万]+)\s*集\s*([^\n\r]*)/g`;
const DEFAULT_HEADING_REGEX = /^[ \t]*第[ \t]*[0-9０-９零一二三四五六七八九十百千万]+[ \t]*集[^\r\n]*$/gm;

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
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch {
    throw new Error("AI返回的正则语法不合法，请重试或手动输入");
  }
  const match = regex.exec(sample);
  if (!match || !/^[0-9０-９零一二三四五六七八九十百千万]+$/.test(match[1]?.trim() ?? "") || match[2] === undefined) {
    throw new Error("AI返回的正则无法从样本中提取集数和标题，请重试或手动输入");
  }
  return `/${pattern}/${regex.flags}`;
}

export default router.post(
  "/",
  validateFields({
    content: z.string().min(1).max(6000),
  }),
  async (req, res) => {
    const { content } = req.body as { content: string };
    // 用户已使用默认规则成功拆集时，AI调用失败不应阻断已有的拆集功能。
    DEFAULT_HEADING_REGEX.lastIndex = 0;
    const standardHeadings = content.match(DEFAULT_HEADING_REGEX);
    if (standardHeadings && standardHeadings.length >= 2) {
      return res.status(200).send(success(DEFAULT_EPISODE_REGEX));
    }

    // String.raw 保留提示词示例中的 \s、\n、\r，避免 JS 模板字符串吞掉反斜杠。
    const systemPrompt = String.raw`你是一个正则表达式专家。用户提供剧本文本，请识别每集标题行的分隔模式，只返回 JavaScript 正则表达式。
要求：
1. 第一个捕获组匹配集数（阿拉伯数字或中文数字）；第二个捕获组匹配该集标题，标题可为空。
2. 尽量只匹配独立的集标题行，不得把正文或对白误判为集标题。
3. 返回格式为 /正则表达式/g，例如：/第\s*([0-9一二三四五六七八九十百千万]+)\s*集\s*([^\n\r]*)/g。
4. 只返回正则表达式本身，不要说明、引号或 Markdown；如果没有明显的分集标题，返回空字符串。`;

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
          : "AI解析正则失败，请检查通用AI模型、网络连接或稍后重试；已解析的剧集仍可继续使用";
      return res.status(400).send(error(message));
    }
  },
);
