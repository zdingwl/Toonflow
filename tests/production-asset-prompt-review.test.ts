import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import { validateFields } from "../src/middleware/middleware";
import { loadAssetPromptContext } from "../src/utils/assetPromptGeneration";
import { getOperationReceipt, withOperationReceipt } from "../src/utils/agent/runtime/operationReceipt";

const requestId = "asset_review_1234";
const scope = { projectId: 1, episodesId: 20 };
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(); }
  throw new Error("mock production worker did not reach expected state");
}

async function fixture(options: { reject?: boolean; blockPrompt?: boolean; switchSelection?: boolean; fourView?: boolean; unreadableBoard?: boolean } = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_project", t => { t.integer("id"); for (const key of ["imageModel", "imageQuality", "artStyle"]) t.text(key); });
  await db.schema.createTable("o_script", t => { t.integer("id"); t.integer("projectId"); });
  await db.schema.createTable("o_scriptAssets", t => { t.integer("scriptId"); t.integer("assetId"); });
  await db.schema.createTable("o_assets", t => {
    for (const key of ["id", "projectId", "assetsId", "imageId", "designVersion"]) t.integer(key);
    for (const key of ["type", "name", "describe", "prompt", "promptState", "promptErrorReason", "designStatus", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath", "referenceLayout", "referenceFingerprint"]) t.text(key);
  });
  await db.schema.createTable("o_image", t => {
    t.increments("id"); t.integer("assetsId");
    for (const key of ["type", "state", "model", "resolution", "filePath", "errorReason"]) t.text(key);
  });
  await db.schema.createTable("o_agentWorkData", t => {
    t.integer("id").primary(); t.integer("projectId"); t.integer("episodesId"); t.text("key"); t.text("data"); t.integer("createTime"); t.integer("updateTime");
  });
  await db("o_project").insert({ id: 1, imageModel: options.fourView ? "comfyui_qwen21_fourview:qwen-image-2.1-fourview-local" : "mock:image", imageQuality: "1K", artStyle: "realistic_3d_anime" });
  await db("o_script").insert({ id: 20, projectId: 1 });
  await db("o_scriptAssets").insert([{ scriptId: 20, assetId: 10 }, { scriptId: 20, assetId: 11 }]);
  await db("o_image").insert([
    { id: 4, assetsId: 10, type: "role", state: "已完成", filePath: "/old-base.jpg" },
    { id: 5, assetsId: 11, type: "role", state: "已完成", filePath: "/old-derivative.jpg" },
  ]);
  await db("o_assets").insert([
    { id: 10, projectId: 1, assetsId: null, imageId: 4, type: "role", name: "艾娃", describe: "普通状态，红色上衣", prompt: "旧普通态提示词", designVersion: 3, designStatus: "ready", faceReferencePath: "/old-face.png", fullBodyReferencePath: "/old-body.png", referenceFingerprint: "old-hash" },
    { id: 11, projectId: 1, assetsId: 10, imageId: 5, type: "role", name: "艾娃觉醒", describe: "瞳色变红，保留原衣装", prompt: "旧觉醒态提示词" },
  ]);
  const calls = { contexts: [] as any[], prompts: [] as any[], reviews: [] as any[], renders: [] as any[], manuals: [] as string[], saved: [] as string[], crops: [] as any[], completedRequests: 0 };
  let uuid = 0;
  let releasePrompt!: () => void;
  const promptGate = options.blockPrompt ? new Promise<void>(resolve => { releasePrompt = resolve; }) : Promise.resolve();
  releasePrompt ||= () => {};
  const u = {
    db, uuid: () => "candidate-" + (++uuid), error: (e: any) => e,
    getArtPrompt: (_style: string, _kind: string, manual: string) => { calls.manuals.push(manual); return "manual:" + manual; },
    oss: { getSmallImageUrl: async (path: string) => path, getImageBase64: async (path: string) => "data:image/png;base64," + Buffer.from(path).toString("base64") },
    Ai: {
      Text: () => ({ invoke: async () => { throw new Error("Unexpected real text invocation"); } }),
      Image: () => ({ run: async (input: any) => { calls.renders.push(input); return { save: async (path: string) => { calls.saved.push(path); if (options.reject) throw new Error("图片文件保存失败"); } }; } }),
    },
  };
  const imports: Record<string, unknown> = {
    "@/utils": u,
    "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
    "@/utils/agent/runtime/operationReceipt": { getOperationReceipt, withOperationReceipt },
    "@/utils/assetImageModel": { isRoleFourViewModel: (model: string) => model === "comfyui_qwen21_fourview:qwen-image-2.1-fourview-local" },
    "@/utils/assetReferenceMedia": {
      ensureRoleReferenceMedia: async () => { calls.crops.push({}); throw new Error("Retired crop path invoked"); },
      roleReferenceFingerprint: async (path: string) => {
        assert.ok(calls.saved.includes(path));
        if (options.switchSelection) {
          const assetId = (await db("o_image").where({ filePath: path }).first()).assetsId;
          const [selectedImageId] = await db("o_image").insert({ assetsId: assetId, type: "role", state: "已完成", filePath: "/newer-selected.jpg" });
          await db("o_assets").where({ id: assetId }).update({ imageId: selectedImageId, faceReferencePath: "/newer-face.png", fullBodyReferencePath: "/newer-body.png", referenceFingerprint: "newer-hash", designVersion: 8 });
        }
        if (options.unreadableBoard) throw new Error("完整人物图片不可读取");
        return "hash:" + path;
      },
    },
    "@/utils/assetPromptGeneration": {
      loadAssetPromptContext: async (database: any, input: any, overrides: any) => {
        const context = await loadAssetPromptContext(database, input, overrides);
        calls.contexts.push({ input, overrides: { ...overrides }, context }); return context;
      },
      generateAssetPrompt: async (_deps: unknown, context: any, manual: string) => {
        calls.prompts.push({ context, manual }); await promptGate;
        return "新资产提示词:" + context.asset.id;
      },
      reviewAssetImage: async (_deps: unknown, context: any, prompt: string, candidatePath: string) => {
        const candidate = await db("o_image").where({ assetsId: context.asset.id, filePath: candidatePath }).first();
        assert.equal(candidate.state, "生成中");
        calls.reviews.push({ context, prompt, candidatePath });
        if (options.reject) throw new Error("图文审核未通过：衣装与参考不符");

      },
    },
  };
  const localRequire = createRequire(process.cwd() + "/package.json"), mod = { exports: {} as any };
  const code = transform(readFileSync("src/routes/production/assets/batchGenerateAssetsImage.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => imports[id] || localRequire(id), mod, mod.exports);
  const routeStack = mod.exports.default.stack[0].route.stack;
  const finalHandler = routeStack[routeStack.length - 1];
  const originalHandler = finalHandler.handle;
  finalHandler.handle = async (...args: any[]) => {
    try { await originalHandler(...args); } finally { calls.completedRequests++; }
  };
  const app = express(); app.use(express.json()); app.use("/", mod.exports.default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  return {
    db, calls, releasePrompt,
    async request(assetIds: number[] = [10], id = requestId) {
      const response = await fetch("http://127.0.0.1:" + (server.address() as any).port, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetIds, projectId: 1, scriptId: 20, concurrentCount: 1, requestId: id }),
      });
      return { status: response.status, body: await response.json() };
    },
    async settle(expected: number) {
      await until(async () => {
        const candidates = await db("o_image").where("id", ">", 5);
        return candidates.length === expected && candidates.every((row: any) => row.state !== "生成中");
      });
    },
    receipt: () => getOperationReceipt<any>(db, scope, "asset-generate", requestId),
    async close() { releasePrompt(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); },
  };
}

test("production receipt snapshots selected base and derivative images before binding pending attempts", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request([10, 11])).status, 200); await f.settle(2);
    const receipt = await f.receipt();
    assert.deepEqual(receipt?.data.referenceImageIdMap, { 10: 4, 11: 5 });
    assert.notEqual(receipt?.data.imageIdMap[10], 4); assert.notEqual(receipt?.data.imageIdMap[11], 5);
    assert.equal(f.calls.contexts[0].context.asset.selectedImagePath, "/old-base.jpg");
    assert.equal(f.calls.contexts[1].context.asset.selectedImagePath, "/old-derivative.jpg");
    assert.equal(f.calls.contexts[1].context.parent.selectedImagePath, "/old-base.jpg");
    assert.deepEqual(f.calls.manuals, ["art_character", "art_character_derivative"]);
    assert.equal(f.calls.prompts.length, 2);
    assert.equal(f.calls.prompts[0].manual, "manual:art_character");
    assert.equal(f.calls.prompts[1].manual, "manual:art_character_derivative");
    assert.equal((await f.db("o_assets").where({ id: 11 }).first()).prompt, "新资产提示词:11");
    assert.equal(f.calls.reviews.length, 0);
    for (const id of [10, 11]) {
      const asset = await f.db("o_assets").where({ id }).first();
      const image = await f.db("o_image").where({ id: asset.imageId }).first();
      assert.equal(asset.faceReferencePath, id === 10 ? "/old-face.png" : null);
      assert.equal(asset.fullBodyReferencePath, id === 10 ? "/old-body.png" : null);
      assert.equal(asset.referenceFingerprint, "hash:" + image.filePath);
      assert.equal(asset.referenceLayout, "four_view");
      assert.equal(asset.designVersion, id === 10 ? 4 : 1);
    }
  } finally { await f.close(); }
});

test("production save failure restores the prior selection", async () => {
  const f = await fixture({ reject: true });
  try {
    const before = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal((await f.request()).status, 200); await f.settle(1);
    const asset = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal(asset.imageId, before.imageId);
    for (const key of ["faceReferencePath", "fullBodyReferencePath", "referenceFingerprint", "designVersion", "designStatus"]) assert.equal(asset[key], before[key]);
    assert.equal(f.calls.crops.length, 0);
    assert.equal(asset.promptState, "生成失败"); assert.match(asset.promptErrorReason, /图片文件保存失败/);
    const candidate = await f.db("o_image").where("id", ">", 5).first();
    assert.equal(candidate.state, "生成失败"); assert.equal(candidate.filePath, null); assert.match(candidate.errorReason, /图片文件保存失败/);
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.db("o_image").where("id", ">", 5)).length, 1);
    assert.equal(f.calls.prompts.length, 1); assert.equal(f.calls.renders.length, 1);
  } finally { await f.close(); }
});

test("duplicate production requests do not start a second worker during or after generation", async () => {
  const f = await fixture({ blockPrompt: true });
  try {
    assert.equal((await f.request()).status, 200);
    await until(() => f.calls.prompts.length === 1);
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.db("o_image").where("id", ">", 5)).length, 1);
    assert.equal(f.calls.prompts.length, 1); assert.equal(f.calls.renders.length, 0);
    f.releasePrompt(); await f.settle(1);
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.db("o_image").where("id", ">", 5)).length, 1);
    assert.equal(f.calls.prompts.length, 1); assert.equal(f.calls.renders.length, 1);
  } finally { await f.close(); }
});

test("production recovery resumes a pending receipt using its saved reference instead of the placeholder", async () => {
  const f = await fixture();
  try {
    const claimed = await withOperationReceipt(f.db, scope, "asset-generate", requestId, { assetIds: [10], projectId: 1, scriptId: 20 }, async trx => {
      const [imageId] = await trx("o_image").insert({ assetsId: 10, type: "role", state: "生成中" });
      await trx("o_assets").where({ id: 10 }).update({ imageId });
      return { assetIds: [10], imageIdMap: { 10: imageId }, referenceImageIdMap: { 10: 4 } };
    });
    assert.equal((await f.request()).status, 200); await f.settle(1);
    assert.equal(f.calls.contexts[0].context.asset.selectedImagePath, "/old-base.jpg");
    assert.equal((await f.db("o_image").where("id", ">", 5)).length, 1);
    const asset = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal(asset.imageId, claimed.receipt.data.imageIdMap[10]);
    assert.equal(f.calls.renders.length, 1);
  } finally { await f.close(); }
});


for (const priorState of ["已完成", "生成失败"]) {
  test("a " + priorState + " request is not restarted when a different request owns the current pending image", async () => {
    const f = await fixture();
    try {
      const prior = await withOperationReceipt(f.db, scope, "asset-generate", requestId, { assetIds: [10], projectId: 1, scriptId: 20 }, async trx => {
        const [imageId] = await trx("o_image").insert({ assetsId: 10, type: "role", state: priorState, filePath: "/request-a-result.jpg" });
        await trx("o_assets").where({ id: 10 }).update({ imageId });
        return { assetIds: [10], imageIdMap: { 10: imageId }, referenceImageIdMap: { 10: 4 } };
      });
      const next = await withOperationReceipt(f.db, scope, "asset-generate", "different_request_5678", { assetIds: [10], projectId: 1, scriptId: 20 }, async trx => {
        const [imageId] = await trx("o_image").insert({ assetsId: 10, type: "role", state: "生成中" });
        await trx("o_assets").where({ id: 10 }).update({ imageId });
        return { assetIds: [10], imageIdMap: { 10: imageId }, referenceImageIdMap: { 10: prior.receipt.data.imageIdMap[10] } };
      });
      const before = await f.db("o_image").where({ id: prior.receipt.data.imageIdMap[10] }).first();
      assert.equal((await f.request()).status, 200);
      await until(() => f.calls.completedRequests === 1);
      assert.equal(f.calls.prompts.length, 0); assert.equal(f.calls.renders.length, 0);
      assert.deepEqual(await f.db("o_image").where({ id: before.id }).first(), before);
      assert.equal((await f.db("o_assets").where({ id: 10 }).first()).imageId, next.receipt.data.imageIdMap[10]);
      assert.equal((await f.db("o_image").where({ id: next.receipt.data.imageIdMap[10] }).first()).state, "生成中");
      assert.equal((await f.db("o_image").where("id", ">", 5)).length, 2);
    } finally { await f.close(); }
  });
}


test("production reference adoption uses the four-view layout of the selected model", async () => {
  const f = await fixture({ fourView: true });
  try {
    assert.equal((await f.request()).status, 200); await f.settle(1);
    const asset = await f.db("o_assets").where({ id: 10 }).first();
    const candidate = await f.db("o_image").where({ id: asset.imageId }).first();
    assert.deepEqual(f.calls.crops, []);
    assert.equal(asset.referenceLayout, "four_view");
    assert.equal(asset.sideReferencePath, null);
    assert.equal(asset.backReferencePath, null);
  } finally { await f.close(); }
});

test("a late production result never replaces the references of a newer selection", async () => {
  const f = await fixture({ switchSelection: true });
  try {
    assert.equal((await f.request()).status, 200);
    await until(() => f.calls.completedRequests === 1);
    const asset = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal((await f.db("o_image").where({ id: asset.imageId }).first()).filePath, "/newer-selected.jpg");
    assert.equal(asset.faceReferencePath, "/newer-face.png");
    assert.equal(asset.fullBodyReferencePath, "/newer-body.png");
    assert.equal(asset.referenceFingerprint, "newer-hash"); assert.equal(asset.designVersion, 8);
    const receipt = await f.receipt();
    const olderCandidate = await f.db("o_image").where({ id: receipt?.data.imageIdMap[10] }).first();
    assert.equal(olderCandidate.state, "已完成"); assert.notEqual(asset.imageId, olderCandidate.id);
  } finally { await f.close(); }
});

test("unreadable production board preserves the prior image and reference fields", async () => {
  const f = await fixture({ unreadableBoard: true });
  try {
    const before = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal((await f.request()).status, 200); await f.settle(1);
    const asset = await f.db("o_assets").where({ id: 10 }).first();
    for (const key of ["imageId", "faceReferencePath", "fullBodyReferencePath", "referenceFingerprint", "designVersion"]) assert.equal(asset[key], before[key]);
    const candidate = await f.db("o_image").where("id", ">", 5).first();
    assert.equal(candidate.state, "生成失败"); assert.match(candidate.errorReason, /完整人物图片不可读取/); assert.ok(candidate.filePath);
  } finally { await f.close(); }
});
