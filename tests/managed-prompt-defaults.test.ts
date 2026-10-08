import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { tmpdir } from "node:os";
import path from "node:path";
import knex from "knex";
import { loadManagedPromptDefaults, managedPromptTypes, syncManagedPromptDefaults } from "../src/utils/managedPromptDefaults";
import { composeVideoPromptPolicy } from "../src/utils/videoPromptPolicy";

test("managed defaults update together while keeping user edits, IDs and missing-entry recovery", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_prompt", t => { t.increments("id"); t.string("name"); t.string("type"); t.text("data"); t.text("useData"); });
  await db("o_prompt").insert({ id: 41, type: "videoPromptGeneration", name: "视频提示词生成", data: "old default", useData: "my edited rules" });
  try {
    await syncManagedPromptDefaults(db);
    const rows = await db("o_prompt").select("*");
    assert.equal(rows.length, 4);
    const video = rows.find(r => r.type === "videoPromptGeneration");
    assert.equal(video.id, 41);
    assert.equal(video.useData, "my edited rules");
    assert.equal(video.data, loadManagedPromptDefaults().find(r => r.type === video.type)?.data);
    await syncManagedPromptDefaults(db);
    assert.deepEqual(await db("o_prompt").select("*"), rows);
  } finally { await db.destroy(); }
});

test("a missing or blank default fails before changing any managed row", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "toonflow-prompts-"));
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_prompt", t => { t.increments("id"); t.string("name"); t.string("type"); t.text("data"); t.text("useData"); });
  await db("o_prompt").insert({ type: "eventExtraction", data: "keep default", useData: "keep custom" });
  const before = await db("o_prompt").select("*");
  try {
    for (const type of managedPromptTypes) writeFileSync(path.join(directory, `${type}.md`), type === "audioBindPrompt" ? " \n" : "replacement");
    await assert.rejects(syncManagedPromptDefaults(db, directory), /音色绑定默认提示词为空/);
    assert.deepEqual(await db("o_prompt").select("*"), before);
  } finally { await db.destroy(); rmSync(directory, { recursive: true, force: true }); }
});

test("video shared policy and selected model format are both carried, with explicit scope", () => {
  const value = composeVideoPromptPolicy("retain Ava's dialogue and close-up", "subject_definitions:\nsummary:");
  assert.match(value, /retain Ava's dialogue and close-up/);
  assert.match(value, /subject_definitions:\nsummary:/);
  assert.match(value, /valid uploaded reference slots/);
  assert.match(value, /output sections, supported reference syntax and timestamp notation/);
});

test("video fallback carries one policy and tolerates absent managed rows", () => {
  assert.equal(composeVideoPromptPolicy("rules", " rules "), "rules");
  assert.equal(composeVideoPromptPolicy("rules", null), "rules");
  assert.equal(composeVideoPromptPolicy(null, "model rules"), "model rules");
});

function desktopDefaults(packaged: boolean, resourcesPath: string) {
  const mod = { exports: {} as any }, requireLocal = createRequire(`${process.cwd()}/package.json`);
  const code = transform(readFileSync("src/utils/managedPromptDefaults.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
  const opened: string[] = [];
  new Function("require", "module", "exports", "process", code)((id: string) => {
    if (id === "electron") return { app: { isPackaged: packaged } };
    if (id === "node:fs") return { readFileSync: (file: string) => {
      opened.push(file); return file.startsWith(path.normalize(resourcesPath)) ? "this release's rules" : "repository rules";
    } };
    return requireLocal(id);
  }, mod, mod.exports, { cwd: () => "D:/repo", versions: { electron: "test" }, resourcesPath });
  return { ...mod.exports, opened };
}

test("Electron development reads repository defaults even when userData has no template files", () => {
  const defaults = desktopDefaults(false, "C:/electron-runtime/resources");
  assert.equal(defaults.readManagedPrompt("eventExtraction"), "repository rules");
  assert.equal(defaults.opened[0], path.join("D:/repo", "data", "modelPrompt", "system", "eventExtraction.md"));
});

test("packaged defaults follow each release's resources rather than stale merged userData files", () => {
  for (const release of ["C:/release-one/resources", "C:/release-two/resources"]) {
    const defaults = desktopDefaults(true, release);
    assert.equal(defaults.readManagedPrompt("audioBindPrompt"), "this release's rules");
    assert.equal(defaults.opened[0], path.join(release, "data", "modelPrompt", "system", "audioBindPrompt.md"));
  }
});
