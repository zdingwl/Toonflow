import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import * as languages from "../src/utils/videoLanguages";
import { validateFields } from "../src/middleware/middleware";

const requireModule = createRequire(import.meta.url);
test("real video routes keep each language prompt, video ID and selection separate (mock provider)", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_project", (t) => {
    t.integer("id");
    t.text("videoRatio");
  });
  await db.schema.createTable("o_videoTrack", (t) => {
    t.integer("id");
    t.integer("projectId");
    t.integer("scriptId");
    t.text("prompt");
    t.text("state");
    t.integer("videoId");
    t.integer("duration");
    t.text("reason");
  });
  await db.schema.createTable("o_assets", (t) => { t.integer("id"); t.integer("assetsId"); });
  await db.schema.createTable("o_assetsRole2Audio", (t) => { t.integer("assetsAudioId"); t.integer("assetsRoleId"); });
  await db.schema.createTable("o_prompt", (t) => { t.text("type"); t.text("data"); t.text("useData"); });
  await db.schema.createTable("o_modelPrompt", (t) => { t.text("vendorId"); t.text("model"); t.text("path"); });
  await db.schema.createTable("o_video", (t) => {
    t.increments("id");
    t.text("filePath");
    t.bigInteger("time");
    t.text("state");
    t.text("errorReason");
    t.integer("projectId");
    t.integer("scriptId");
    t.integer("videoTrackId");
  });
  await languages.migrateVideoLanguages(db);
  await db("o_project").insert({ id: 7, videoRatio: "16:9" });
  await db("o_videoTrack").insert({ id: 1, projectId: 7, scriptId: 2, prompt: "original", videoId: 88 });
  await db("o_videoPromptVariant").insert([
    { trackId: 1, language: "en-US", prompt: "English dialogue: Hello", state: "已完成" },
    { trackId: 1, language: "ja-JP", prompt: "Japanese dialogue: こんにちは", state: "已完成" },
  ]);
  const submitted: any[] = [];
  const textCalls: any[] = [];
  let running = 0,
    maxRunning = 0;
  const u = {
    db,
    error: (e: any) => e,
    getArtPrompt: () => "current modern donghua visual manual",
    getPath: () => "data/modelPrompt",
    oss: { getImageBase64: async () => "" },
    Ai: {
      Text: () => ({ invoke: async (request: any) => {
        textCalls.push(request);
        return { text: request.messages.some((m: any) => m.content === "current modern donghua visual manual") ? "fresh base from visual manual" : "refreshed English" };
      } }),
      Video: () => ({
        run: async (request: any) => {
          submitted.push(request);
          running++;
          maxRunning = Math.max(maxRunning, running);
        },
        save: async () => {
          running--;
        },
      }),
    },
  };
  const app = express();
  app.use(express.json());
  for (const name of ["generateVideoPrompt", "generateVideo", "batchGenerateVideo", "updateVideoPrompt", "selectVideo", "saveDialogueLanguages"]) {
    const source = readFileSync(new URL(`../src/routes/production/workbench/${name}.ts`, import.meta.url), "utf8");
    const code = transform(source, { transforms: ["typescript", "imports"] }).code;
    const mod = { exports: {} as any };
    const imports: Record<string, unknown> = {
      "@/utils": u,
      "@/utils/db": { db },
      "@/utils/videoLanguages": languages,
      "@/middleware/middleware": { validateFields },
      "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
      "@/utils/assetReferenceMedia": { persistedRoleReferencesForVideo: async (item: unknown) => [item] },
      "@/utils/videoQuality": { inspectVideoQuality: async () => ({}) },
      "@/utils/h3VisualStateGuard": { assertH3ActiveStates: () => {}, assertH3PictureSlots: () => {} },
      "@/utils/h3ReferenceSlots": { expandH3AssetSlots: (items: unknown) => items },
    };
    new Function("require", "module", "exports", code)((id: string) => imports[id] || requireModule(id), mod, mod.exports);
    app.use(`/${name}`, mod.exports.default);
  }
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (name: string, body: unknown) => {
    const response = await fetch(`${baseUrl}/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any };
  };
  const settings = { projectId: 7, scriptId: 2, model: "test:MiniMax-H3-local", mode: "text", resolution: "768p", audio: true };
  try {
    const refreshBody = { projectId: 7, trackId: 1, languages: ["en-US"], info: [], model: "test:plain", mode: "text", regenerate: true };
    const refreshed = await post("generateVideoPrompt", refreshBody);
    assert.equal(refreshed.status, 200);
    assert.equal(textCalls.length, 2);
    assert.equal(textCalls[1].messages[0].content, "fresh base from visual manual");
    assert.equal(refreshed.body.data.find((v: any) => v.language === "en-US").prompt, "refreshed English");
    assert.equal((await db("o_videoTrack").first()).prompt, "original");
    assert.equal((await post("generateVideoPrompt", { ...refreshBody, regenerate: false })).status, 200);
    assert.equal(textCalls.length, 2);
    await db("o_videoPromptVariant").where({ language: "en-US" }).update({ prompt: "English dialogue: Hello" });
    assert.equal((await post("saveDialogueLanguages", { ...settings, languages: ["en-US", "ja-JP"] })).status, 200);
    assert.deepEqual(JSON.parse((await db("o_videoLanguageSelection").first()).languages), ["en-US", "ja-JP"]);
    const rejected = await post("batchGenerateVideo", {
      ...settings,
      trackData: [
        { trackId: 1, prompt: "wrong", language: "en-US", duration: 5, uploadData: [] },
        { trackId: 1, prompt: "wrong", language: "fr-FR", duration: 5, uploadData: [] },
      ],
    });
    assert.equal(rejected.status, 409);
    assert.equal((await db("o_video")).length, 0);
    const batch = await post("batchGenerateVideo", {
      ...settings,
      trackData: ["en-US", "ja-JP"].map((language) => ({ trackId: 1, prompt: "wrong client value", language, duration: 5, uploadData: [] })),
    });
    assert.equal(batch.status, 200);
    assert.equal(new Set(batch.body.data.map((v: any) => v.videoId)).size, 2);
    for (let i = 0; i < 50 && (await db("o_video").where({ state: "生成中" })).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(submitted.length, 2);
    assert.equal(maxRunning, 1);
    assert.match(submitted[0].prompt, /English/);
    assert.match(submitted[1].prompt, /Japanese/);
    assert.ok((await db("o_video")).every((row) => row.state === "生成成功"));
    assert.equal((await db("o_videoLanguage")).length, 2);
    await post("selectVideo", { trackId: 1, videoId: batch.body.data[1].videoId });
    assert.equal((await db("o_videoPromptVariant").where({ language: "ja-JP" }).first()).videoId, batch.body.data[1].videoId);
    assert.equal((await db("o_videoTrack").first()).videoId, 88);
    await post("updateVideoPrompt", { id: 1, language: "en-US", prompt: "Edited English" });
    assert.equal((await db("o_videoTrack").first()).prompt, "original");
    assert.match((await db("o_videoPromptVariant").where({ language: "ja-JP" }).first()).prompt, /Japanese/);
    const single = await post("generateVideo", { ...settings, trackId: 1, language: "en-US", prompt: "wrong", uploadData: [], duration: 5 });
    assert.equal(single.status, 200);
    for (let i = 0; i < 50 && (await db("o_video").where({ state: "生成中" })).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(submitted[2].prompt, "Edited English");
    assert.equal((await db("o_videoLanguage").where({ videoId: single.body.data }).first()).language, "en-US");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.destroy();
  }
});
