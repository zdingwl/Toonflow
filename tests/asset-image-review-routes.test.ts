import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import { validateFields } from "../src/middleware/middleware";

type Mode = "single" | "batch";
async function fixture(mode: Mode, options: { reject?: boolean; derivative?: boolean } = {}) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_project", t => { t.integer("id"); t.text("artStyle"); t.text("type"); t.text("intro"); });
  await db.schema.createTable("o_assets", t => {
    for (const key of ["id", "projectId", "assetsId", "imageId", "designVersion"]) t.integer(key);
    for (const key of ["type", "name", "describe", "designStatus", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath", "referenceLayout", "referenceFingerprint"]) t.text(key);
  });
  await db.schema.createTable("o_image", t => {
    t.increments("id"); t.integer("assetsId");
    for (const key of ["type", "state", "model", "resolution", "filePath", "errorReason"]) t.text(key);
  });
  await db("o_project").insert({ id: 1, artStyle: "realistic_3d_anime" });
  await db("o_image").insert({ id: 4, assetsId: 10, state: "已完成", filePath: "/old.jpg" });
  await db("o_assets").insert({ id: 10, projectId: 1, type: "role", name: "Ava", describe: "数据库中的当前角色设定", assetsId: options.derivative ? 9 : null, imageId: 4, designVersion: 3, designStatus: "ready", faceReferencePath: "/old-face.png", fullBodyReferencePath: "/old-body.png", referenceFingerprint: "old-hash" });
  const events: string[] = [], contexts: any[] = [];
  const u = {
    db, error: (e: any) => e,
    oss: { getFile: async () => Buffer.from("image"), getImageBase64: async () => "data:image/png;base64,aW1hZ2U=", getSmallImageUrl: async (path: string) => path },
    Ai: {
      Image: () => ({ run: async () => { events.push("generate"); }, save: async () => { events.push("save"); } }),
      Text: () => ({ invoke: async () => ({ text: "unused" }) }),
    },
  };
  const imports: Record<string, unknown> = {
    "@/utils": u,
    "sharp": () => ({ metadata: async () => ({ width: 1200, height: 400 }) }),
    "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
    "@/utils/assetImageModel": { resolveAssetImageModel: async () => "comfyui_local:qwen-four-view", isRoleFourViewModel: () => true },
    "@/utils/assetPrompt": { buildAssetImagePrompt: () => "unused", needsFluxPromptTranslation: () => false },
    "@/utils/assetPromptGeneration": {
      loadAssetPromptContext: async (_db: unknown, input: any) => { contexts.push(input); return input; },
      reviewAssetImage: async (_deps: unknown, _context: unknown, prompt: string, candidate: string) => {
        assert.equal(prompt, "红上衣和黑短裙");
        assert.equal((await db("o_image").where({ filePath: candidate }).first()).state, "生成中");
        assert.equal((await db("o_assets").where({ id: 10 }).first()).imageId, 4);
        events.push("review");
        if (options.reject) throw new Error("图文一致性审核未通过：服装不符");
      },
    },
    "@/utils/assetReferenceMedia": {
      ensureRoleReferenceMedia: async () => { events.push("references"); return [{ path: "/new-face.png" }, { path: "/new-body.png" }]; },
      roleReferenceDatabaseFields: () => ({ faceReferencePath: "/new-face.png", fullBodyReferencePath: "/new-body.png" }),
      roleReferenceFingerprint: async () => "new-hash",
    },
  };
  const localRequire = createRequire(`${process.cwd()}/package.json`), mod = { exports: {} as any };
  const route = mode === "single" ? "generateAssets" : "batchGenerateImageAssets";
  const code = transform(readFileSync(`src/routes/assetsGenerate/${route}.ts`, "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => imports[id] || localRequire(id), mod, mod.exports);
  const app = express(); app.use(express.json()); app.use("/", mod.exports.default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  return {
    db, events, contexts,
    async request(overrides: Record<string, unknown> = {}) {
      const item = { id: 10, type: "role", name: "客户端名称", prompt: "红上衣和黑短裙", ...overrides };
      const request = { projectId: 1, model: "qwen", resolution: "1024", ...(mode === "single" ? item : { items: [item] }) };
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const body = await response.json();
      if (mode === "batch" && response.ok) {
        for (let i = 0; i < 100; i++) {
          const latest = await db("o_image").where("id", ">", 4).first();
          if (latest && latest.state !== "生成中") break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      return { status: response.status, body };
    },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); },
  };
}

for (const mode of ["single", "batch"] as Mode[]) {
  test(`${mode} image review rejects a candidate without replacing the selected image or references`, async () => {
    const f = await fixture(mode, { reject: true });
    try {
      const before = await f.db("o_assets").where({ id: 10 }).first();
      const result = await f.request();
      assert.equal(result.status, mode === "single" ? 400 : 200);
      assert.deepEqual(await f.db("o_assets").where({ id: 10 }).first(), before);
      const candidate = await f.db("o_image").where("id", ">", 4).first();
      assert.equal(candidate.state, "生成失败"); assert.match(candidate.errorReason, /服装不符/); assert.match(candidate.filePath, /\.jpg$/);
      assert.deepEqual(f.events, ["generate", "save", "review"]);
      assert.equal(f.contexts[0].describe, "数据库中的当前角色设定"); assert.equal(f.contexts[0].name, "Ava");
    } finally { await f.close(); }
  });

  test(`${mode} image adoption and reference crops happen only after the candidate passes review`, async () => {
    const f = await fixture(mode);
    try {
      const result = await f.request(); assert.equal(result.status, 200);
      const asset = await f.db("o_assets").where({ id: 10 }).first();
      const candidate = await f.db("o_image").where("id", ">", 4).first();
      assert.equal(candidate.state, "已完成"); assert.equal(asset.imageId, candidate.id); assert.equal(asset.designVersion, 4);
      assert.equal(asset.faceReferencePath, "/new-face.png"); assert.deepEqual(f.events, ["generate", "save", "review", "references"]);
    } finally { await f.close(); }
  });

  test(`${mode} generation rejects a mismatched asset type before creating an image attempt`, async () => {
    const f = await fixture(mode);
    try {
      const result = await f.request({ type: "scene" }); assert.ok(result.status >= 400);
      assert.equal((await f.db("o_image")).length, 1); assert.deepEqual(f.events, []);
    } finally { await f.close(); }
  });

  test(`${mode} Qwen derivative generation requires an explicit identity anchor`, async () => {
    const f = await fixture(mode, { derivative: true });
    try {
      const result = await f.request(); assert.equal(result.status, 400); assert.match(result.body.message, /衍生形态必须传入/);
      assert.equal((await f.db("o_image")).length, 1); assert.deepEqual(f.events, []);
    } finally { await f.close(); }
  });
}
