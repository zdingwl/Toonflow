import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transform } from "sucrase";
import test from "node:test";

const source = await readFile(new URL("../data/vendor/comfyui_local.ts", import.meta.url), "utf8");
const vmSource = await readFile(new URL("../src/utils/vm.ts", import.meta.url), "utf8");
const pollSource = vmSource.match(/export async function pollTask\([\s\S]*?(?=\/\*\*)/)?.[0];
assert.ok(pollSource, "exercise the real provider polling helper with a virtual clock");
const deadline = 3 * 60 * 60 * 1000;

function fixture({ readyAt = 34 * 60 * 1000 + 12000, transientAt = [], failure, receiptFailure } = {}) {
  let now = 0;
  let receiptSaved = false;
  const promptId = "existing-h3-prompt";
  const calls = { submissions: 0, history: [], polling: [], receipts: [] };
  const sandbox = {
    exports: {},
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => { now += delay; callback(); },
    u: { error: value => value },
    axios: {
      post: async url => {
        assert.ok(url.endsWith("/prompt"));
        calls.submissions += 1;
        return { data: { prompt_id: promptId } };
      },
      get: async url => {
        assert.ok(receiptSaved, "persist the external ID before polling the provider");
        assert.ok(url.endsWith(`/history/${promptId}`));
        calls.history.push(now);
        if (transientAt.includes(now)) throw Object.assign(new Error("history temporarily unavailable"), { code: "ECONNABORTED" });
        if (failure) return { data: { [promptId]: { status: { status_str: "error", messages: [failure] } } } };
        return { data: now < readyAt ? {} : {
          [promptId]: { status: { status_str: "success", completed: true }, outputs: {
            "14": { images: [{ filename: "生成结果.mp4", subfolder: "Toonflow/H3", type: "output" }] },
          } },
        } };
      },
    },
  };
  vm.runInNewContext(transform(pollSource, { transforms: ["typescript", "imports"] }).code, sandbox);
  const pollTask = sandbox.exports.pollTask;
  sandbox.pollTask = (fn, interval, timeout) => {
    calls.polling.push({ interval, timeout });
    return pollTask(fn, interval, timeout);
  };
  vm.runInNewContext(transform(source, { transforms: ["typescript", "imports"] }).code, sandbox);
  Object.assign(sandbox.exports.vendor.inputValues, {
    workflowApi: JSON.stringify({ "1": { class_type: "TestH3", inputs: { prompt: "" } } }),
    workflowMapping: JSON.stringify({ prompt: { node: "1", input: "prompt" }, outputNode: "14" }),
  });
  const run = () => sandbox.exports.videoRequest({
    prompt: "A single H3 shot.", duration: 15, resolution: "768p", aspectRatio: "16:9", mode: "text",
    onTaskSubmitted: async receipt => {
      calls.receipts.push(JSON.parse(JSON.stringify(receipt)));
      await Promise.resolve();
      if (receiptFailure) throw new Error(receiptFailure);
      receiptSaved = true;
    },
  }, { modelName: "MiniMax-H3-local" });
  return { run, calls, elapsed: () => now };
}

test("a native H3 clip completed after 34 minutes is saved from its original submission", async () => {
  const f = fixture();
  const url = new URL(await f.run());
  assert.equal(url.searchParams.get("filename"), "生成结果.mp4");
  assert.equal(url.searchParams.get("subfolder"), "Toonflow/H3");
  assert.equal(f.calls.submissions, 1);
  assert.equal(f.elapsed(), 34 * 60 * 1000 + 12000);
  assert.deepEqual(f.calls.polling, [{ interval: 3000, timeout: deadline }]);
  assert.deepEqual(f.calls.receipts, [{ provider: "comfyui", promptId: "existing-h3-prompt", baseUrl: "http://127.0.0.1:8188", outputNode: "14" }]);
});

test("the final history read recovers a clip completed at the polling deadline", async () => {
  const f = fixture({ readyAt: deadline });
  assert.ok((await f.run()).includes("/view?"));
  assert.deepEqual(f.calls.polling.map(item => item.timeout), [deadline, 30000]);
  assert.equal(f.elapsed(), deadline);
  assert.equal(f.calls.submissions, 1);
});

test("final reconciliation retries transient history failures without submitting again", async () => {
  const f = fixture({ readyAt: deadline + 6000, transientAt: [deadline, deadline + 3000] });
  assert.ok((await f.run()).includes("/view?"));
  assert.equal(f.elapsed(), deadline + 6000);
  assert.equal(f.calls.submissions, 1);
});

test("a genuine deadline retains the external task ID and explains that generation may continue", async () => {
  const f = fixture({ readyAt: Infinity });
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /3 小时/);
    assert.match(error.message, /可能仍在执行/);
    assert.match(error.message, /prompt_id=existing-h3-prompt/);
    assert.match(error.message, /避免重复生成/);
    return true;
  });
  assert.equal(f.elapsed(), deadline + 30000);
  assert.equal(f.calls.submissions, 1);
});

test("a provider execution failure is reported immediately with its external task ID", async () => {
  const f = fixture({ failure: "out of memory" });
  await assert.rejects(f.run(), /执行失败.*out of memory.*prompt_id=existing-h3-prompt/);
  assert.equal(f.elapsed(), 0);
  assert.equal(f.calls.polling.length, 1);
  assert.equal(f.calls.submissions, 1);
});

test("receipt persistence failure preserves the accepted ID and never repeats submission", async () => {
  const f = fixture({ receiptFailure: "database unavailable" });
  await assert.rejects(f.run(), /任务已提交.*database unavailable.*prompt_id=existing-h3-prompt.*避免重复生成/);
  assert.equal(f.calls.submissions, 1);
  assert.equal(f.calls.history.length, 0);
});
