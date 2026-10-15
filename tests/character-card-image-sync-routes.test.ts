import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { transform } from "sucrase";
import knex from "knex";
import { validateFields } from "../src/middleware/middleware";
import * as descriptions from "../src/utils/assetDescriptionVersion";
import * as sync from "../src/utils/characterCardAssetImageSync";
import { getCharacterCard, listCharacterCardImages, migrateCharacterCards, saveCharacterCard } from "../src/utils/characterCards";
import { loadAssetPromptContext } from "../src/utils/assetPromptGeneration";
import { getOperationReceipt, withOperationReceipt } from "../src/utils/agent/runtime/operationReceipt";

type Mode = "single" | "batch" | "production" | "adoption" | "upload";
const routes: Record<Mode, string> = { single: "assetsGenerate/generateAssets", batch: "assetsGenerate/batchGenerateImageAssets",
  production: "production/assets/batchGenerateAssetsImage", adoption: "assets/saveAssets", upload: "assets/saveAssets" };
const visual = { face: "自然椭圆脸，清晰眉眼", body: "自然比例，肩线舒展", hair: "黑色长发",
  clothing: "白色翻领衬衫、灰色长裤与黑色平底鞋", environment: "", shape: "" };

async function fixture(t: TestContext, mode: Mode) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_project", table => {
    table.integer("id"); table.integer("userId"); for (const field of ["artStyle", "type", "intro", "imageModel", "imageQuality"]) table.text(field);
  });
  await db.schema.createTable("o_script", table => { table.integer("id"); table.integer("projectId"); });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); });
  await db.schema.createTable("o_assets", table => {
    table.integer("id").primary(); for (const field of ["projectId", "assetsId", "imageId", "designVersion"]) table.integer(field);
    for (const field of ["type", "name", "describe", "prompt", "promptState", "promptErrorReason", "designStatus", "referenceLayout", "referenceFingerprint"]) table.text(field);
  });
  await db.schema.createTable("o_image", table => {
    table.increments("id"); table.integer("assetsId"); for (const field of ["type", "state", "filePath", "model", "resolution", "errorReason"]) table.text(field);
  });
  await db.schema.createTable("o_agentWorkData", table => {
    table.integer("id").primary(); for (const field of ["projectId", "episodesId", "createTime", "updateTime"]) table.integer(field);
    table.text("key"); table.text("data");
  });
  await descriptions.migrateAssetDescriptions(db); await migrateCharacterCards(db);
  const card = await saveCharacterCard(db, { name: "人物参考卡", artStyle: "realistic_3d_anime", roleDefinition: "女性，黑色长发，日常人物",
    ageBand: "unknown", gender: "female", visualDesign: visual }, 1);
  await db("o_project").insert({ id: 7, userId: 1, artStyle: "realistic_3d_anime", imageModel: "mock:image", imageQuality: "1K" });
  await db("o_script").insert({ id: 20, projectId: 7 }); await db("o_scriptAssets").insert({ scriptId: 20, assetId: 10 });
  await db("o_image").insert({ id: 40, assetsId: 10, type: "role", state: "已完成", filePath: "/old-paid.jpg", descriptionVersion: 2 });
  await db("o_assets").insert({ id: 10, projectId: 7, type: "role", name: "艾娃", describe: "当前人物描述", prompt: "当前图片提示词", promptState: "已完成",
    descriptionVersion: 2, promptDescriptionVersion: 2, imageDescriptionVersion: 2, imageId: 40, designVersion: 1,
    descriptionMeta: JSON.stringify({ visualDesign: visual, userConstraints: "保留黑色长发", characterCard: { cardId: card.id, version: 1 } }) });
  let renders = 0;
  const warnings: unknown[] = []; t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  const imageClass = { async run() { renders++; return this; }, async save() { return this; } };
  const u = { db, uuid: randomUUID, getArtPrompt: () => "当前美术手册", error: (cause: any) => ({ message: cause.message }),
    oss: { getFile: async () => Buffer.from("fake-image"), writeFile: async () => {}, getSmallImageUrl: async (path: string) => path,
      getImageBase64: async () => "data:image/png;base64,ZmFrZS1pbWFnZQ==" },
    Ai: { Image: () => imageClass, Text: () => ({ invoke: async () => { throw new Error("unexpected text provider call"); } }) } };
  const imports: Record<string, unknown> = {
    "@/utils": u, "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
    "@/utils/assetDescriptionVersion": descriptions, "@/utils/characterCardAssetImageSync": sync,
    "@/utils/agent/runtime/operationReceipt": { getOperationReceipt, withOperationReceipt },
    "@/utils/assetImageModel": { resolveAssetImageModel: async () => "comfyui_qwen21_fourview:qwen-image-2.1-fourview-local", isRoleFourViewModel: () => true },
    "@/utils/assetPrompt": { buildAssetImagePrompt: () => "图片提示词", needsFluxPromptTranslation: () => false },
    "@/utils/assetReferenceMedia": { roleReferenceFingerprint: async () => "image-fingerprint" },
    "@/utils/assetPromptGeneration": { loadAssetPromptContext, generateAssetPrompt: async () => "当前图片提示词" },
    sharp: () => ({ metadata: async () => ({ width: 2560, height: 960 }), png: () => ({ toBuffer: async () => Buffer.from("fake-image") }) }),
  };
  const localRequire = createRequire(process.cwd() + "/package.json"), mod = { exports: {} as any };
  const code = transform(readFileSync(`src/routes/${routes[mode]}.ts`, "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => imports[id] ?? localRequire(id), mod, mod.exports);
  const handler = mod.exports.default.stack.find((layer: any) => layer.route).route.stack.at(-1).handle;
  let status = 200, response: any;
  const res = { status(code: number) { status = code; return this; }, send(body: unknown) { response = body; return this; } };
  const item = { id: 10, type: "role", name: "艾娃", prompt: "当前图片提示词" };
  const body = mode === "production" ? { projectId: 7, scriptId: 20, assetIds: [10], concurrentCount: 1, requestId: "sync_image_route_1234" }
    : mode === "adoption" || mode === "upload" ? { projectId: 7, id: 10, type: "role", ...(mode === "adoption" ? { imageId: 40 } : { base64: "data:image/png;base64,ZmFrZS1pbWFnZQ==" }) }
    : { projectId: 7, model: "requested", resolution: "1K", ...(mode === "single" ? item : { items: [item] }) };
  await handler({ body }, res);
  if (mode === "batch") for (let index = 0; index < 100; index++) {
    if ((await getCharacterCard(db, card.id, 1))?.version === 2) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { db, card, warnings, status, response, renders };
}

for (const mode of ["single", "batch", "production", "adoption", "upload"] as const) {
  test(`${mode} actual image route synchronizes only the completed selected project image into its matching bound card`, async t => {
    const f = await fixture(t, mode);
    assert.equal(f.status, 200, JSON.stringify(f.response)); assert.equal(f.warnings.length, 0);
    const asset = await f.db("o_assets").where({ id: 10 }).first(), meta = JSON.parse(asset.descriptionMeta);
    const card = await getCharacterCard(f.db, f.card.id, 1), image = await f.db("o_image").where({ id: asset.imageId }).first();
    assert.equal(card?.version, 2); assert.equal(meta.characterCard.version, 2);
    assert.equal(card?.imagePath, image.filePath); assert.equal(card?.imageState, "ready");
    const attempts = await listCharacterCardImages(f.db, f.card.id, 1);
    assert.equal(attempts.length, 1); assert.equal(attempts[0].sourceImageId, image.id); assert.equal(attempts[0].state, "completed");
    assert.equal(image.state, "已完成"); assert.equal((await getCharacterCard(f.db, f.card.id, 1, 1))?.imagePath, null);
    assert.equal((await f.db("o_image").where({ id: 40 }).first()).filePath, "/old-paid.jpg");
    assert.equal(f.renders, mode === "adoption" || mode === "upload" ? 0 : 1, "card sync never creates an extra render");
  });
}
