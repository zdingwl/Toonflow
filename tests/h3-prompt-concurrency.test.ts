import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import * as languages from "../src/utils/videoLanguages";
import * as contract from "../src/utils/h3PromptContract";
import * as slots from "../src/utils/h3ReferenceSlots";
import * as plans from "../src/utils/h3ReferencePlan";
import * as guards from "../src/utils/h3VisualStateGuard";
import { validateFields } from "../src/middleware/middleware";

const validPrompt = [
  "subject_definitions:", "<Subject 1> is Ava from the character sheet in <Picture 1>, with a red sweater and black skirt.",
  "summary:", "[reference generation] <Subject 1> stands on deck.",
  "retention_analysis:", "<Subject 1> (appears in [Shot 1]): fully_preserved - Face and wardrobe retained.",
  "detailed_description:", "Detailed stylized 3D with fine hair and skin texture.", "[Shot 1] <Subject 1> stands still.",
  "overall_soundscape:", "Wind.", "non_diegetic_music:", "N/A",
].join("\n");

async function fixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  for (const [name, columns] of Object.entries({
    o_project: ["id", "artStyle"], o_videoTrack: ["id", "projectId", "prompt", "duration", "state", "reason"],
    o_assets: ["id", "projectId", "assetsId", "type", "name", "describe", "prompt", "imageId", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath"],
    o_image: ["id", "filePath"], o_assetsRole2Audio: ["assetsRoleId", "assetsAudioId"],
    o_prompt: ["type", "data", "useData"], o_modelPrompt: ["vendorId", "model", "path"],
  })) await db.schema.createTable(name, table => columns.forEach(column => ["id", "projectId", "imageId"].includes(column) ? table.integer(column) : table.text(column)));
  await languages.migrateVideoLanguages(db);
  await db("o_project").insert({ id: 1, artStyle: "realistic_3d_anime" });
  await db("o_videoTrack").insert({ id: 2, projectId: 1, prompt: "original prompt", duration: 6, state: "已完成" });
  await db("o_image").insert({ id: 3, filePath: "sheet.png" });
  await db("o_assets").insert({ id: 4, projectId: 1, type: "role", name: "Ava", imageId: 3, faceReferencePath: "face.png", fullBodyReferencePath: "body.png" });
  let release!: () => void, entered!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstCall = new Promise<void>(resolve => { entered = resolve; });
  const u = { db, error: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    getArtPrompt: () => "Detailed stylized 3D.", getPath: () => "data/modelPrompt",
    oss: { getImageBase64: async (path: string) => "data:image/png;base64," + Buffer.from(path).toString("base64") },
    Ai: { Text: () => ({ invoke: async (request: any) => {
      if (String(request.system).startsWith("H3_SEMANTIC_REVIEW")) return { text: '{"issues":[]}' };
      calls++;
      if (calls === 1) { entered(); await held; }
      return { text: validPrompt };
    } }) },
  };
  const imports: Record<string, unknown> = {
    "@/utils": u, "@/utils/db": { db }, "@/utils/videoLanguages": languages,
    "@/utils/h3PromptContract": contract, "@/utils/h3ReferenceSlots": slots,
    "@/utils/h3ReferencePlan": plans, "@/utils/h3VisualStateGuard": guards,
    "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }), error: (message: string) => ({ message }) },
  };
  const localRequire = createRequire(process.cwd() + "/package.json");
  const load = (file: string) => {
    const mod = { exports: {} as any };
    new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)((id: string) => imports[id] || localRequire(id), mod, mod.exports);
    return mod.exports;
  };
  const service = load("src/utils/videoPromptGeneration.ts");
  imports["@/utils/videoPromptGeneration"] = service;
  const app = express(); app.use(express.json());
  for (const name of ["generateVideoPrompt", "batchGeneratePrompt", "updateVideoPrompt"]) app.use("/" + name, load("src/routes/production/workbench/" + name + ".ts").default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  return {
    db, release, firstCall, callCount: () => calls,
    running: () => service.isVideoPromptRunning(2),
    post: async (route: string, body: unknown) => {
      const response = await fetch(url + "/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    },
    finish: async () => {
      release();
      for (let attempt = 0; attempt < 100 && (await db("o_videoTrack").where({ id: 2 }).first()).state === "生成中"; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    },
    close: async () => { release(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); },
  };
}

const info = [{ id: 4, sources: "assets" }];
const settings = { projectId: 1, model: "test:MiniMax-H3-local", mode: '["imageReference:9"]' };
const bodyFor = (route: string) => route === "generateVideoPrompt" ? { ...settings, trackId: 2, info } : { ...settings, trackData: [{ trackId: 2, info }], concurrentCount: 1 };

for (const firstRoute of ["generateVideoPrompt", "batchGeneratePrompt"]) {
  for (const secondRoute of ["generateVideoPrompt", "batchGeneratePrompt"]) {
    test(firstRoute + " in flight blocks " + secondRoute + " and manual editing without losing the active state", async () => {
      const f = await fixture();
      let requestA: ReturnType<typeof f.post> | undefined;
      try {
        requestA = f.post(firstRoute, bodyFor(firstRoute));
        await f.firstCall;
        assert.equal(f.running(), true);
        if (firstRoute === "batchGeneratePrompt") assert.equal((await requestA).status, 200);
        const requestB = await f.post(secondRoute, bodyFor(secondRoute));
        assert.equal(requestB.status, 409, JSON.stringify(requestB.body));
        assert.equal(f.callCount(), 1, "the rejected request must not start another model call");
        let track = await f.db("o_videoTrack").where({ id: 2 }).first();
        assert.equal(track.state, "生成中"); assert.equal(track.prompt, "original prompt");
        assert.equal(f.running(), true);
        const blockedEdit = await f.post("updateVideoPrompt", { id: 2, prompt: "premature edit" });
        assert.equal(blockedEdit.status, 409);
        f.release();
        assert.equal((await requestA).status, 200); await f.finish();
        assert.equal(f.running(), false);
        track = await f.db("o_videoTrack").where({ id: 2 }).first();
        assert.equal(track.state, "已完成"); assert.equal(track.prompt, validPrompt);
        const manual = validPrompt.replace("stands still", "walks slowly");
        const edited = await f.post("updateVideoPrompt", { id: 2, prompt: manual });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.equal((await f.db("o_videoTrack").where({ id: 2 }).first()).prompt, manual);
        assert.equal((await plans.loadH3ReferencePlan(f.db, 2, manual))?.slots.length, 1);
        assert.equal(f.callCount(), 1);
      } finally { f.release(); await requestA; await f.finish(); await f.close(); }
    });
  }
}
