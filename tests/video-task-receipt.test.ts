import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { VM } from "vm2";
import knex from "knex";
import { transform } from "sucrase";

// Load the real task writer with an isolated DB; importing the application DB runs startup recovery.
async function fixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_tasks", t => {
    t.increments("id");
    t.integer("projectId");
    for (const column of ["taskClass", "relatedObjects", "model", "describe", "state", "reason"]) t.text(column);
    t.bigInteger("startTime");
  });
  const source = readFileSync("src/utils/taskRecord.ts", "utf8");
  const mod = { exports: {} as any };
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)(
    (name: string) => {
      assert.equal(name, "@/utils/db");
      return db;
    }, mod, mod.exports,
  );
  return { db, taskRecord: mod.exports.default };
}

function loadVideo(taskRecord: any, provider: (input: any) => Promise<string>) {
  const source = readFileSync("src/utils/ai.ts", "utf8");
  const wrapper = source.slice(source.indexOf("async function withTaskRecord"), source.indexOf("async function urlToBase64"));
  const video = source.slice(source.indexOf("class AiVideo"), source.indexOf("class AiAudio"));
  return vm.runInNewContext(transform(`${wrapper}\n${video}`, { transforms: ["typescript"] }).code + "; AiVideo", {
    u: { task: taskRecord, error: (error: any) => error },
    resolveModelName: async (name: string) => name,
    withNonGraphicVisuals: (prompt: string) => prompt,
    referenceList2imageBase642: () => {},
    getVendorTemplateFn: async () => provider,
  });
}

const receipt = (promptId: string) => ({ provider: "comfyui", promptId, baseUrl: "http://127.0.0.1:8188", outputNode: "14" });
const metadata = (videoId: number) => ({ projectId: 7, videoId, scriptId: 2, type: "视频", otherKey: "preserve" });

test("provider receipts stay with the inserted task when concurrent submissions complete out of order", async () => {
  const { db, taskRecord } = await fixture();
  try {
    const first = await taskRecord(7, "视频生成", "h3", { content: JSON.stringify(metadata(104)) });
    const second = await taskRecord(7, "视频生成", "h3", { content: JSON.stringify(metadata(107)) });
    await second.onTaskSubmitted(receipt("prompt-second"));
    await first.onTaskSubmitted(receipt("prompt-first"));
    await first(1);
    await second(-1, "provider interrupted");
    const rows = await db("o_tasks").orderBy("id");
    assert.deepEqual(JSON.parse(rows[0].relatedObjects), { ...metadata(104), providerTask: receipt("prompt-first") });
    assert.deepEqual(JSON.parse(rows[1].relatedObjects), { ...metadata(107), providerTask: receipt("prompt-second") });
    assert.equal(rows[0].state, "已完成");
    assert.equal(rows[1].state, "生成失败");
  } finally {
    await db.destroy();
  }
});

test("video dispatch persists the accepted prompt before provider polling and retains it after a later error", async () => {
  const { db, taskRecord } = await fixture();
  try {
    const Video = loadVideo(taskRecord, async input => {
      assert.equal(typeof input.onTaskSubmitted, "function");
      await input.onTaskSubmitted(receipt("accepted-prompt"));
      const row = await db("o_tasks").first();
      assert.deepEqual(JSON.parse(row.relatedObjects), { ...metadata(104), providerTask: receipt("accepted-prompt") });
      assert.equal(row.state, "进行中");
      throw new Error("provider polling interrupted");
    });
    const video = new Video("comfyui_local:minimax-h3-local");
    await assert.rejects(video.run({ prompt: "existing prompt" }, {
      projectId: 7, taskClass: "视频生成", describe: "test", relatedObjects: JSON.stringify(metadata(104)),
    }), /provider polling interrupted/);
    const row = await db("o_tasks").first();
    assert.equal(row.state, "生成失败");
    assert.equal(row.reason, "provider polling interrupted");
    assert.equal(JSON.parse(row.relatedObjects).providerTask.promptId, "accepted-prompt");
  } finally {
    await db.destroy();
  }
});

test("legacy video providers still finish without using the optional submission callback", async () => {
  const { db, taskRecord } = await fixture();
  try {
    let callCount = 0;
    const Video = loadVideo(taskRecord, async input => {
      callCount++;
      assert.equal(typeof input.onTaskSubmitted, callCount === 1 ? "function" : "undefined");
      return "base64-video";
    });
    const video = new Video("legacy:video");
    await video.run({ prompt: "existing prompt" }, {
      projectId: 7, taskClass: "视频生成", describe: "test", relatedObjects: JSON.stringify(metadata(104)),
    });
    const row = await db("o_tasks").first();
    assert.equal(row.state, "已完成");
    assert.deepEqual(JSON.parse(row.relatedObjects), metadata(104));
    await video.run({ prompt: "without task record" });
    assert.equal((await db("o_tasks")).length, 1);
  } finally {
    await db.destroy();
  }
});

test("the vendor VM can await the host task receipt callback", async () => {
  const { db, taskRecord } = await fixture();
  try {
    const vendorExports: any = {};
    const vendorVm = new VM({ sandbox: { exports: vendorExports } });
    vendorVm.run(`exports.videoRequest = async input => {
      await input.onTaskSubmitted(${JSON.stringify(receipt("sandbox-prompt"))});
      return "base64-video";
    };`);
    const Video = loadVideo(taskRecord, vendorExports.videoRequest);
    await new Video("comfyui_local:minimax-h3-local").run({ prompt: "existing prompt" }, {
      projectId: 7, taskClass: "视频生成", describe: "test", relatedObjects: JSON.stringify(metadata(104)),
    });
    const row = await db("o_tasks").first();
    assert.equal(row.state, "已完成");
    assert.deepEqual(JSON.parse(row.relatedObjects), { ...metadata(104), providerTask: receipt("sandbox-prompt") });
  } finally {
    await db.destroy();
  }
});

test("video completion waits until the terminal task state is persisted", async () => {
  let release!: () => void;
  const persisted = new Promise<void>(resolve => { release = resolve; });
  const task = Object.assign(async () => { await persisted; }, { onTaskSubmitted: async () => {} });
  const Video = loadVideo(async () => task, async () => "base64-video");
  let finished = false;
  const running = new Video("legacy:video").run({ prompt: "existing prompt" }, {
    projectId: 7, taskClass: "视频生成", describe: "test", relatedObjects: "{}",
  }).then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await running;
  assert.equal(finished, true);
});
