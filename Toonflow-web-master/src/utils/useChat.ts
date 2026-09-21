// useChat.ts
import { ref, shallowRef, onMounted, onUnmounted, computed } from "vue";
import { io, Socket } from "socket.io-client";
import type { ChatMessagesData, AIMessage, UserMessage, AIMessageContent, ChatMessageStatus } from "@tdesign-vue-next/chat";

export interface MessageEvent {
  id: string;
  role: "assistant" | "user" | "system";
  name?: string;
  status: ChatMessageStatus;
  datetime: string;
  content: any[];
  ext?: Record<string, any>;
}

export interface MessageUpdateEvent {
  id: string;
  status?: ChatMessageStatus;
  ext?: Record<string, any>;
}

export interface ContentAddEvent {
  messageId: string;
  content: AIMessageContent;
}

export interface ContentUpdateEvent {
  messageId: string;
  contentId: string;
  type: string;
  data?: any;
  strategy?: "merge" | "append";
  status?: ChatMessageStatus;
}

export interface XmlChildItem {
  tag: string;
  attrs: Record<string, string>;
  value: string;
}

export interface XmlTagEvent {
  messageId: string;
  contentId?: string;
  type: "text" | "markdown";
  tag: string;
  value: string;
  attrs: Record<string, string>;
  children: XmlChildItem[];
  status: ChatMessageStatus;
  /** XML 标签本身是否已闭合。消息状态 complete 不代表标签闭合。 */
  isComplete: boolean;
}

export interface XmlTagOption {
  tag: string;
  keepInMessage?: boolean;
}

export interface ChatSocketEvents {
  chat: { content: string; attachments?: any[] };
  stop: { messageId: string };
  regenerate: { messageId: string };
  message: MessageEvent;
  "message:update": MessageUpdateEvent;
  "content:add": ContentAddEvent;
  "content:update": ContentUpdateEvent;
  error: { code: string; message: string };
}

export interface UseChatOptions {
  url: string;
  auth?: Record<string, any> | (() => Record<string, any>);
  autoConnect?: boolean;
  xmlTags?: Array<string | XmlTagOption>;
  keepXmlInMessage?: boolean;
  onXmlTag?: (event: XmlTagEvent) => void;
  onError?: (error: { code: string; message: string }) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  manageLifecycle?: boolean;
}

export function useChat(options: UseChatOptions) {
  const {
    url,
    auth,
    autoConnect = true,
    xmlTags = [],
    keepXmlInMessage = true,
    onXmlTag,
    onError,
    onConnect,
    onDisconnect,
    manageLifecycle = true,
  } = options;

  const socket = shallowRef<Socket | null>(null);
  const connected = ref(false);
  const connecting = ref(false);
  const messages = ref<ChatMessagesData[]>([]);
  const currentMessageId = ref<string | null>(null);
  const status = ref<"idle" | "pending" | "streaming">("idle");
  const xmlData = ref<Record<string, string>>({});
  const xmlDataByMessage = ref<Record<string, Record<string, string>>>({});
  const normalizedXmlTagOptions = Array.from(
    new Map(
      xmlTags
        .map((item) => (typeof item === "string" ? { tag: item } : item))
        .filter((item): item is XmlTagOption => Boolean(item?.tag))
        .map((item) => [item.tag, item]),
    ).values(),
  );
  const normalizedXmlTags = normalizedXmlTagOptions.map((item) => item.tag);
  const hiddenXmlTags = normalizedXmlTagOptions.filter((item) => ((item.keepInMessage ?? keepXmlInMessage) ? false : true)).map((item) => item.tag);
  const emittedXmlState = new Map<string, Record<string, string>>();
  const rawContentState = new Map<string, string>();

  const isGenerating = computed(() => {
    const lastMsg = messages.value[messages.value.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return false;
    const status = lastMsg.status;
    if (status === "pending" || status === "streaming") return true;
    const aiMsg = lastMsg as AIMessage;
    if (aiMsg.content?.some((c) => c.status === "pending" || c.status === "streaming")) return true;
    return false;
  });

  const lastMessage = computed(() => messages.value[messages.value.length - 1]);
  const findMessage = (id: string): ChatMessagesData | undefined => messages.value.find((m) => m.id === id);
  const findMessageIndex = (id: string): number => messages.value.findIndex((m) => m.id === id);
  const findContent = (msg: AIMessage, contentId: string): AIMessageContent | undefined => msg.content?.find((c) => c.id === contentId);

  const isEmptyMessageContent = (msg: ChatMessagesData | undefined): boolean => {
    if (!msg || msg.role !== "assistant") return false;
    const aiMsg = msg as AIMessage;
    if (!aiMsg.content || aiMsg.content.length === 0) return true;
    return aiMsg.content.every((item) => {
      if (item.data === null || item.data === undefined) return true;
      if (typeof item.data === "string") return item.data.trim() === "";
      return false;
    });
  };

  const isXmlTextContent = (content: AIMessageContent): content is Extract<AIMessageContent, { type: "text" | "markdown" }> =>
    (content.type === "text" || content.type === "markdown") && typeof content.data === "string";

  const getContentKey = (messageId: string, content: Pick<AIMessageContent, "id" | "type">) => `${messageId}:${content.id ?? content.type}`;
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const parseXmlAttributes = (tagStr: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    const attrRegex = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(tagStr)) !== null) {
      attrs[match[1]] = match[2] ?? match[3];
    }
    return attrs;
  };

  const parseXmlChildren = (content: string): XmlChildItem[] => {
    const children: XmlChildItem[] = [];
    const childRegex = /<(\w+)((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    while ((match = childRegex.exec(content)) !== null) {
      children.push({ tag: match[1], attrs: parseXmlAttributes(match[2]), value: match[3] ?? "" });
      lastIndex = childRegex.lastIndex;
    }
    const remaining = content.slice(lastIndex);
    const unclosedMatch = remaining.match(/<(\w+)((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>([\s\S]*)$/);
    if (unclosedMatch) {
      children.push({ tag: unclosedMatch[1], attrs: parseXmlAttributes(unclosedMatch[2]), value: unclosedMatch[3] });
    }
    return children;
  };

  const parseXmlTag = (text: string, tag: string) => {
    const escapedTag = escapeRegExp(tag);
    const openRegex = new RegExp(`<${escapedTag}(\\s[^>]*)?>`, "g");
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = openRegex.exec(text)) !== null) lastMatch = m;
    if (!lastMatch) return null;
    const attrs = parseXmlAttributes(lastMatch[1] ?? "");
    const contentStart = lastMatch.index + lastMatch[0].length;
    const closeTag = `</${tag}>`;
    const closeIndex = text.indexOf(closeTag, contentStart);
    const isComplete = closeIndex !== -1;
    const value = text.slice(contentStart, isComplete ? closeIndex : text.length).trim();
    const children = parseXmlChildren(value);
    return { value, attrs, children, isComplete };
  };

  const stripXmlFromMessage = (text: string) => {
    let sanitized = text;
    for (const tag of hiddenXmlTags) {
      const escapedTag = escapeRegExp(tag);
      sanitized = sanitized.replace(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>`, "g"), "");
      sanitized = sanitized.replace(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*$`, "g"), "");
    }
    return sanitized;
  };

  const getRawContentData = (messageId: string, content: AIMessageContent) => {
    if (!isXmlTextContent(content)) return null;
    return rawContentState.get(getContentKey(messageId, content)) ?? content.data;
  };
  const syncContentDisplay = (messageId: string, content: AIMessageContent) => {
    if (!isXmlTextContent(content)) return;
    const rawText = getRawContentData(messageId, content) ?? "";
    content.data = hiddenXmlTags.length ? stripXmlFromMessage(rawText) : rawText;
  };

  const syncXmlData = (messageId: string, content: AIMessageContent, messageStatus?: ChatMessageStatus) => {
    if (!normalizedXmlTags.length || !isXmlTextContent(content)) return;
    const contentKey = getContentKey(messageId, content);
    const prevState = emittedXmlState.get(contentKey) ?? {};
    const nextState = { ...prevState };
    const nextMessageData = { ...(xmlDataByMessage.value[messageId] ?? {}) };
    const status = content.status ?? messageStatus ?? "pending";
    const rawText = getRawContentData(messageId, content);
    if (rawText === null) return;
    let changed = false;
    for (const tag of normalizedXmlTags) {
      const parsed = parseXmlTag(rawText, tag);
      if (parsed === null) continue;
      const { value, isComplete } = parsed;
      // 消息已结束但 XML 未闭合时，绝不能向调用方报告标签 complete。
      const eventStatus = isComplete ? (status === "error" || status === "stop" ? status : "complete") : status === "complete" ? "error" : status;
      const shouldEmit = prevState[tag] !== value || eventStatus === "complete";
      if (!shouldEmit) continue;
      nextState[tag] = value;
      nextMessageData[tag] = value;
      xmlData.value = { ...xmlData.value, [tag]: value };
      changed = true;
      onXmlTag?.({
        messageId,
        contentId: content.id,
        type: content.type,
        tag,
        value,
        attrs: parsed.attrs,
        children: parsed.children,
        status: eventStatus,
        isComplete,
      });
    }
    if (!changed) return;
    emittedXmlState.set(contentKey, nextState);
    xmlDataByMessage.value = { ...xmlDataByMessage.value, [messageId]: nextMessageData };
  };

  const syncMessageXmlData = (messageId: string, message: ChatMessagesData | undefined, messageStatus?: ChatMessageStatus) => {
    if (!message || message.role !== "assistant") return;
    const aiMessage = message as AIMessage;
    aiMessage.content?.forEach((content) => syncXmlData(messageId, content, messageStatus ?? aiMessage.status));
  };

  const deepMerge = <T extends Record<string, any>>(target: T, source: Partial<T>): T => {
    if (typeof source !== "object" || source === null) return source as T;
    const result: Record<string, any> = { ...target };
    for (const key in source) {
      const sourceVal = source[key];
      const targetVal = result[key];
      if (Array.isArray(sourceVal)) {
        result[key] = [...(Array.isArray(targetVal) ? targetVal : []), ...sourceVal];
      } else if (typeof sourceVal === "object" && sourceVal !== null) {
        const base = typeof targetVal === "object" && targetVal !== null ? targetVal : {};
        result[key] = deepMerge(base as Record<string, any>, sourceVal as Record<string, any>);
      } else if (sourceVal !== undefined) {
        result[key] = sourceVal;
      }
    }
    return result as T;
  };

  const appendStringData = (content: AIMessageContent, delta: string) => {
    if (typeof content.data === "string") {
      content.data += delta;
    } else if (typeof content.data === "object" && content.data !== null) {
      if ("text" in content.data && typeof delta === "string") {
        (content.data as any).text = ((content.data as any).text || "") + delta;
      }
    }
  };

  const handleContentUpdate = (event: ContentUpdateEvent) => {
    const { messageId, contentId, type, data, strategy, status: eventStatus } = event;
    const msg = findMessage(messageId) as AIMessage;
    if (!msg || msg.role !== "assistant") return;
    const content = findContent(msg, contentId);
    if (!content) return;
    if (eventStatus) content.status = eventStatus;
    if (eventStatus === "streaming" || (strategy === "append" && data)) {
      if (msg.status === "pending") msg.status = "streaming";
      if (currentMessageId.value === messageId) status.value = "streaming";
    }
    if (data === undefined || data === null) {
      syncXmlData(messageId, content, msg.status);
      return;
    }
    if (isXmlTextContent(content) && typeof data === "string") {
      const contentKey = getContentKey(messageId, content);
      const previousRaw = rawContentState.get(contentKey) ?? content.data;
      const nextRaw = strategy === "append" ? previousRaw + data : data;
      rawContentState.set(contentKey, nextRaw);
      syncContentDisplay(messageId, content);
    } else if (strategy === "append") {
      if (typeof data === "string") {
        appendStringData(content, data);
      } else if (typeof data === "object") {
        content.data = deepMerge(content.data as any, data);
      }
    } else {
      if (typeof content.data === "object" && typeof data === "object") {
        content.data = { ...content.data, ...data };
      } else {
        content.data = data;
      }
    }
    if (!eventStatus && strategy === "append") content.status = "streaming";
    syncXmlData(messageId, content, msg.status);
  };

  const setupHandlers = () => {
    if (!socket.value) return;
    socket.value.on("message", (data: MessageEvent) => {
      const newMessage: ChatMessagesData = {
        id: data.id,
        role: data.role,
        name: data.name,
        status: data.status || "pending",
        datetime: data.datetime,
        content: data.content || [],
        ext: data.ext,
      } as ChatMessagesData;
      if (newMessage.status === "complete" && isEmptyMessageContent(newMessage)) return;
      if (data.role === "assistant") {
        const aiMessage = newMessage as AIMessage;
        aiMessage.content?.forEach((content) => {
          if (!isXmlTextContent(content)) return;
          rawContentState.set(getContentKey(data.id, content), content.data);
          syncContentDisplay(data.id, content);
        });
      }
      messages.value.push(newMessage);
      if (data.role === "assistant") {
        const aiMessage = newMessage as AIMessage;
        aiMessage.content?.forEach((content) => syncXmlData(data.id, content, aiMessage.status));
        currentMessageId.value = data.id;
        status.value = data.status === "streaming" ? "streaming" : "pending";
      }
    });

    socket.value.on("message:update", (data: MessageUpdateEvent) => {
      const msg = findMessage(data.id);
      if (!msg) return;
      if (data.status) msg.status = data.status;
      if (data.ext) msg.ext = { ...msg.ext, ...data.ext };
      if (data.status) syncMessageXmlData(data.id, msg, data.status);
      if (data.status === "complete" && isEmptyMessageContent(msg)) {
        removeMessage(data.id);
        if (currentMessageId.value === data.id) {
          currentMessageId.value = null;
          status.value = "idle";
        }
        return;
      }
      if (data.status === "streaming") status.value = "streaming";
      if (data.status === "complete" || data.status === "error" || data.status === "stop") {
        if (currentMessageId.value === data.id) {
          currentMessageId.value = null;
          status.value = "idle";
        }
      }
    });

    socket.value.on("content:add", (data: ContentAddEvent) => {
      const msg = findMessage(data.messageId) as AIMessage;
      if (!msg || msg.role !== "assistant") return;
      if (!msg.content) msg.content = [];
      const content = {
        ...data.content,
        status: data.content.status || "pending",
        ...(data.content.type === "thinking" ? { ext: { collapsed: true, ...data.content.ext } } : {}),
      };
      if (isXmlTextContent(content)) {
        rawContentState.set(getContentKey(data.messageId, content), content.data);
        syncContentDisplay(data.messageId, content);
      }
      if (content.type === "thinking") {
        const firstNonThinkingIndex = msg.content.findIndex((c: any) => c.type !== "thinking");
        if (firstNonThinkingIndex === -1) msg.content.push(content);
        else msg.content.splice(firstNonThinkingIndex, 0, content);
      } else {
        msg.content.push(content);
      }
      syncXmlData(data.messageId, content, msg.status);
      if (content.status === "streaming") {
        if (msg.status === "pending") msg.status = "streaming";
      }
    });

    socket.value.on("content:update", handleContentUpdate);
    socket.value.on("error", (error: { code: string; message: string }) => {
      console.error("[Chat Error]", error);
      onError?.(error);
    });
    socket.value.on("connect", () => {
      connected.value = true;
      connecting.value = false;
      onConnect?.();
    });
    socket.value.on("disconnect", (reason) => {
      connected.value = false;
      connecting.value = false;
      onDisconnect?.();
      console.log("[Chat Disconnected]", reason);
    });
    socket.value.on("connect_error", (error) => {
      connected.value = false;
      connecting.value = false;
      console.error("[Chat Connect Error]", error);
    });
  };

  const connect = () => {
    if (socket.value?.connected || connecting.value) return;
    connecting.value = true;
    if (!socket.value) {
      socket.value = io(url, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 10000,
        auth: { token: localStorage.getItem("token"), ...(typeof auth === "function" ? auth() : auth) },
      });
      setupHandlers();
    } else {
      socket.value.connect();
    }
  };

  const disconnect = () => {
    socket.value?.disconnect();
    connected.value = false;
    connecting.value = false;
  };
  const reconnect = () => {
    disconnect();
    setTimeout(connect, 100);
  };

  const emit = <E extends keyof ChatSocketEvents & string>(event: E, data?: ChatSocketEvents[E]) => {
    if (!socket.value?.connected) {
      console.warn("[Chat] Socket not connected");
      return false;
    }
    socket.value.emit(event, data);
    return true;
  };
  const on = <E extends keyof ChatSocketEvents & string>(event: E, callback: (data: ChatSocketEvents[E]) => void) => {
    socket.value?.on(event, callback as any);
    return () => socket.value?.off(event, callback as any);
  };
  const once = <E extends keyof ChatSocketEvents & string>(event: E, callback: (data: ChatSocketEvents[E]) => void) => {
    socket.value?.once(event, callback as any);
  };
  const off = <E extends keyof ChatSocketEvents & string>(event: E, callback?: (data: ChatSocketEvents[E]) => void) => {
    socket.value?.off(event, callback as any);
  };

  const chat = (content: string, attachments?: any[]) => {
    if (!content.trim() && !attachments?.length) return false;
    const userMessage: UserMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      status: "complete",
      datetime: new Date().toISOString(),
      content: [{ type: "text", data: content, status: "complete" }],
    };
    if (attachments?.length) {
      userMessage.content.push({ type: "attachment", data: attachments, status: "complete" });
    }
    messages.value.push(userMessage);
    return emit("chat", { content, attachments });
  };

  const stopGenerate = (messageId?: string) => {
    const id = messageId || currentMessageId.value;
    if (!id) return false;
    const msg = findMessage(id);
    if (msg) msg.status = "stop";
    currentMessageId.value = null;
    status.value = "idle";
    return emit("stop", { messageId: id });
  };
  const regenerate = (messageId: string) => emit("regenerate", { messageId });
  const clearMessages = () => {
    messages.value = [];
    currentMessageId.value = null;
    status.value = "idle";
    xmlData.value = {};
    xmlDataByMessage.value = {};
    emittedXmlState.clear();
    rawContentState.clear();
  };
  const removeMessage = (id: string) => {
    const idx = findMessageIndex(id);
    if (idx > -1) {
      const msg = messages.value[idx] as AIMessage | undefined;
      msg?.content?.forEach((content) => {
        emittedXmlState.delete(getContentKey(id, content));
        rawContentState.delete(getContentKey(id, content));
      });
      const nextByMessage = { ...xmlDataByMessage.value };
      delete nextByMessage[id];
      xmlDataByMessage.value = nextByMessage;
      messages.value.splice(idx, 1);
    }
  };
  const removeMessagesAfter = (id: string) => {
    const idx = findMessageIndex(id);
    if (idx > -1) messages.value.splice(idx + 1);
  };
  const updateMessage = (id: string, updates: Partial<ChatMessagesData>) => {
    const msg = findMessage(id);
    if (msg) Object.assign(msg, updates);
  };
  const getContentByType = <T extends AIMessageContent["type"]>(messageId: string, type: T): Extract<AIMessageContent, { type: T }>[] => {
    const msg = findMessage(messageId) as AIMessage;
    if (!msg || msg.role !== "assistant") return [];
    return (msg.content?.filter((c) => c.type === type) || []) as Extract<AIMessageContent, { type: T }>[];
  };

  if (manageLifecycle) {
    onMounted(() => {
      if (autoConnect) connect();
    });
    onUnmounted(() => {
      disconnect();
      socket.value?.removeAllListeners();
      socket.value = null;
    });
  } else if (autoConnect) {
    connect();
  }

  return {
    socket,
    connected,
    connecting,
    status,
    messages,
    currentMessageId,
    xmlData,
    xmlDataByMessage,
    isGenerating,
    lastMessage,
    connect,
    disconnect,
    reconnect,
    emit,
    on,
    once,
    off,
    chat,
    stopGenerate,
    regenerate,
    clearMessages,
    removeMessage,
    removeMessagesAfter,
    updateMessage,
    findMessage,
    getContentByType,
  };
}

export type UseChatReturn = ReturnType<typeof useChat>;
