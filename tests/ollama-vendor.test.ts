import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { transform } from "sucrase";

const source = fs.readFileSync("data/vendor/ollama.ts", "utf8");

function load() {
  let settings: any;
  let request: any;
  const exported: any = {};
  vm.runInNewContext(transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, ""), {
    exports: exported,
    createOpenAICompatible: (options: any) => {
      settings = options;
      return { chatModel: (modelName: string) => ({ modelName }) };
    },
    fetch: async (url: string, init: any) => { request = { url, ...init, body: JSON.parse(init.body) }; },
  });
  return { exported, settings: () => settings, request: () => request };
}

test("Ollama uses the installed model tag and accepts a keyless root URL", () => {
  const { exported, settings } = load();
  exported.vendor.inputValues.baseUrl = " http://127.0.0.1:11434/ ";
  const model = exported.textRequest(exported.vendor.models[0]);
  assert.equal(model.modelName, "QWEN3.8:27b");
  assert.equal(settings().baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(settings().apiKey, undefined);
});

test("Ollama preserves /v1 and accepts an optional proxy API key", () => {
  const { exported, settings } = load();
  exported.vendor.inputValues.baseUrl = "http://127.0.0.1:11434/v1/";
  exported.vendor.inputValues.apiKey = "Bearer local-test-key";
  exported.textRequest(exported.vendor.models[0]);
  assert.equal(settings().baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(settings().apiKey, "local-test-key");
});

test("thinking mode keeps tools, streaming and cancellation intact", async () => {
  for (const [think, level, expected] of [[false, 0, "none"], [true, 0, "medium"], [true, 1, "low"], [true, 2, "medium"], [true, 3, "high"]] as const) {
    const { exported, settings, request } = load();
    exported.textRequest(exported.vendor.models[0], think, level);
    const signal = new AbortController().signal;
    const body = { model: "QWEN3.8:27b", messages: [{ role: "user", content: "hello" }], stream: true, tools: [{ type: "function", function: { name: "check" } }] };
    await settings().fetch("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", body: JSON.stringify(body), signal });
    assert.deepEqual(request().body, { ...body, reasoning_effort: expected });
    assert.equal(request().signal, signal);
  }
});

test("bundled vendor sources match the runtime adapter", () => {
  for (const path of ["data/vendor/vendor.json", "src/lib/vendor.json"]) {
    assert.equal(JSON.parse(fs.readFileSync(path, "utf8"))["ollama.ts"], source);
  }
});
