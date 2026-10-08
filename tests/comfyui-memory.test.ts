import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transform } from "sucrase";
import { ComfyuiMemoryManager, comfyuiMemoryEndpoint } from "../src/utils/comfyuiMemory";

const idle = { queue_running: [], queue_pending: [] };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(handler?: (path: string, init?: RequestInit) => Promise<Response>) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const warnings: string[] = [];
  const manager = new ComfyuiMemoryManager({
    idleMs: 30, retryMs: 50,
    request: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, init });
      return handler ? handler(path, init) : Response.json(idle);
    }) as typeof fetch,
    logger: { info() {}, warn(message: string) { warnings.push(message); } },
  });
  return { manager, calls, warnings };
}

test("only direct ComfyUI media providers participate, with merged endpoint and gateway distinction", () => {
  const vendor = { id: "comfyui_local", inputValues: { baseUrl: "http://localhost:8188/", videoBackend: "gateway" } };
  assert.equal(comfyuiMemoryEndpoint(vendor, "videoRequest"), undefined);
  assert.equal(comfyuiMemoryEndpoint(vendor, "imageRequest"), "http://localhost:8188");
  assert.equal(comfyuiMemoryEndpoint(vendor, "textRequest"), undefined);
  assert.equal(comfyuiMemoryEndpoint({ id: "comfyui_local" }, "videoRequest"), "http://127.0.0.1:8188");
  assert.equal(comfyuiMemoryEndpoint({ id: "comfyui_qwen21_fourview" }, "imageRequest"), "http://127.0.0.1:8188");
  assert.equal(comfyuiMemoryEndpoint({ id: "comfyui_h3_hd" }, "videoRequest"), "http://127.0.0.1:8188");
  assert.equal(comfyuiMemoryEndpoint({ id: "cloud" }, "videoRequest"), undefined);
});

test("completed output is returned immediately and idle cleanup requests both unload and cache release", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, calls } = fixture();
  assert.equal(await manager.run("http://127.0.0.1:8188", async () => "/saved.mp4"), "/saved.mp4");
  t.mock.timers.tick(29); await flush();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(calls.map(c => c.path), ["/queue", "/free"]);
  assert.equal(calls[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init!.body as string), { unload_models: true, free_memory: true });
  t.mock.timers.tick(500); await flush();
  assert.equal(calls.length, 2);
});

test("continuous batches reset the idle timer and overlapping providers sharing localhost do not unload each other", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, calls } = fixture();
  await manager.run("http://127.0.0.1:8188", async () => "first");
  t.mock.timers.tick(20);
  const finish = deferred<string>();
  const next = manager.run("http://localhost:8188", () => finish.promise);
  t.mock.timers.tick(100); await flush();
  assert.equal(calls.length, 0);
  const overlap = deferred<string>();
  const second = manager.run("http://127.0.0.1:8188", () => overlap.promise);
  finish.resolve("next"); await next;
  t.mock.timers.tick(100); await flush();
  assert.equal(calls.length, 0);
  overlap.resolve("second"); await second;
  t.mock.timers.tick(30); await flush();
  assert.deepEqual(calls.map(c => c.path), ["/queue", "/free"]);
});

test("other clients' running and pending jobs defer cleanup until both queues drain", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queues = [
    { queue_running: [[1, "other"]], queue_pending: [] },
    { queue_running: [], queue_pending: [[2, "next"]] }, idle,
  ];
  const { manager, calls } = fixture(async path => Response.json(path === "/queue" ? queues.shift() : {}));
  await manager.run("http://127.0.0.1:8188", async () => "done");
  t.mock.timers.tick(30); await flush();
  t.mock.timers.tick(50); await flush();
  assert.deepEqual(calls.map(c => c.path), ["/queue", "/queue"]);
  t.mock.timers.tick(50); await flush();
  assert.deepEqual(calls.map(c => c.path), ["/queue", "/queue", "/queue", "/free"]);
});

test("a new request during the queue check cancels stale cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const check = deferred<Response>();
  const { manager, calls } = fixture(async () => check.promise);
  await manager.run("http://127.0.0.1:8188", async () => "done");
  t.mock.timers.tick(30); await flush();
  let started = false;
  const next = manager.run("http://127.0.0.1:8188", async () => { started = true; });
  await flush(); assert.equal(started, false);
  check.resolve(Response.json(idle)); await next;
  assert.equal(started, true);
  assert.deepEqual(calls.map(c => c.path), ["/queue"]);
});

test("a new request waits for a free request already in flight before submitting a workflow", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const release = deferred<Response>();
  const { manager, calls } = fixture(async path => path === "/free" ? release.promise : Response.json(idle));
  await manager.run("http://127.0.0.1:8188", async () => "done");
  t.mock.timers.tick(30); await flush();
  assert.equal(calls[1].path, "/free");
  let started = false;
  const next = manager.run("http://127.0.0.1:8188", async () => { started = true; });
  await flush(); assert.equal(started, false);
  release.resolve(new Response(null, { status: 200 })); await next;
  assert.equal(started, true);
});

test("generation failure still schedules cleanup and cleanup failure cannot replace the original error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, calls, warnings } = fixture(async path => path === "/queue" ? Response.json(idle) : new Response(null, { status: 503 }));
  const failure = new Error("sampling failed");
  await assert.rejects(manager.run("http://127.0.0.1:8188", async () => { throw failure; }), error => error === failure);
  t.mock.timers.tick(30); await flush();
  t.mock.timers.tick(50); await flush();
  t.mock.timers.tick(50); await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(calls.filter(c => c.path === "/free").length, 3);
  assert.equal(warnings.length, 3);
});

test("invalid or unreachable queue responses never trigger unloading", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, calls } = fixture(async () => Response.json({ status: "unknown" }));
  await manager.run("http://127.0.0.1:8188", async () => "saved");
  t.mock.timers.tick(30); await flush();
  assert.deepEqual(calls.map(c => c.path), ["/queue"]);
});

test("AI dispatch wraps the real media provider with its effective configuration", async () => {
  const source = await readFile(new URL("../src/utils/ai.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function getVendorTemplateFn(fnName: FnName"), source.indexOf("async function withTaskRecord"));
  const values = { baseUrl: "http://localhost:9999", videoBackend: "gateway" };
  const selected = { modelName: "local-model" };
  const seen: any[] = [];
  const running = { vendor: { id: "comfyui_local", inputValues: {} }, videoRequest: (input: any, model: any) => { seen.push([input, model]); return "saved"; } };
  const sandbox = {
    transform: () => ({ code: "" }),
    u: { db: () => ({ where: () => ({ first: async () => ({ inputValues: JSON.stringify(values) }) }) }), vendor: { getModelList: async () => [selected], getCode: () => "" }, vm: () => running },
    withComfyuiMemory: async (vendor: any, request: string, operation: () => any) => { seen.push([vendor.id, vendor.inputValues, request]); return operation(); },
  };
  const getFn = vm.runInNewContext(transform(body, { transforms: ["typescript"] }).code + "; getVendorTemplateFn", sandbox);
  const request = await getFn("videoRequest", "comfyui_local:local-model");
  const input = { prompt: "existing prompt" };
  assert.equal(await request(input), "saved");
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), ["comfyui_local", values, "videoRequest"]);
  assert.deepEqual(seen[1], [input, selected]);
});
