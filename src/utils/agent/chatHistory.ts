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
  private readonly snapshots = new Map<string, PersistedChatMessage>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs = 200;

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

  private persistNow(messageId: string) {
    const timer = this.timers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(messageId);
    }
    const message = this.snapshots.get(messageId);
    if (!message) return;
    const row = {
      id: message.id,
      isolationKey: this.isolationKey,
      role: message.role,
      name: message.name ?? null,
      status: message.status,
      datetime: message.datetime,
      contentJson: JSON.stringify(message.content ?? []),
      extJson: message.ext ? JSON.stringify(message.ext) : null,
      createTime: message.createTime,
      updateTime: Date.now(),
    };
    this.enqueue(messageId, async () => {
      await this.db("o_agentChatMessage")
        .insert(row)
        .onConflict("id")
        .merge({
          isolationKey: row.isolationKey,
          role: row.role,
          name: row.name,
          status: row.status,
          datetime: row.datetime,
          contentJson: row.contentJson,
          extJson: row.extJson,
          updateTime: row.updateTime,
        });
    });
  }

  private schedulePersist(messageId: string, immediate = false) {
    if (immediate) {
      this.persistNow(messageId);
      return;
    }
    const prior = this.timers.get(messageId);
    if (prior) clearTimeout(prior);
    this.timers.set(messageId, setTimeout(() => {
      this.timers.delete(messageId);
      this.persistNow(messageId);
    }, this.debounceMs));
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
    this.snapshots.set(message.id, {
      id: message.id,
      role: message.role,
      name: message.name,
      status: message.status ?? "pending",
      datetime: message.datetime ?? new Date(createTime).toISOString(),
      content: [...(message.content ?? [])],
      ext: message.ext,
      createTime,
    });
    this.persistNow(message.id);
  }

  recordMessageUpdate(messageId: string, update: { status?: ChatMessageStatus; ext?: Record<string, unknown> }) {
    const message = this.snapshots.get(messageId);
    if (!message) return;
    if (update.status) message.status = update.status;
    if (update.ext) message.ext = { ...(message.ext ?? {}), ...update.ext };
    const terminal = update.status === "complete" || update.status === "error" || update.status === "stop";
    this.schedulePersist(messageId, terminal);
  }

  recordContentAdd(messageId: string, content: AIMessageContent) {
    const message = this.snapshots.get(messageId);
    if (!message) return;
    const id = (content as any).id;
    if (!id || !message.content.some((item: any) => item?.id === id)) {
      message.content.push(JSON.parse(JSON.stringify(content)));
    }
    this.schedulePersist(messageId);
  }

  recordContentUpdate(event: {
    messageId: string;
    contentId: string;
    type?: string;
    data?: unknown;
    strategy?: "merge" | "append";
    status?: ChatMessageStatus;
  }) {
    const message = this.snapshots.get(event.messageId);
    if (!message) return;
    let content = message.content.find((item: any) => item?.id === event.contentId) as any;
    if (!content) {
      content = {
        id: event.contentId,
        type: event.type ?? "text",
        data: event.type === "thinking" ? {} : "",
        status: event.status ?? "pending",
      };
      message.content.push(content);
    }
    applyContentUpdate(content, event);
    const terminal = event.status === "complete" || event.status === "error" || event.status === "stop";
    this.schedulePersist(event.messageId, terminal);
  }

  async flush() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const messageId of this.snapshots.keys()) this.persistNow(messageId);
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
