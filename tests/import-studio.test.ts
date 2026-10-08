import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import sharp from "sharp";
import { ASSET_CSV, EXAMPLE_MANIFEST, parseAssetCsv, parseCsv, safeZipPath, validateManifest, makeZip, parseVideoZip } from "../src/utils/importStudioContracts";
import { initStudioTables, StudioQueue } from "../src/utils/importStudioQueue";

test("CSV template, Chinese, quoted commas, newlines and escaped quotes survive parsing", () => {
  assert.equal(parseAssetCsv(Buffer.from(ASSET_CSV)).length, 3);
  assert.deepEqual(parseCsv('id,prompt\r\n1,"hello,\n""world"""'), [["id", "prompt"], ["1", 'hello,\n"world"']]);
  assert.throws(() => parseCsv('a,"bad'), /引号/);
  assert.throws(() => parseAssetCsv(Buffer.from(ASSET_CSV + 'hero,重复,role,提示词,1:1')), /重复/);
  assert.throws(() => parseAssetCsv(Buffer.from('id,name,type,prompt,aspectRatio\na,A,role,,1:1')), /第 2 行/);
  assert.throws(() => parseAssetCsv(Buffer.from('id,name,type,prompt,aspectRatio\na,A,role,prompt,7:3')), /第 2 行/);
  assert.throws(() => parseAssetCsv(Buffer.from([0xff, 0xfe, 0xa0])), /encoded|encoding/i);
});

test("asset imports preserve landscape and portrait 4:3 ratios without relaxing H3 video ratios", () => {
  const rows = parseAssetCsv(Buffer.from('id,name,type,prompt,aspectRatio\nmap,路线图,tool,地图道具,4:3\nfile,档案,tool,档案道具,3:4'));
  assert.deepEqual(rows.map(row => row.aspectRatio), ["4:3", "3:4"]);
  assert.deepEqual(rows.map(row => row.prompt), ["地图道具", "档案道具"]);
  const manifest = structuredClone(EXAMPLE_MANIFEST);
  (manifest.shots[0] as any).aspectRatio = "4:3";
  assert.throws(() => validateManifest(manifest), /aspectRatio/);
});

test("CSV creature assets keep their source type and prompt", () => {
  const [row] = parseAssetCsv(Buffer.from('id,name,type,prompt,aspectRatio\nshark,普通鲨鱼,creature,真实的鲨鱼参考图,4:3'));
  assert.equal(row.type, "creature");
  assert.equal(row.prompt, "真实的鲨鱼参考图");
  assert.throws(() => parseAssetCsv(Buffer.from('id,name,type,prompt,aspectRatio\na,A,unknown,prompt,1:1')), /type/);
});

test("H3 validates all bindings without imposing a six-section prompt format", () => {
  assert.equal(validateManifest(EXAMPLE_MANIFEST).shots[0].assets[0], "hero");
  const changed = () => structuredClone(EXAMPLE_MANIFEST);
  let m = changed(); m.shots[0].assets = ["missing"]; assert.throws(() => validateManifest(m), /不存在/);
  m = changed(); m.shots[0].assets = ["hero", "hero"]; assert.throws(() => validateManifest(m), /重复/);
  m = changed(); m.shots[0].prompt = "<Picture 3>"; assert.throws(() => validateManifest(m), /Picture/);
  m = changed(); m.shots[0].duration = 16; assert.throws(() => validateManifest(m), /duration/);
  m = changed(); m.assets[0].file = "../secret.png"; assert.throws(() => validateManifest(m), /不安全/);
  for (const path of ["../x", "/x", "C:/x", "a\\b", "a/../b", "a./b", "a\0b"]) assert.throws(() => safeZipPath(path));
});

test("ZIP template round trip, nested root, missing/corrupt images and duplicate entries", async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#eee' } }).png().toBuffer();
  const files = new Map([["project/manifest.json", Buffer.from(JSON.stringify(EXAMPLE_MANIFEST))], ["project/assets/hero.png", png], ["project/assets/room.png", png]]);
  const output = await parseVideoZip(await makeZip(files));
  assert.equal(output.images.size, 2); assert.deepEqual(output.manifest.shots[0].assets, ["hero", "room"]);
  files.set("project/assets/room.png", Buffer.from("bad image"));
  await assert.rejects(parseVideoZip(await makeZip(files)), /图片无效/);
  files.delete("project/assets/room.png");
  await assert.rejects(parseVideoZip(await makeZip(files)), /缺少资产/);
  files.set("manifest.json", Buffer.from(JSON.stringify(EXAMPLE_MANIFEST)));
  await assert.rejects(parseVideoZip(await makeZip(files)), /只能包含一个/);
  await assert.rejects(parseVideoZip(Buffer.from("not zip")));
});

test("video ZIP accepts creatures and preserves mixed asset binding order", async () => {
  const manifest = structuredClone(EXAMPLE_MANIFEST);
  manifest.assets.push({ id: "shark", name: "变异鲨", type: "creature", file: "assets/shark.jpg" });
  manifest.shots[0].assets = ["shark", "hero", "room"];
  manifest.shots[0].prompt = "<Picture 1> 的海兽游向 <Picture 2> 的人物，背景为 <Picture 3>。";
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#eee' } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const files = new Map([
    ["manifest.json", Buffer.from(JSON.stringify(manifest))],
    ["assets/hero.png", png], ["assets/room.png", png], ["assets/shark.jpg", jpeg],
  ]);
  const result = await parseVideoZip(await makeZip(files));
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.images.size, 3);
  assert.equal((await sharp(result.images.get("shark")!).metadata()).format, "png");
  const invalid = structuredClone(manifest);
  (invalid.assets[2] as any).type = "unknown";
  assert.throws(() => validateManifest(invalid), /assets.2.type/);
  invalid.assets[2].type = "creature";
  invalid.shots[0].prompt = "<Picture 2> 和 <Picture 3>";
  assert.throws(() => validateManifest(invalid), /Picture/);
});

test("queue serializes full generation, skips successes and duplicate submissions, persists errors and retries", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
  try {
    await initStudioTables(db);
    for (const [id, state] of [["a", "ready"], ["b", "ready"], ["c", "succeeded"]]) await db("o_importItem").insert({ id, batchId: "batch", position: 1, spec: "{}", state, output: id === "c" ? "/paid.png" : null });
    let active = 0, peak = 0; const calls: string[] = [];
    const queue = new StudioQueue(db, async item => { active++; peak = Math.max(active, peak); calls.push(item.id); await new Promise(r => setTimeout(r, 10)); active--; if (item.id === "b") throw new Error("provider offline"); return "/new.png"; });
    const counts = await Promise.all([queue.enqueue("batch", ["a", "b", "c"], "local"), queue.enqueue("batch", ["a", "b", "c"], "local")]);
    assert.equal(counts.reduce((a, b) => a + b), 2);
    await queue.idle(); assert.equal(peak, 1); assert.deepEqual(calls, ["a", "b"]);
    assert.equal((await db("o_importItem").where({ id: "c" }).first()).output, "/paid.png");
    assert.equal((await db("o_importItem").where({ id: "b" }).first()).error, "provider offline");
    await assert.rejects(queue.enqueue("another-batch", ["a"], "local"), /不属于/);
    const retry = new StudioQueue(db, async () => "/retry.png");
    assert.equal(await retry.enqueue("batch", ["a", "b"], "local"), 1); await retry.idle();
    const b = await db("o_importItem").where({ id: "b" }).first(); assert.equal(b.state, "succeeded"); assert.equal(b.error, null);
    await db("o_importItem").where({ id: "a" }).update({ state: "running" });
    await initStudioTables(db); assert.equal((await db("o_importItem").where({ id: "a" }).first()).state, "interrupted");
    assert.equal((await db("o_importItem").where({ id: "c" }).first()).state, "succeeded");
  } finally { await db.destroy(); }
});
