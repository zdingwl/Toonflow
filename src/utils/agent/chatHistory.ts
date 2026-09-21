import type { Knex } from "knex";
import type { AIMessageContent, ChatMessageStatus } from "@/socket/chatMessagesData";

type ChatRole = "assistant" | "user" | "system";

export type PersistedChatMessage = {
  id: string;
  role: ChatRole;
  name?: string;
  status: ChatMessageStatus;
  datetime: string;
  content: AIMessageContent[];
  ext?: Record<string, unknown>;
  createTime: number;
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function deepMerge(target: any, source: any): any {
  if (typeof source !== "object" || source === null) return source;
  const result: Record<string, any> = {
    ...(typeof target === "object" && target !== null && !Array.isArray(target) ? target : {}),
  };
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    if (Array.isArray(sourceValue)) {
      result[key] = [...(Array.isArray(targetValue) ? targetValue : []), ...sourceValue];
    } else if (typeof sourceValue === "object" && sourceValue !== null) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }
  return result;
}

function applyContentUpdate(content: any, event: any) {
  if (event.status) content.status = event.status;
  if (event.data === undefined || event.data === null) return;

  if (event.strategy === "append") {
    if (typeof event.data === "string") {
      if (typeof content.data === "string") content.data += event.data;
      else if (content.data && typeof content.data === "object" && typeof content.data.text === "string") {
        content.data.text += event.data;
      } else {
        content.data = event.data;
      }
    } else if (typeof event.data === "object") {
      content.data = deepMerge(content.data, event.data);
    }
    return;
  }

  if (typeof content.data === "object" && content.data !== null && typeof event.data === "object" && event.data !== null) {
    content.data = { ...content.data, ...event.data };
  } else {
    content.data = event.data;
  }
}

export class AgentChatHistoryStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Knex,
    private readonly isolationKey: string,
  ) {}

  private enqueue(messageId: string, operation: () => Promise<void>) {
    const previous = this.queues.get(messageId) ?? Promise.resolve();
    const next = previous
      .then(operation)
      .catch((error) => console.error("[AgentChatHistory] 持久化失败:", messageId, error instanceof Error ? error.message : error));
    this.queues.set(messageId, next);
    void next.finally(() => {
      if (this.queues.get(messageId) === next) this.queues.delete(messageId);
    });
  }

  recordMessage(message: {
    id: string;
    role: ChatRole;
    name?: string;
    status?: ChatMessageStatus;
    datetime?: string;
    content?: AIMessageContent[];
    ext?: Record<string, unknown>;
  }) {
    const createTime = Number.isFinite(Date.parse(message.datetime ?? ""))
      ? Date.parse(message.datetime!)
      : Date.now();
    this.enqueue(message.id, async () => {
      await this.db("o_agentChatMessage")
        .insert({
          id: message.id,
          isolationKey: this.isolationKey,
          role: message.role,
          name: message.name ?? null,
          status: message.status ?? "pending",
          datetime: message.datetime ?? new Date(createTime).toISOString(),
          contentJson: JSON.stringify(message.content ?? []),
          extJson: message.ext ? JSON.stringify(message.ext) : null,
          createTime,
          updateTime: Date.now(),
        })
        .onConflict("id")
        .merge({
          isolationKey: this.isolationKey,
          role: message.role,
          name: message.name ?? null,
          status: message.status ?? "pending",
          datetime: message.datetime ?? new Date(createTime).toISOString(),
          contentJson: JSON.stringify(message.content ?? []),
          extJson: message.ext ? JSON.stringify(message.ext) : null,
          updateTime: Date.now(),
        });
    });
  }

  recordMessageUpdate(messageId: string, update: { status?: ChatMessageStatus; ext?: Record<string, unknown> }) {
    this.enqueue(messageId, async () => {
      const row = await this.db("o_agentChatMessage").where({ id: messageId, isolationKey: this.isolationKey }).first();
      if (!row) return;
      const patch: Record<string, unknown> = { updateTime: Date.now() };
      if (update.status) patch.status = update.status;
      if (update.ext) patch.extJson = JSON.stringify({ ...parseJson(row.extJson, {}), ...update.ext });
      await this.db("o_agentChatMessage").where({ id: messageId, isolationKey: this.isolationKey }).update(patch);
    });
  }

  recordContentAdd(messageId: string, content: AIMessageContent) {
    this.enqueue(messageId, async () => {
      const row = await this.db("o_agentChatMessage").where({ id: messageId, isolationKey: this.isolationKey }).first();
      if (!row) return;
      const items = parseJson<any[]>(row.contentJson, []);
      const id = (content as any).id;
      if (!id || !items.some((item) => item?.id === id)) items.push(content);
      await this.db("o_agentChatMessage").where({ id: messageId, isolationKey: this.isolationKey }).update({
        contentJson: JSON.stringify(items),
        updateTime: Date.now(),
      });
    });
  }

  recordContentUpdate(event: {
    messageId: string;
    contentId: string;
    type?: string;
    data?: unknown;
    strategy?: "merge" | "append";
    status?: ChatMessageStatus;
  }) {
    this.enqueue(event.messageId, async () => {
      const row = await this.db("o_agentChatMessage").where({ id: event.messageId, isolationKey: this.isolationKey }).first();
      if (!row) return;
      const items = parseJson<any[]>(row.contentJson, []);
      let content = items.find((item) => item?.id === event.contentId);
      if (!content) {
        content = {
          id: event.contentId,
          type: event.type ?? "text",
          data: event.type === "thinking" ? {} : "",
          status: event.status ?? "pending",
        };
        items.push(content);
      }
      applyContentUpdate(content, event);
      await this.db("o_agentChatMessage").where({ id: event.messageId, isolationKey: this.isolationKey }).update({
        contentJson: JSON.stringify(items),
        updateTime: Date.now(),
      });
    });
  }

  async flush() {
    await Promise.all([...this.queues.values()]);
  }

  async list(): Promise<PersistedChatMessage[]> {
    const rows = await this.db("o_agentChatMessage")
      .where({ isolationKey: this.isolationKey })
      .orderBy("createTime", "asc")
      .select("id", "role", "name", "status", "datetime", "contentJson", "extJson", "createTime");

    return rows.map((row: any) => ({
      id: row.id,
      role: row.role,
      name: row.name ?? undefined,
      status: row.status ?? "complete",
      datetime: row.datetime ?? new Date(row.createTime).toISOString(),
      content: parseJson<AIMessageContent[]>(row.contentJson, []),
      ext: parseJson<Record<string, unknown> | undefined>(row.extJson, undefined),
      createTime: Number(row.createTime) || Date.now(),
    }));
  }
}

export default AgentChatHistoryStore;
