import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import sharp from "sharp";
import { validateFields } from "../src/middleware/middleware";

const failureReason = "新图片与资产设定不一致，保留原图：服装颜色不符";
async function fixture(options: { state?: string; reason?: string; filePath?: string | null; assetsId?: number; missing?: boolean; corrupt?: boolean; imageType?: string; model?: string; width?: number; height?: number } = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_assets", t => {
    for (const key of ["id", "projectId", "imageId", "designVersion"]) t.integer(key);
    for (const key of ["type", "name", "prompt", "designStatus", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath", "referenceLayout", "referenceFingerprint"]) t.text(key);
  });
  await db.schema.createTable("o_image", t => {
    t.increments("id"); t.integer("assetsId");
    for (const key of ["type", "state", "model", "resolution", "filePath", "errorReason"]) t.text(key);
  });
  await db("o_assets").insert({ id: 10, projectId: 1, type: "role", name: "Ava", imageId: 4, prompt: "保留已确认提示词", designVersion: 2, designStatus: "ready", faceReferencePath: "/old-face.png", fullBodyReferencePath: "/old-body.png", referenceFingerprint: "old-hash" });
  await db("o_image").insert({ id: 4, assetsId: 10, type: "role", state: "已完成", filePath: "/old.png" });
  await db("o_image").insert({ id: 5, assetsId: options.assetsId ?? 10, type: options.imageType ?? "role", state: options.state ?? "生成失败", filePath: options.filePath === undefined ? "/candidate.png" : options.filePath, errorReason: options.reason ?? failureReason, model: options.model ?? "qwen-image-2.1-fourview-local", resolution: "120x40" });
  const png = await sharp({ create: { width: options.width ?? 120, height: options.height ?? 40, channels: 3, background: "red" } }).png().toBuffer();
  const files = new Map<string, Buffer>([["/old.png", png]]);
  if (!options.missing) files.set("/candidate.png", options.corrupt ? Buffer.from("not an image") : png);
  const referenceCalls: { path: string; layout: string }[] = [];
  const fileReads: string[] = [];
  const u = {
    db, error: (cause: any) => cause,
    oss: {
      getFile: async (path: string) => { fileReads.push(path); const file = files.get(path); if (!file) throw new Error("图片文件不存在"); return file; },
      writeFile: async (path: string, file: Buffer) => { files.set(path, file); },
    },
  };
  const imports: Record<string, unknown> = {
    "@/utils": u,
    "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
    "@/utils/assetReferenceMedia": {
      ensureRoleReferenceMedia: async (path: string, _name: string, layout: string) => { referenceCalls.push({ path, layout }); return [{ path: "/new-face.png" }, { path: "/new-body.png" }]; },
      roleReferenceDatabaseFields: (_references: unknown, layout: string) => ({ faceReferencePath: "/new-face.png", fullBodyReferencePath: "/new-body.png", referenceLayout: layout }),
      roleReferenceFingerprint: async () => "new-hash",
    },
  };
  const localRequire = createRequire(`${process.cwd()}/package.json`), mod = { exports: {} as any };
  const code = transform(readFileSync("src/routes/assets/saveAssets.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => imports[id] || localRequire(id), mod, mod.exports);
  const app = express(); app.use(express.json()); app.use("/", mod.exports.default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  return {
    db, files, referenceCalls, fileReads,
    async request(overrides: Record<string, unknown> = {}) {
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 10, projectId: 1, type: "role", imageId: 5, ...overrides }) });
      return { status: response.status, body: await response.json() };
    },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); },
  };
}

test("explicit human adoption of a reviewed candidate creates a usable copy and preserves the failed receipt", async () => {
  const f = await fixture();
  try {
    const failedBefore = await f.db("o_image").where({ id: 5 }).first();
    const originalBytes = Buffer.from(f.files.get("/candidate.png")!);
    const result = await f.request(); assert.equal(result.status, 200);
    const asset = await f.db("o_assets").where({ id: 10 }).first();
    assert.ok(asset.imageId > 5); assert.equal(asset.imageId, result.body.data.imageId);
    const accepted = await f.db("o_image").where({ id: asset.imageId }).first();
    assert.equal(accepted.state, "已完成"); assert.equal(accepted.assetsId, 10); assert.notEqual(accepted.filePath, "/candidate.png");
    assert.ok(f.files.has(accepted.filePath)); assert.equal(accepted.model, "qwen-image-2.1-fourview-local");
    assert.match(accepted.errorReason, /人工采用审核候选 #5/); assert.match(accepted.errorReason, /服装颜色不符/);
    assert.deepEqual(await f.db("o_image").where({ id: 5 }).first(), failedBefore);
    assert.deepEqual(f.files.get("/candidate.png"), originalBytes);
    assert.equal(asset.prompt, "保留已确认提示词"); assert.equal(asset.designVersion, 3);
    assert.deepEqual(f.referenceCalls, []);
  } finally { await f.close(); }
});

test("existing completed images remain directly selectable without copying or altering their receipt", async () => {
  const f = await fixture({ state: "已完成", reason: "" });
  try {
    const before = await f.db("o_image").select("*");
    const result = await f.request(); assert.equal(result.status, 200);
    assert.equal((await f.db("o_assets").where({ id: 10 }).first()).imageId, 5);
    assert.deepEqual(await f.db("o_image").select("*"), before);
  } finally { await f.close(); }
});

for (const [name, options, overrides] of [
  ["other asset image", { assetsId: 99 }, {}],
  ["other image type", { imageType: "scene" }, {}],
  ["other project", {}, { projectId: 2 }],
  ["wrong asset type", {}, { type: "scene" }],
  ["missing image id", {}, { imageId: 999 }],
  ["zero image id", {}, { imageId: 0 }],
  ["pending generation", { state: "生成中" }, {}],
  ["provider failure", { reason: "生成服务超时" }, {}],
  ["cancelled generation", { reason: "用户取消" }, {}],
  ["empty file path", { filePath: null }, {}],
  ["missing physical file", { missing: true }, {}],
  ["corrupt image file", { corrupt: true }, {}],
] as const) {
  test(`manual adoption rejects ${name} and preserves the selected asset and history`, async () => {
    const f = await fixture(options);
    try {
      const assetsBefore = await f.db("o_assets").select("*");
      const imagesBefore = await f.db("o_image").select("*");
      const fileNamesBefore = Array.from(f.files.keys());
      const result = await f.request(overrides); assert.ok(result.status >= 400);
      assert.deepEqual(await f.db("o_assets").select("*"), assetsBefore);
      assert.deepEqual(await f.db("o_image").select("*"), imagesBefore);
      assert.deepEqual(Array.from(f.files.keys()), fileNamesBefore); assert.deepEqual(f.referenceCalls, []);
    } finally { await f.close(); }
  });
}


for (const model of ["comfyui_local:qwen-image-2.1-fourview-local", "comfyui_local:qwen-image-2.1-local", "another-provider:custom-image-model"]) {
  test(`manual character adoption uses four views for a 16:9 image regardless of model ${model}`, async () => {
    const f = await fixture({ state: "已完成", reason: "", model, width: 2048, height: 1152 });
    try {
      const result = await f.request(); assert.equal(result.status, 200);
      assert.deepEqual(f.referenceCalls, []);
      assert.equal((await f.db("o_assets").where({ id: 10 }).first()).referenceLayout, "four_view");
    } finally { await f.close(); }
  });
}

for (const base64 of [undefined, "", null]) {
  test(`prompt-only saving with base64=${String(base64)} leaves selected image, all references and image history intact`, async () => {
    const f = await fixture();
    try {
      await f.db("o_assets").where({ id: 10 }).update({ referenceLayout: "front_back", sideReferencePath: "/keep-side.png", backReferencePath: "/keep-back.png" });
      const assetBefore = await f.db("o_assets").where({ id: 10 }).first();
      const historyBefore = await f.db("o_image").select("*");
      const filesBefore = [...f.files.entries()].map(([path, bytes]) => [path, Buffer.from(bytes)]);
      const result = await f.request({ imageId: undefined, base64, prompt: "只更新这段文字", referenceLayout: "four_view" });
      assert.equal(result.status, 200); assert.equal(result.body.data.imageId, 4);
      assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), { ...assetBefore, prompt: "只更新这段文字" });
      assert.deepEqual(await f.db("o_image").select("*"), historyBefore);
      assert.deepEqual([...f.files.entries()], filesBefore); assert.deepEqual(f.fileReads, []); assert.deepEqual(f.referenceCalls, []);
    } finally { await f.close(); }
  });
}

test("known legacy two-view layout is preserved only for the same selected image", async () => {
  const f = await fixture({ state: "已完成", reason: "" });
  try {
    await f.db("o_assets").where({ id: 10 }).update({ referenceLayout: "front_back" });
    assert.equal((await f.request({ imageId: 4 })).status, 200);
    assert.deepEqual(f.referenceCalls, []);
    assert.equal((await f.db("o_assets").where({ id: 10 }).first()).referenceLayout, "front_back");
    assert.equal((await f.request({ imageId: 5 })).status, 200);
    assert.deepEqual(f.referenceCalls, []);
    assert.equal((await f.db("o_assets").where({ id: 10 }).first()).referenceLayout, "four_view");
  } finally { await f.close(); }
});

test("legacy callers can explicitly specify two views without an automatic aspect-ratio guess", async () => {
  const f = await fixture({ state: "已完成", reason: "", width: 2048, height: 1152 });
  try {
    assert.equal((await f.request({ referenceLayout: "front_back" })).status, 200);
    assert.deepEqual(f.referenceCalls, []);
    assert.equal((await f.db("o_assets").where({ id: 10 }).first()).referenceLayout, "front_back");
  } finally { await f.close(); }
});

test("uploaded character sheets default to four views without inheriting the previous selected image layout", async () => {
  const f = await fixture();
  try {
    await f.db("o_assets").where({ id: 10 }).update({ referenceLayout: "front_back" });
    const source = f.files.get("/old.png")!;
    const result = await f.request({ imageId: undefined, base64: `data:image/png;base64,${source.toString("base64")}` });
    assert.equal(result.status, 200); assert.ok(result.body.data.imageId > 5);
    assert.deepEqual(f.referenceCalls, []);
    assert.equal((await f.db("o_assets").where({ id: 10 }).first()).referenceLayout, "four_view");
  } finally { await f.close(); }
});
