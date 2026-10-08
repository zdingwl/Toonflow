type Vendor = { id?: string; inputValues?: Record<string, string> };

export function comfyuiMemoryEndpoint(vendor: Vendor | undefined, request: string): string | undefined {
  const values = vendor?.inputValues || {};
  const supported = vendor?.id === "comfyui_local"
    ? request === "imageRequest" || (request === "videoRequest" && (values.videoBackend || "comfyui").trim().toLowerCase() === "comfyui")
    : vendor?.id === "comfyui_qwen21_fourview" ? request === "imageRequest"
    : vendor?.id === "comfyui_h3_hd" && request === "videoRequest";
  if (!supported) return;
  try {
    const url = new URL(values.baseUrl || "http://127.0.0.1:8188");
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    return url.href.replace(/\/+$/, "");
  } catch { return; } // Let the provider report invalid configuration itself.
}

interface ServerState {
  url: string;
  active: number;
  revision: number;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  checking?: Promise<void>;
}

/** Shared by image/video providers so a serial batch can reuse its models. */
export class ComfyuiMemoryManager {
  private servers = new Map<string, ServerState>();
  private readonly idleMs: number;
  private readonly retryMs: number;
  private readonly request: typeof fetch;
  private readonly logger: Pick<Console, "info" | "warn">;

  constructor(options: { idleMs?: number; retryMs?: number; request?: typeof fetch; logger?: Pick<Console, "info" | "warn"> } = {}) {
    this.idleMs = options.idleMs ?? 30000;
    this.retryMs = options.retryMs ?? 30000;
    this.request = options.request ?? fetch;
    this.logger = options.logger ?? console;
  }

  async run<T>(baseUrl: string, operation: () => Promise<T>): Promise<T> {
    const url = new URL(baseUrl);
    // These providers often use different spellings for the same local server.
    if (["localhost", "[::1]"].includes(url.hostname)) url.hostname = "127.0.0.1";
    const key = url.href.replace(/\/+$/, "");
    let state = this.servers.get(key);
    if (!state) {
      state = { url: baseUrl, active: 0, revision: 0, failures: 0 };
      this.servers.set(key, state);
    }
    state.active++;
    state.revision++;
    state.failures = 0;
    clearTimeout(state.timer);
    state.timer = undefined;
    try {
      // A newly submitted job invalidates an in-flight queue check, or waits for
      // an already-sent /free request before it can submit its own workflow.
      await state.checking;
      return await operation();
    } finally {
      state.active--;
      if (!state.active) this.schedule(key, state, this.idleMs);
    }
  }

  private schedule(key: string, state: ServerState, delay: number) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.checking = this.releaseWhenIdle(key, state, state.revision).finally(() => { state.checking = undefined; });
    }, delay);
    state.timer.unref?.();
  }

  private async releaseWhenIdle(key: string, state: ServerState, revision: number) {
    const unchanged = () => !state.active && state.revision === revision;
    const label = new URL(state.url).origin;
    try {
      if (!unchanged()) return;
      const response = await this.request(`${state.url}/queue`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`查询队列 HTTP ${response.status}`);
      const queue = await response.json();
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("队列响应无效");
      if (!unchanged()) return;
      // Poll timeouts may leave a real job running; also respect other ComfyUI clients.
      if (queue.queue_running.length || queue.queue_pending.length) {
        this.schedule(key, state, this.retryMs);
        return;
      }
      const released = await this.request(`${state.url}/free`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (!released.ok) throw new Error(`释放显存 HTTP ${released.status}`);
      this.logger.info(`[ComfyUI] ${label} 队列空闲，已请求卸载模型并清理缓存`);
      if (unchanged()) this.servers.delete(key);
    } catch (error) {
      // Cleanup errors must never turn an already completed render into a failure.
      this.logger.warn(`[ComfyUI] ${label} 自动清理未完成：${error instanceof Error ? error.message : String(error)}`);
      if (!unchanged()) return;
      if (++state.failures < 3) this.schedule(key, state, this.retryMs);
      else this.servers.delete(key);
    }
  }
}

const memory = new ComfyuiMemoryManager();

export function withComfyuiMemory<T>(vendor: Vendor | undefined, request: string, operation: () => Promise<T>): Promise<T> {
  const endpoint = comfyuiMemoryEndpoint(vendor, request);
  return endpoint ? memory.run(endpoint, operation) : operation();
}
