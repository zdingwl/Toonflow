import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, copyFile, readFile, writeFile, rm, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import knex from "knex";
import * as templates from "../src/utils/modelPromptTemplates";
import { validateFields } from "../src/middleware/middleware";
import { success, error } from "../src/lib/responseFormat";

const localRequire = createRequire(path.resolve("package.json"));
const h3Name = "MiniMax-H3-local";
const h3Mode = ["text", "startFrameOptional", ["imageReference:9"]];
const h3Data = readFileSync("data/modelPrompt/video/minimaxH3Multi-referenceMode.md", "utf8");
const modelDefinitions: Record<string, any[]> = {
  local: [
    { name: "H3", modelName: h3Name, type: "video", mode: h3Mode },
    { name: "Seedance", modelName: "seedance-2.0", type: "video", mode: [["imageReference:9"]] },
    { name: "Future", modelName: "future-video", type: "video", mode: ["text", "startFrameOptional", ["imageReference:3"]] },
    { name: "First", modelName: "first-video", type: "video", mode: ["text", "startFrameOptional"] },
    { name: "Single", modelName: "single-video", type: "video", mode: ["singleImage"] },
    { name: "Text only video", modelName: "text-video", type: "video", mode: ["text"] },
    { name: "Image", modelName: "image-model", type: "image", mode: ["text"] },
  ],
  empty: [{ name: "Text", modelName: "text-model", type: "text" }],
  disabled: [{ name: "Disabled H3", modelName: h3Name, type: "video", mode: h3Mode }],
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "toonflow-model-map-"));
  const root = path.join(directory, "modelPrompt");
  await mkdir(path.join(root, "video"), { recursive: true });
  await mkdir(path.join(root, "system"));
  await mkdir(path.join(root, "image"));
  for (const name of await readdir("data/modelPrompt/video")) {
    if (name.endsWith(".md")) await copyFile(path.join("data/modelPrompt/video", name), path.join(root, "video", name));
  }
  await writeFile(path.join(root, "system", "eventExtraction.md"), "SYSTEM_SENTINEL");
  await writeFile(path.join(root, "image", "image.md"), "IMAGE_SENTINEL");
  await templates.writeVideoPromptTemplate(root, { name: "custom-h3", type: "video", data: h3Data }, true);
  await templates.writeVideoPromptTemplate(root, { name: "custom-generic", type: "video", data: "Keep the supplied action and dialogue." }, true);
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_vendorConfig", table => { table.string("id").primary(); table.integer("enable"); });
  await db.schema.createTable("o_modelPrompt", table => { table.increments("id"); table.string("vendorId"); table.string("model"); table.string("path"); table.string("fileName"); });
  await db("o_vendorConfig").insert([{ id: "local", enable: 1 }, { id: "empty", enable: 1 }, { id: "disabled", enable: 0 }]);
  const u = {
    db,
    getPath: (parts: string[]) => { assert.deepEqual(parts, ["modelPrompt"]); return root; },
    error: (cause: any) => ({ message: cause?.message || String(cause) }),
    vendor: { getVendor: (id: string) => ({ id, name: id }), getModelList: async (id: string) => modelDefinitions[id] || [] },
  };
  const imports: Record<string, any> = { "@/utils": u, "@/utils/modelPromptTemplates": templates, "@/middleware/middleware": { validateFields }, "@/lib/responseFormat": { success, error } };
  const app = express(); app.use(express.json());
  for (const name of ["getPromptList", "getImageAndVideoModel", "bindingPrompt", "savePrompt", "updatePrompt", "deletePrompt"]) {
    const mod = { exports: {} as any };
    const source = readFileSync(`src/routes/setting/modelMap/${name}.ts`, "utf8");
    new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)((id: string) => imports[id] || localRequire(id), mod, mod.exports);
    app.use(`/${name}`, mod.exports.default);
  }
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve()));
    await db.destroy();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("toonflow-model-map-"));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(route: string, body?: any) {
    const response = await fetch(`http://127.0.0.1:${address.port}/${route}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  const bind = (selected: string, model = h3Name, vendorId = "local", fileName = path.basename(selected, ".md")) => request("bindingPrompt", { vendorId, model, path: selected, fileName });
  const read = (name: string) => readFile(path.join(root, "video", `${name}.md`), "utf8");
  return { db, root, directory, request, bind, read };
}

test("candidate listing excludes system/image files and marks immutable and in-use templates", async t => {
  const f = await fixture(t);
  await f.db("o_modelPrompt").insert({ vendorId: "local", model: h3Name, path: "video/custom-h3.md", fileName: "custom-h3" });
  const res = await f.request("getPromptList");
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 7);
  assert.ok(res.body.data.every((row: any) => row.type === "video" && row.path.startsWith("video/")));
  assert.ok(!JSON.stringify(res.body.data).includes("SYSTEM_SENTINEL"));
  assert.equal(res.body.data.find((row: any) => row.name === "custom-h3").deletable, false);
  assert.equal(res.body.data.find((row: any) => row.name === "custom-generic").deletable, true);
  assert.ok(res.body.data.filter((row: any) => row.builtin).every((row: any) => !row.deletable));
});

test("H3 candidates contain only H3-compatible templates", async t => {
  const f = await fixture(t), res = await f.request(`getPromptList?model=${encodeURIComponent(h3Name)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((row: any) => row.name).sort(), ["custom-h3", "minimaxH3Multi-referenceMode"].sort());
});

test("model listing keeps unmapped video models, omits empty/disabled providers and reports mode-based defaults", async t => {
  const f = await fixture(t), res = await f.request("getImageAndVideoModel", {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((provider: any) => provider.id), ["local"]);
  const rows = res.body.data[0].promptList;
  assert.equal(rows.length, 6);
  assert.equal(rows.find((row: any) => row.model === h3Name).effectivePath, "video/minimaxH3Multi-referenceMode.md");
  assert.equal(rows.find((row: any) => row.model === "future-video").effectivePath, "video/universalMulti-parameterMode.md");
  assert.equal(rows.find((row: any) => row.model === "first-video").effectivePath, "video/universalFirstAndLastFrameMode.md");
  assert.equal(rows.find((row: any) => row.model === "first-video").autoModeDependent, true, "a text request has different rules from the prefilled first-frame template");
  assert.equal(rows.find((row: any) => row.model === "future-video").autoModeDependent, true);
  assert.equal(rows.find((row: any) => row.model === "single-video").defaultPath, "video/universalFirstAndLastFrameMode.md");
  assert.equal(rows.find((row: any) => row.model === "single-video").autoModeDependent, false);
  assert.equal(rows.find((row: any) => row.model === "text-video").bindingStatus, "common");
  assert.equal(rows.find((row: any) => row.model === "text-video").autoModeDependent, false);
});

test("valid H3 custom binding persists its canonical path and is reported as actually effective", async t => {
  const f = await fixture(t), res = await f.bind("video\\custom-h3.md", h3Name, "local", "custom-h3");
  assert.equal(res.status, 200);
  assert.deepEqual((await f.db("o_modelPrompt").first()), { id: 1, vendorId: "local", model: h3Name, path: "video/custom-h3.md", fileName: "custom-h3" });
  const list = await f.request("getImageAndVideoModel", {}), row = list.body.data[0].promptList.find((row: any) => row.model === h3Name);
  assert.equal(row.bindingStatus, "bound"); assert.equal(row.effectivePath, "video/custom-h3.md");
});

for (const [name, selected, model, fileName] of [
  ["system", "system/eventExtraction.md", h3Name, "eventExtraction"],
  ["image", "image/image.md", "future-video", "image"],
  ["missing file", "video/missing.md", h3Name, "missing"],
  ["wrong name", "video/custom-h3.md", h3Name, "not-the-file"],
  ["wrong H3 family", "video/seedance2Multi-parameterMode.md", h3Name, "seedance2Multi-parameterMode"],
  ["generic for H3", "video/custom-generic.md", h3Name, "custom-generic"],
  ["H3 for Seedance", "video/custom-h3.md", "seedance-2.0", "custom-h3"],
  ["unsupported multireference", "video/universalMulti-parameterMode.md", "text-video", "universalMulti-parameterMode"],
  ["incomplete selection", "video/custom-h3.md", h3Name, ""],
] as const) {
  test(`binding rejects ${name} without changing saved bindings`, async t => {
    const f = await fixture(t); await f.bind("video/custom-h3.md");
    const before = await f.db("o_modelPrompt"), res = await f.bind(selected, model, "local", fileName);
    assert.equal(res.status, 400); assert.deepEqual(await f.db("o_modelPrompt"), before);
  });
}

for (const [vendorId, model] of [["missing", h3Name], ["disabled", h3Name], ["local", "missing-model"], ["local", "image-model"]]) {
  test(`binding checks enabled video model ${vendorId}/${model}`, async t => {
    const f = await fixture(t), res = await f.bind("video/custom-h3.md", model, vendorId);
    assert.equal(res.status, 400); assert.deepEqual(await f.db("o_modelPrompt"), []);
  });
}

test("empty selection removes only this model's mapping and restores its automatic default", async t => {
  const f = await fixture(t); await f.bind("video/custom-h3.md");
  await f.db("o_modelPrompt").insert({ vendorId: "other", model: h3Name, path: "video/custom-h3.md", fileName: "custom-h3" });
  const res = await f.bind("", h3Name, "local", "");
  assert.equal(res.status, 200);
  assert.equal((await f.db("o_modelPrompt")).length, 1);
  assert.equal((await f.db("o_modelPrompt").first()).vendorId, "other");
  const list = await f.request("getImageAndVideoModel", {}), row = list.body.data[0].promptList.find((row: any) => row.model === h3Name);
  assert.equal(row.bindingStatus, "default");
  assert.equal(row.effectivePath, "video/minimaxH3Multi-referenceMode.md");
});

test("concurrent first bindings remain one consistent mapping", async t => {
  const f = await fixture(t);
  await templates.writeVideoPromptTemplate(f.root, { name: "second-h3", type: "video", data: h3Data }, true);
  const replies = await Promise.all([f.bind("video/custom-h3.md"), f.bind("video/second-h3.md")]);
  assert.ok(replies.every(res => res.status === 200));
  const rows = await f.db("o_modelPrompt"); assert.equal(rows.length, 1);
  assert.ok(["custom-h3", "second-h3"].includes(rows[0].fileName));
  assert.equal(rows[0].path, `video/${rows[0].fileName}.md`);
});

test("legacy invalid binding stays visible as invalid rather than hiding the model or reporting success", async t => {
  const f = await fixture(t);
  await f.db("o_modelPrompt").insert({ vendorId: "local", model: h3Name, path: "system/eventExtraction.md", fileName: "eventExtraction" });
  const res = await f.request("getImageAndVideoModel", {}), row = res.body.data[0].promptList.find((row: any) => row.model === h3Name);
  assert.equal(row.bindingStatus, "invalid"); assert.ok(row.bindingError); assert.equal(row.effectivePath, "");
  assert.equal(row.defaultPath, "video/minimaxH3Multi-referenceMode.md", "an invalid legacy binding can still prefill a valid automatic template");
});

test("custom creation succeeds and never replaces an existing file", async t => {
  const f = await fixture(t), input = { name: "new-custom", type: "video", data: "Preserve this custom rule." };
  assert.equal((await f.request("savePrompt", input)).status, 200);
  assert.equal(await f.read("new-custom"), input.data);
  assert.equal((await f.request("savePrompt", { ...input, data: "replace" })).status, 400);
  assert.equal(await f.read("new-custom"), input.data);
});

test("saving the current H3 template as a new prompt preserves its family and can be bound", async t => {
  const f = await fixture(t), list = await f.request(`getPromptList?model=${encodeURIComponent(h3Name)}`);
  const source = list.body.data.find((row: any) => row.name === "minimaxH3Multi-referenceMode");
  const saved = await f.request("savePrompt", { name: "H3另存规则", type: "video", data: source.data });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.family, "minimax-h3-ref2va");
  assert.equal(await f.read("H3另存规则"), source.data);
  assert.equal((await f.bind(saved.body.data.path, h3Name, "local", saved.body.data.name)).status, 200);
});

test("Windows case aliases cannot delete a builtin even without any binding", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), before = await f.read("seedance2Multi-parameterMode");
  const record = await templates.readVideoPromptTemplate(f.root, "video/SEEDANCE2MULTI-PARAMETERMODE.md");
  assert.equal(record.builtin, true); assert.equal(record.deletable, false);
  const parsed = templates.parseVideoPromptTemplate("SEEDANCE2MULTI-PARAMETERMODE", before);
  assert.equal(parsed.builtin, true);
  assert.equal((await f.request("deletePrompt", { path: record.path })).status, 400);
  assert.equal(await f.read("seedance2Multi-parameterMode"), before);
});

for (const route of ["savePrompt", "updatePrompt"]) {
  for (const name of ["../system/eventExtraction", "../../outside", "folder\\escaped", "CON", "unsafe:name"]) {
    test(`${route} refuses unsafe name ${name} without touching system files`, async t => {
      const f = await fixture(t), before = await f.read("custom-generic");
      const res = await f.request(route, { name, type: "video", data: "replacement" });
      assert.equal(res.status, 400);
      assert.equal(await readFile(path.join(f.root, "system", "eventExtraction.md"), "utf8"), "SYSTEM_SENTINEL");
      assert.equal(await f.read("custom-generic"), before);
      await assert.rejects(access(path.join(f.directory, "outside.md")));
    });
  }
  for (const type of ["system", "image"]) {
    test(`${route} rejects ${type} operations`, async t => {
      const f = await fixture(t), res = await f.request(route, { name: "eventExtraction", type, data: "replacement" });
      assert.equal(res.status, 400);
      assert.equal(await readFile(path.join(f.root, "system", "eventExtraction.md"), "utf8"), "SYSTEM_SENTINEL");
    });
  }
}

test("editing a bound H3 custom cannot remove its six-section contract even when the marker is removed", async t => {
  const f = await fixture(t); await f.bind("video/custom-h3.md");
  const before = await f.read("custom-h3");
  assert.equal((await f.request("updatePrompt", { name: "custom-h3", type: "video", data: "Now just a generic sentence." })).status, 400);
  assert.equal(await f.read("custom-h3"), before);
  const validEdit = before + "\nKeep each supplied camera movement.";
  assert.equal((await f.request("updatePrompt", { name: "custom-h3", type: "video", data: validEdit })).status, 200);
  assert.equal(await f.read("custom-h3"), validEdit);
});

test("editing a template checks every binding, including a legacy path alias", async t => {
  const f = await fixture(t);
  await f.db("o_modelPrompt").insert({ vendorId: "other", model: h3Name, path: process.platform === "win32" ? "video\\custom-h3.md" : "video/./custom-h3.md", fileName: "custom-h3" });
  const res = await f.request("updatePrompt", { name: "custom-h3", type: "video", data: "Generic replacement" });
  assert.equal(res.status, 400);
  assert.equal(await f.read("custom-h3"), h3Data);
});

test("unbound custom deletion removes it from subsequent candidates", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("deletePrompt", { path: "video/custom-generic.md" })).status, 200);
  await assert.rejects(f.read("custom-generic"));
  const list = await f.request("getPromptList");
  assert.ok(!list.body.data.some((row: any) => row.path === "video/custom-generic.md"));
});

test("bound custom deletion is blocked across all providers and leaves the file and mapping intact", async t => {
  const f = await fixture(t);
  await f.db("o_modelPrompt").insert({ vendorId: "other", model: h3Name, path: "video/custom-h3.md", fileName: "custom-h3" });
  const before = await f.db("o_modelPrompt");
  const res = await f.request("deletePrompt", { path: "video/custom-h3.md" });
  assert.equal(res.status, 400); assert.equal(await f.read("custom-h3"), h3Data);
  assert.deepEqual(await f.db("o_modelPrompt"), before);
});

for (const selected of ["system/eventExtraction.md", "../system/eventExtraction.md", "video/../system/eventExtraction.md", "video/minimaxH3Multi-referenceMode.md"]) {
  test(`deletion refuses protected or invalid selection ${selected}`, async t => {
    const f = await fixture(t), res = await f.request("deletePrompt", { path: selected });
    assert.equal(res.status, 400);
    assert.equal(await readFile(path.join(f.root, "system", "eventExtraction.md"), "utf8"), "SYSTEM_SENTINEL");
    assert.equal(await f.read("minimaxH3Multi-referenceMode"), h3Data);
  });
}
