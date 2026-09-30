import fs from "node:fs";
import assert from "node:assert/strict";
import express from "express";
import u from "../../../src/utils";
import { db } from "../../../src/utils/db";
import getData from "../../../src/routes/production/workbench/getGenerateData";
import batchPrompt from "../../../src/routes/production/workbench/batchGeneratePrompt";
import batchVideo from "../../../src/routes/production/workbench/batchGenerateVideo";

async function main() {
  assert.equal(typeof u.db, "function");
  const dir = "data/backups/h3-reference-refresh-20260930";
  const projectId = 1790665121730, scriptId = 1;
  const targetIds = [1790715565974, 1790715576565, 1790715600051, 1790715608760, 1790715620120];
  const before = {
    variants: await db("o_videoPromptVariant").orderBy("trackId").orderBy("language"),
    videos: await db("o_video").orderBy("id"),
    originals: await db("o_videoTrack").select("id", "prompt").orderBy("id"),
  };
  fs.writeFileSync(`${dir}/before.json`, JSON.stringify(before, null, 2));
  const app = express(); app.use(express.json({ limit: "50mb" }));
  app.use("/data", getData); app.use("/prompts", batchPrompt); app.use("/validate", batchVideo);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const post = async (route: string, body: any) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const data = await post("data", { projectId, scriptId });
    assert.equal(data.status, 200);
    const tracks = data.body.data.trackList;
    assert.equal(tracks.length, 12);
    const project = await db("o_project").where({ id: projectId }).first();
    const mode = project.mode;
    const model = project.videoModel;
    const infoFor = (t: any) => t.medias.map((m: any) => ({ id: m.id, sources: m.sources, reference: Boolean(m.src), fileType: m.fileType, prompt: m.prompt,
      slotType: m.fileType === "audio" ? "audioReference" : m.fileType === "video" ? "videoReference" : "imageReference" }));
    const checkBody = { projectId, scriptId, model, mode, resolution: "768p", audio: true, validateOnly: true,
      trackData: tracks.map((t: any) => ({ trackId: t.id, prompt: "", language: "en-US", duration: Math.max(5, Number(t.duration)),
        uploadData: infoFor(t).filter((m: any) => m.reference).map((m: any) => ({ id: m.id, sources: m.sources, fileType: m.fileType, type: m.slotType })) })) };
    const initial = await post("validate", checkBody);
    fs.writeFileSync(`${dir}/preflight-before.json`, JSON.stringify(initial, null, 2));
    const failedIds = initial.body.data.tracks.filter((t: any) => !t.valid).map((t: any) => t.trackId).sort();
    assert.deepEqual(failedIds, [...targetIds].sort());
    const request = { projectId, model, mode, languages: ["en-US"], regenerate: false, concurrentCount: 2,
      trackData: tracks.filter((t: any) => targetIds.includes(t.id)).map((t: any) => ({ trackId: t.id, info: infoFor(t) })) };
    fs.writeFileSync(`${dir}/request.json`, JSON.stringify(request, null, 2));
    const started = await post("prompts", request);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    console.log("Started refresh for", targetIds.length, "stale English prompts");
    const start = Date.now(); let last = "";
    while (Date.now() - start < 30 * 60 * 1000) {
      const rows = await db("o_videoTrack").whereIn("id", targetIds).select("id", "state", "reason");
      const summary = JSON.stringify(rows);
      if (summary !== last) { console.log(summary); last = summary; }
      if (rows.every((r: any) => r.state !== "生成中")) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const fresh = await post("data", { projectId, scriptId });
    fs.writeFileSync(`${dir}/data-after.json`, JSON.stringify(fresh, null, 2));
    const checked = await post("validate", checkBody);
    fs.writeFileSync(`${dir}/preflight-after.json`, JSON.stringify(checked, null, 2));
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    const afterVariants = await db("o_videoPromptVariant").orderBy("trackId").orderBy("language");
    const preserved = (rows: any[]) => rows.filter(r => !targetIds.includes(r.trackId) || r.language !== "en-US");
    assert.deepEqual(preserved(afterVariants), preserved(before.variants));
    assert.deepEqual(await db("o_video").orderBy("id"), before.videos);
    assert.deepEqual(await db("o_videoTrack").select("id", "prompt").orderBy("id"), before.originals);
    console.log("VERIFIED: 12/12 tracks passed real route preflight; other prompts, original text and all videos preserved.");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); }
}
main().then(() => process.exit(0)).catch(cause => { console.error(cause); process.exit(1); });
