import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import sharp from "sharp";
import { validateFields } from "../src/middleware/middleware";

const colors = [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }, { r: 255, g: 255, b: 0 }];
const referenceFields = ["faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath"];
interface Options {
  model?: string | null; layout?: string | null; state?: string; imageType?: string; imageAssetsId?: number;
  width?: number; height?: number; corrupt?: boolean; fileMissing?: boolean; failWrite?: boolean;
  changeSelectionDuringCrop?: boolean;
}

async function fixture(options: Options = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_assets", table => {
    for (const name of ["id", "projectId", "imageId", "designVersion"]) table.integer(name);
    for (const name of ["type", "name", "prompt", "designStatus", "referenceLayout", "referenceFingerprint", ...referenceFields]) table.text(name);
  });
  await db.schema.createTable("o_image", table => {
    table.integer("id"); table.integer("assetsId");
    for (const name of ["filePath", "state", "type", "model", "errorReason"]) table.text(name);
  });
  await db("o_assets").insert({
    id: 10, projectId: 1, imageId: 40, type: "role", name: "Ava", prompt: "保留人物原提示词", designVersion: 7,
    designStatus: "ready", referenceLayout: options.layout ?? null, referenceFingerprint: "previous-hash",
    ...Object.fromEntries(referenceFields.map(name => [name, "/old-" + name + ".png"])),
  });
  await db("o_image").insert([
    { id: 40, assetsId: options.imageAssetsId ?? 10, filePath: "/selected.png", state: options.state ?? "已完成", type: options.imageType ?? "role", model: options.model === undefined ? "legacy-unclassified-model" : options.model, errorReason: "历史审核回执必须保留" },
    { id: 41, assetsId: 10, filePath: "/replacement.png", state: "已完成", type: "role", model: "qwen-image-2.1-fourview-local", errorReason: "replacement receipt" },
  ]);
  const width = options.width ?? 2048, height = options.height ?? 1152;
  const panelWidth = Math.floor(width / 4);
  const panels = await Promise.all(colors.map(background => sharp({ create: { width: panelWidth, height, channels: 3, background } }).png().toBuffer()));
  const source = options.corrupt ? Buffer.from("not-a-readable-image") : await sharp({ create: { width, height, channels: 3, background: "white" } })
    .composite(panels.map((input, index) => ({ input, left: index * panelWidth, top: 0 }))).png().toBuffer();
  const files = new Map<string, Buffer>();
  if (!(options as Options).fileMissing) files.set("/selected.png", source);
  const reads: string[] = [], writes: string[] = [];
  let changed = false;
  const oss = {
    getFile: async (path: string) => { reads.push(path); const buffer = files.get(path); if (!buffer) throw new Error("原图文件不存在"); return buffer; },
    writeFile: async (path: string, buffer: Buffer) => {
      writes.push(path);
      if (options.failWrite) throw new Error("参考图写入失败");
      files.set(path, Buffer.from(buffer));
      if (options.changeSelectionDuringCrop && !changed) {
        changed = true;
        await db("o_assets").where({ id: 10 }).update({ imageId: 41, referenceLayout: "four_view", referenceFingerprint: "new-selection-hash", designVersion: 12,
          ...Object.fromEntries(referenceFields.map(name => [name, "/new-selection-" + name + ".png"])) });
      }
    },
    getFileUrl: async (path: string) => "/oss/" + path.replace(/^\/+/, ""),
  };
  const localRequire = createRequire(process.cwd() + "/package.json");
  const media = { exports: {} as any };
  new Function("require", "module", "exports", transform(readFileSync("src/utils/assetReferenceMedia.ts", "utf8"), { transforms: ["typescript", "imports"] }).code)
    ((id: string) => id === "@/utils/oss" ? oss : localRequire(id), media, media.exports);
  const imports: Record<string, unknown> = {
    "@/utils": { db, oss, error: (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause)) },
    "@/utils/assetReferenceMedia": media.exports,
    "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
  };
  const route = { exports: {} as any };
  new Function("require", "module", "exports", transform(readFileSync("src/routes/assetsGenerate/buildRoleReferences.ts", "utf8"), { transforms: ["typescript", "imports"] }).code)
    ((id: string) => imports[id] || localRequire(id), route, route.exports);
  const app = express(); app.use(express.json()); app.use("/", route.exports.default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  return {
    db, files, source, reads, writes,
    request: async (body: Record<string, unknown> = {}) => {
      const response = await fetch("http://127.0.0.1:" + (server.address() as any).port, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: 1, assetsId: 10, ...body }) });
      return { status: response.status, body: await response.json() as any };
    },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); },
  };
}

async function assertFourPanels(f: Awaited<ReturnType<typeof fixture>>) {
  const asset = await f.db("o_assets").where({ id: 10 }).first();
  assert.equal(asset.referenceLayout, "four_view");
  for (const [index, field] of referenceFields.entries()) {
    const bytes = f.files.get(asset[field]); assert.ok(bytes, field + " has a stored crop");
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 512); assert.equal(metadata.height, 1152);
    const pixel = await sharp(bytes).removeAlpha().extract({ left: 256, top: 576, width: 1, height: 1 }).raw().toBuffer();
    assert.deepEqual([...pixel], Object.values(colors[index]), field + " uses the correct panel");
  }
}

test("explicit four_view rebuild correctly crops a 2048x1152 historical sheet and preserves selected image, prompt, source bytes and receipts", async () => {
  const f = await fixture();
  try {
    const imagesBefore = await f.db("o_image").orderBy("id");
    const response = await f.request({ referenceLayout: "four_view" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await assertFourPanels(f);
    const updated = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal(updated.imageId, 40); assert.equal(updated.prompt, "保留人物原提示词");
    assert.equal(updated.designStatus, "ready"); assert.equal(updated.designVersion, 8);
    assert.equal(updated.referenceFingerprint, createHash("sha256").update(f.source).digest("hex"));
    assert.deepEqual(f.files.get("/selected.png"), f.source); assert.deepEqual(await f.db("o_image").orderBy("id"), imagesBefore);
    assert.equal(f.writes.length, 4);
    assert.ok(response.body.data.sideReferenceUrl); assert.ok(response.body.data.backReferenceUrl);
  } finally { await f.close(); }
});

for (const model of ["qwen-image-2.1-fourview-local", "comfyui_qwen21_fourview:qwen-image-2.1-fourview-local", "provider:deployment:qwen-image-2.1-fourview-local"]) {
  test("model naming does not change the default four-panel rebuild for " + model, async () => {
    const f = await fixture({ model });
    try { const result = await f.request(); assert.equal(result.status, 200, JSON.stringify(result.body)); await assertFourPanels(f); }
    finally { await f.close(); }
  });
}

test("persisted four_view is authoritative for an otherwise unknown image model", async () => {
  const f = await fixture({ layout: "four_view", model: "manual-upload" });
  try { const result = await f.request(); assert.equal(result.status, 200, JSON.stringify(result.body)); await assertFourPanels(f); }
  finally { await f.close(); }
});

for (const explicit of [false, true]) {
  test((explicit ? "explicit" : "persisted") + " front_back overrides model or panorama ratio and clears a stale side crop", async () => {
    const f = await fixture({ model: "comfyui_qwen21_fourview:qwen-image-2.1-fourview-local", layout: explicit ? "four_view" : "front_back", width: 2400, height: 600 });
    try {
      const result = await f.request(explicit ? { referenceLayout: "front_back" } : {});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const asset = await f.db("o_assets").where({ id: 10 }).first();
      assert.equal(asset.referenceLayout, "front_back"); assert.equal(asset.sideReferencePath, null); assert.equal(f.writes.length, 3);
      const front = await sharp(f.files.get(asset.fullBodyReferencePath)).metadata();
      const back = await sharp(f.files.get(asset.backReferencePath)).metadata();
      const face = await sharp(f.files.get(asset.faceReferencePath)).metadata();
      assert.deepEqual([front.width, front.height, back.width, back.height], [1200, 600, 1200, 600]);
      assert.deepEqual([face.width, face.height], [1200, 276]);
    } finally { await f.close(); }
  });
}

test("explicit four_view overrides a stale persisted front_back value", async () => {
  const f = await fixture({ layout: "front_back" });
  try { const result = await f.request({ referenceLayout: "four_view" }); assert.equal(result.status, 200, JSON.stringify(result.body)); await assertFourPanels(f); }
  finally { await f.close(); }
});

for (const model of ["unknown-model", "qwen-image-2.1-fourview-local-custom", null]) {
  test("missing layout defaults to four_view regardless of model " + model + " or panorama ratio", async () => {
    const f = await fixture({ model, width: 2400, height: 600 });
    try {
      const result = await f.request(); assert.equal(result.status, 200, JSON.stringify(result.body));
      const asset = await f.db("o_assets").first();
      assert.equal(asset.referenceLayout, "four_view"); assert.equal(f.writes.length, 4);
      for (const [index, field] of referenceFields.entries()) {
        const bytes = f.files.get(asset[field]); assert.ok(bytes);
        const metadata = await sharp(bytes).metadata();
        assert.deepEqual([metadata.width, metadata.height], [600, 600]);
        const pixel = await sharp(bytes).removeAlpha().extract({ left: 300, top: 300, width: 1, height: 1 }).raw().toBuffer();
        assert.deepEqual([...pixel], Object.values(colors[index]));
      }
    } finally { await f.close(); }
  });
}

for (const [name, options, body] of [
  ["failed review candidate", { state: "生成失败" }, {}],
  ["pending image", { state: "生成中" }, {}],
  ["image from another asset", { imageAssetsId: 99 }, {}],
  ["non-role image", { imageType: "scene" }, {}],
  ["different project", {}, { projectId: 2 }],
  ["invalid layout", {}, { referenceLayout: "auto" }],
] as const) {
  test("rebuild rejects " + name + " before reading or writing files", async () => {
    const f = await fixture(options);
    try {
      const assetBefore = await f.db("o_assets").first(), imagesBefore = await f.db("o_image").orderBy("id");
      const result = await f.request({ referenceLayout: "four_view", ...body }); assert.ok(result.status >= 400, JSON.stringify(result.body));
      assert.deepEqual(await f.db("o_assets").first(), assetBefore); assert.deepEqual(await f.db("o_image").orderBy("id"), imagesBefore);
      assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
    } finally { await f.close(); }
  });
}

for (const [name, options] of [["missing source", { fileMissing: true }], ["corrupt source", { corrupt: true }], ["crop write failure", { failWrite: true }]] as const) {
  test(name + " leaves stored references and image history untouched", async () => {
    const f = await fixture(options);
    try {
      const assetBefore = await f.db("o_assets").first(), imagesBefore = await f.db("o_image").orderBy("id");
      const result = await f.request({ referenceLayout: "four_view" }); assert.ok(result.status >= 400, JSON.stringify(result.body));
      assert.deepEqual(await f.db("o_assets").first(), assetBefore); assert.deepEqual(await f.db("o_image").orderBy("id"), imagesBefore);
      if (!options.fileMissing) assert.deepEqual(f.files.get("/selected.png"), f.source);
    } finally { await f.close(); }
  });
}

test("selection changed while cropping returns 409 and retains all fields of the newer selection", async () => {
  const f = await fixture({ changeSelectionDuringCrop: true });
  try {
    const imagesBefore = await f.db("o_image").orderBy("id");
    const result = await f.request({ referenceLayout: "four_view" });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    const asset = await f.db("o_assets").where({ id: 10 }).first();
    assert.equal(asset.imageId, 41); assert.equal(asset.designVersion, 12); assert.equal(asset.referenceFingerprint, "new-selection-hash");
    for (const field of referenceFields) assert.equal(asset[field], "/new-selection-" + field + ".png");
    assert.equal(asset.prompt, "保留人物原提示词"); assert.deepEqual(await f.db("o_image").orderBy("id"), imagesBefore);
  } finally { await f.close(); }
});
