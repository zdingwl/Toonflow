import { tool, jsonSchema, Tool } from "ai";
import u from "@/utils";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";

export const ScriptSchema = z.object({
  name: z.string().describe("剧本名称"),
  content: z.string().describe("剧本内容"),
});
export const planData = z.object({
  storySkeleton: z.string().describe("故事骨架"),
  adaptationStrategy: z.string().describe("改编策略"),
  script: z.string().describe("剧本内容"),
});

export type planData = z.infer<typeof planData>;

const keySchema = z.enum(Object.keys(planData.shape) as [keyof planData, ...Array<keyof planData>]);
const planDataKeyLabels = Object.fromEntries(
  Object.entries(planData.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof planData, string>;

// 未传 offset/limit 时原样返回字符串，保持既有 Agent 调用的返回类型不变。
function optionalTextChunk(text: string, offset?: number, limit?: number) {
  if (offset === undefined && limit === undefined) return text;
  const start = Math.min(offset ?? 0, text.length);
  const end = Math.min(start + (limit ?? 6000), text.length);
  return {
    data: text.slice(start, end),
    offset: start,
    total: text.length,
    nextOffset: end < text.length ? end : null,
  };
}

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const tools: Record<string, Tool> = {
    get_novel_events: tool({
      description: "获取章节事件；当请求的章节编号不存在时，结果会明确列出缺失章节，校验原著范围时不得忽略。",
      inputSchema: jsonSchema<{ chapterIndexs: number[] }>(
        z
          .object({
            chapterIndexs: z.array(z.number()).describe("章节的编号"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ chapterIndexs }) => {
        console.log("[tools] get_novel_events", chapterIndexs);
        const thinking = msg.thinking("正在查询章节事件...");
        // 事件查询只需要章节编号、标题和事件；不读取整章 chapterData 原文。
        const data = chapterIndexs.length
          ? await u
              .db("o_novel")
              .where("projectId", resTool.data.projectId)
              .select("chapterIndex as index", "chapter", "event")
              .whereIn("chapterIndex", chapterIndexs)
          : [];
        thinking.appendText("正在查询章节编号: " + chapterIndexs.join(","));
        const eventString = data.map((i: any) => `第${i.index}章，标题:${i.chapter}，事件:${i.event}`).join("\n");
        const found = new Set(data.map((i: any) => String(i.index)));
        const missing = [...new Set(chapterIndexs)].filter((index) => !found.has(String(index)));
        const result = [
          eventString,
          missing.length ? `未找到章节编号：${missing.join(",")}。章节范围校验未通过，不得将缺失章节视为已读取。` : "",
          chapterIndexs.length === 0 ? "未指定章节编号，请提供需要查询的章节编号。" : "",
        ]
          .filter(Boolean)
          .join("\n");
        thinking.appendText("查询结果:\n" + result);
        thinking.updateTitle("查询章节事件完成");
        thinking.complete();
        return result || "无数据";
      },
    }),
    get_planData: tool({
      description: "获取工作区数据",
      inputSchema: jsonSchema<{ key: keyof planData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        console.log("[tools] get_planData", key);
        const thinking = msg.thinking(`正在获取${planDataKeyLabels[key]}工作区数据...`);
        const planData: planData = await new Promise((resolve) => socket.emit("getPlanData", { key }, (res: any) => resolve(res)));
        thinking.appendText(`获取到${planDataKeyLabels[key]}:\n` + planData[key]);
        thinking.updateTitle(`获取${planDataKeyLabels[key]}完成`);
        thinking.complete();
        return planData[key] ?? "无数据";
      },
    }),
    get_novel_text: tool({
      description: "获取指定小说章节原文；默认返回完整原始字符串。长章节可选 offset/limit 按字符分段，返回 data、total、nextOffset；按 nextOffset 续读直至 null。",
      inputSchema: jsonSchema<{ chapterIndex: string; offset?: number; limit?: number }>(
        z
          .object({
            chapterIndex: z.string().describe("章节编号"),
            offset: z.number().int().min(0).optional().describe("可选字符起点，从0开始；不传 offset/limit 时返回完整原文"),
            limit: z.number().int().min(1).max(12000).optional().describe("可选分段长度，默认6000字符；不传 offset/limit 时返回完整原文"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ chapterIndex, offset, limit }) => {
        console.log("[tools] get_novel_text", chapterIndex);
        const thinking = msg.thinking(`正在获取小说章节原文...`);
        const data = await u.db("o_novel").where("projectId", resTool.data.projectId).where({ chapterIndex }).select("chapterData").first();
        const text = data && data?.chapterData ? data.chapterData : "";
        const result = optionalTextChunk(text, offset, limit);
        thinking.appendText(`获取到原文:\n` + (typeof result === "string" ? result : JSON.stringify(result)));
        thinking.updateTitle(`获取小说章节原文完成`);
        thinking.complete();
        return result;
      },
    }),
    get_script_content: tool({
      description: "获取当前项目的剧本内容；默认返回原有完整 scriptItem 字符串。可选 offset/limit 按字符分段，返回 data、total、nextOffset；分段 data 可能包含不完整的 XML 标签，须按 nextOffset 续读后再合并。",
      inputSchema: jsonSchema<{ ids: string[]; offset?: number; limit?: number }>(
        z
          .object({
            ids: z.array(z.string()).describe("脚本id"),
            offset: z.number().int().min(0).optional().describe("可选字符起点，从0开始；不传 offset/limit 时返回完整剧本"),
            limit: z.number().int().min(1).max(12000).optional().describe("可选分段长度，默认6000字符；不传 offset/limit 时返回完整剧本"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids, offset, limit }) => {
        console.log("[tools] get_script_content", ids);
        const thinking = msg.thinking(`正在获取脚本内容...`);
        const data = await u.db("o_script").where("projectId", resTool.data.projectId).whereIn("id", ids).select("content", "name");
        const text = data && data.length ? data.map((d) => `<scriptItem name="${d.name}">${d.content}</scriptItem>`).join("\n") : "";
        const result = optionalTextChunk(text, offset, limit);
        thinking.appendText(`获取到脚本内容:\n` + (typeof result === "string" ? JSON.stringify(data, null, 2) : JSON.stringify(result)));
        thinking.updateTitle(`获取脚本内容完成`);
        thinking.complete();
        return result;
      },
    }),
  };
  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
