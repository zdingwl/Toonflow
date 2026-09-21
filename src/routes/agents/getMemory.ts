import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { AgentChatHistoryStore, type PersistedChatMessage } from "@/utils/agent/chatHistory";
const router = express.Router();

function normalizeRole(role?: string | null): "user" | "assistant" {
  return role?.startsWith("assistant") ? "assistant" : "user";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (match) => "\\" + match);
}

function stripHiddenXml(text: string, tags: string[]) {
  let result = text;
  for (const tag of tags) {
    const escaped = escapeRegExp(tag);
    result = result.replace(new RegExp("<" + escaped + "(?:\\s[^>]*)?>[\\s\\S]*?<\\/" + escaped + ">", "g"), "");
    result = result.replace(new RegExp("<" + escaped + "(?:\\s[^>]*)?>[\\s\\S]*$", "g"), "");
  }
  return result;
}

function sanitizeContent(content: any, hiddenTags: string[]): any | null {
  if (!content || typeof content !== "object") return null;
  if ((content.type === "text" || content.type === "markdown") && typeof content.data === "string") {
    const data = stripHiddenXml(content.data, hiddenTags).trim();
    return data ? { ...content, data } : null;
  }
  if (content.type === "reasoning" && Array.isArray(content.data)) {
    const data = content.data.map((item: any) => sanitizeContent(item, hiddenTags)).filter(Boolean);
    return data.length ? { ...content, data } : null;
  }
  return content;
}

function sanitizeStructuredMessage(message: PersistedChatMessage, agentType: "scriptAgent" | "productionAgent") {
  const hiddenTags = agentType === "productionAgent"
    ? ["script", "scriptPlan", "storyboardTable", "storyboardItem"]
    : ["storySkeleton", "adaptationStrategy", "scriptItem"];
  const content = (message.content ?? []).map((item) => sanitizeContent(item, hiddenTags)).filter(Boolean);
  if (!content.length) return null;
  return {
    id: message.id,
    role: message.role,
    name: message.name,
    status: message.status === "pending" || message.status === "streaming" ? "stop" : message.status,
    datetime: message.datetime,
    content,
    ext: message.ext,
    createTime: message.createTime,
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent"]),
    episodesId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId } = req.body;
    const isolationKey = projectId + ":" + agentType + (episodesId !== undefined ? ":" + episodesId : "");

    const rows = await u
      .db("memories")
      .where({ isolationKey, type: "message" })
      .orderBy("createTime", "asc")
      .select("id", "role", "name", "content", "createTime");

    let structured: Array<ReturnType<typeof sanitizeStructuredMessage>> = [];
    if (await u.db.schema.hasTable("o_agentChatMessage")) {
      const historyStore = new AgentChatHistoryStore(u.db, isolationKey);
      structured = (await historyStore.list())
        .map((message) => sanitizeStructuredMessage(message, agentType))
        .filter((message): message is NonNullable<typeof message> => Boolean(message));
    }

    if (structured.length) {
      const firstStructuredTime = Math.min(...structured.map((item) => Number(item!.createTime)));
      const legacy = rows
        .filter((row) => Number(row.createTime) < firstStructuredTime)
        .filter((row) => typeof row.content === "string" && row.content.trim().length > 0)
        .map((row) => ({
          id: row.id,
          role: normalizeRole(row.role),
          name: row.name ?? undefined,
          status: "complete",
          datetime: new Date(row.createTime).toISOString(),
          content: [{ type: "markdown", status: "complete", data: row.content }],
          createTime: row.createTime,
        }));
      const history = [...legacy, ...structured].sort((a, b) => Number(a!.createTime) - Number(b!.createTime));
      return res.status(200).send(success(history));
    }

    const history = rows
      .filter((row) => typeof row.content === "string" && row.content.trim().length > 0)
      .map((row) => ({
        id: row.id,
        role: normalizeRole(row.role),
        name: row.name ?? undefined,
        status: "complete",
        datetime: new Date(row.createTime).toISOString(),
        content: [{ type: "markdown", status: "complete", data: row.content }],
        createTime: row.createTime,
      }));

    res.status(200).send(success(history));
  },
);
