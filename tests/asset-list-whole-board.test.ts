import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import { validateFields } from "../src/middleware/middleware";
import * as attempts from "../src/utils/latestAssetImageAttempts";

test("asset list returns the selected board and history without loading or exposing legacy crops", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_assets", t => {
    for (const key of ["id", "projectId", "assetsId", "imageId"]) t.integer(key);
    for (const key of ["type", "name", "faceReferencePath", "fullBodyReferencePath", "sideReferencePath", "backReferencePath"]) t.text(key);
  });
  await db.schema.createTable("o_image", t => {
    t.integer("id"); t.integer("assetsId");
    for (const key of ["filePath", "state", "model", "resolution", "errorReason"]) t.text(key);
  });
  await db.schema.createTable("o_assetsRole2Audio", t => { t.integer("assetsRoleId"); t.integer("assetsAudioId"); });
  await db("o_assets").insert({ id: 1, projectId: 1, imageId: 2, type: "role", name: "Ava", faceReferencePath: "old-face.png", fullBodyReferencePath: "old-front.png", sideReferencePath: "old-side.png", backReferencePath: "old-back.png" });
  await db("o_image").insert([{ id: 1, assetsId: 1, filePath: "history-board.png", state: "已完成" }, { id: 2, assetsId: 1, filePath: "current-board.png", state: "已完成" }]);
  const before = await db("o_assets").first();
  const reads: string[] = [];
  const localRequire = createRequire(process.cwd() + "/package.json"), mod = { exports: {} as any };
  const imports: Record<string, unknown> = {
    "@/utils": { db, oss: {
      getSmallImageUrl: async (path: string) => { reads.push(path); return "/media/" + path; },
      getFileUrl: async () => { throw new Error("Legacy reference lookup must not run"); },
    } },
    "@/middleware/middleware": { validateFields },
    "@/lib/responseFormat": { success: (data: unknown) => ({ data }) },
    "@/utils/latestAssetImageAttempts": attempts,
  };
  new Function("require", "module", "exports", transform(readFileSync("src/routes/cornerScape/getAllAssets.ts", "utf8"), { transforms: ["typescript", "imports"] }).code)
    ((id: string) => imports[id] || localRequire(id), mod, mod.exports);
  const app = express(); app.use(express.json()); app.use("/", mod.exports.default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  try {
    const response = await fetch("http://127.0.0.1:" + (server.address() as any).port, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: 1 }) });
    assert.equal(response.status, 200);
    const item = (await response.json()).data[0];
    assert.equal(item.name, "Ava"); assert.equal(item.filePath, "/media/current-board.png");
    assert.equal(item.historyImages.length, 2);
    assert.ok(!Object.keys(item).some(key => /^(face|fullBody|side|back)Reference/.test(key)));
    assert.ok(reads.every(path => path.endsWith("board.png")));
    assert.deepEqual(await db("o_assets").first(), before);
  } finally { await new Promise<void>(r => server.close(() => r())); await db.destroy(); }
});
