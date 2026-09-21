import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(root, "Toonflow-web-master/src/utils/useChat.ts"), "utf8");
const transpiled = ts.transpileModule(source, {
  fileName: "useChat.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual((transpiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error), []);

function createHarness() {
  const handlers = new Map();
  const socket = {
    connected: true,
    on: (name, fn) => { handlers.set(name, fn); },
    emit: () => {},
    disconnect: () => {},
    removeAllListeners: () => {},
  };
  const fakeVue = {
    ref: (value) => ({ value }), shallowRef: (value) => ({ value }),
    computed: (fn) => ({ get value() { return fn(); } }),
    onMounted: () => {}, onUnmounted: () => {},
  };
  const exports = {};
  const module = { exports };
  // useChat 在 connect 时读取浏览器 token；单元测试不依赖真实浏览器或账号。
  new Function("require", "module", "exports", "localStorage", transpiled.outputText)(
    (name) => {
      if (name === "vue") return fakeVue;
      if (name === "socket.io-client") return { io: () => socket };
      if (name === "uuid") return { v4: () => "test-request-id" };
      throw new Error(`Unexpected import: ${name}`);
    }, module, exports, { getItem: () => null },
  );
  const received = [];
  const chat = module.exports.useChat({ url: "ws://localhost", xmlTags: ["storyboardTable"], autoConnect: false, manageLifecycle: false, onXmlTag: (event) => received.push(event) });
  chat.connect();
  return { handlers, received, chat };
}

const emitMessage = (handlers, id, text, status = "streaming") => handlers.get("message")({
  id, role: "assistant", status, datetime: new Date().toISOString(),
  content: [{ id: `content_${id}`, type: "text", data: text, status }],
});

test("消息完成但 storyboardTable 没有闭合时，不报告 XML 完成", () => {
  const { handlers, received } = createHarness();
  emitMessage(handlers, "truncated", '<storyboardTable scene="1" total="2" task="storyboard_run_01">## 场1：测试');
  handlers.get("content:update")({ messageId: "truncated", contentId: "content_truncated", type: "text", status: "complete" });
  assert.ok(received.length);
  assert.ok(received.every((event) => event.isComplete === false && event.status !== "complete"));
});

test("真实闭合的 storyboardTable 才报告 complete，且返回已闭合标志", () => {
  const { handlers, received } = createHarness();
  emitMessage(handlers, "closed", '<storyboardTable scene="1" total="2" task="storyboard_run_01">## 场1：测试</storyboardTable>');
  assert.equal(received.at(-1)?.isComplete, true);
  assert.equal(received.at(-1)?.status, "complete");
  assert.equal(received.at(-1)?.attrs.scene, "1");
  assert.equal(received.at(-1)?.value, "## 场1：测试");
});

test("Agent 错误消息显示服务端具体原因", () => {
  const { handlers, chat } = createHarness();
  emitMessage(handlers, "failed", "");
  handlers.get("message:update")({ id: "failed", status: "error", ext: { error: "导演计划输出不完整" } });
  const failed = chat.messages.value.find((item) => item.id === "failed");
  assert.equal(failed.content.at(-1).data, "导演计划输出不完整");
});
