// Read-only check of a real extraction retry against its pre-run database backup.
import Database from "better-sqlite3";
import fs from "node:fs";
import { createHash } from "node:crypto";

const projectId = Number(process.argv[2] || 1791442875668);
const backupPath = process.argv[3];
if (!backupPath) throw new Error("Provide the pre-run SQLite backup path");
const before = new Database(backupPath, { readonly: true, fileMustExist: true });
const live = new Database("data/db2.sqlite", { readonly: true, fileMustExist: true });
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} WHERE projectId=? ORDER BY id`).all(projectId);
const originalScripts = rows(before, "o_script"), scripts = rows(live, "o_script");
const originalAssets = rows(before, "o_assets"), assets = rows(live, "o_assets");
const run = live.prepare("SELECT * FROM o_assetExtractionRun WHERE projectId=? ORDER BY updatedAt DESC,id DESC LIMIT 1").get(projectId);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const imageRows = db => db.prepare("SELECT * FROM o_image WHERE assetsId IN (SELECT id FROM o_assets WHERE projectId=?) ORDER BY id").all(projectId);
const catalog = new Map(scripts.flatMap(script => (String(script.content || "").match(/[^\r\n。！？!?]+[。！？!?]*/gu) || [])
  .filter(quote => quote.trim()).map((quote, index) => [`${script.id}:${index + 1}`, { scriptId: script.id, quote }])));
const updatedAssets = assets.filter(asset => {
  const old = originalAssets.find(row => row.id === asset.id);
  return !old || old.descriptionVersion !== asset.descriptionVersion || old.descriptionMeta !== asset.descriptionMeta;
});
const invalidFacts = [], cardBindings = [];
for (const asset of updatedAssets) {
  const meta = JSON.parse(asset.descriptionMeta || "{}");
  for (const fact of meta.scriptFacts || []) {
    const source = catalog.get(fact.sourceRef);
    if (!source || fact.scriptId !== source.scriptId || fact.quote !== source.quote) invalidFacts.push({ assetId: asset.id, sourceRef: fact.sourceRef });
  }
  if (meta.characterCard) {
    const card = live.prepare("SELECT cardId,version FROM o_characterCardVersion WHERE cardId=? AND version=?").get(meta.characterCard.cardId, meta.characterCard.version);
    cardBindings.push({ assetId: asset.id, name: asset.name, cardId: meta.characterCard.cardId, version: meta.characterCard.version, exists: !!card });
  }
}
const originalCards = before.prepare("SELECT id,imagePath,imageId FROM o_characterCard WHERE imagePath IS NOT NULL ORDER BY id").all();
const protectedData = {
  originalScriptContent: originalScripts.length === scripts.length && originalScripts.every(old => scripts.some(row => row.id === old.id && row.name === old.name && row.content === old.content)),
  originalAssetImagesAndPrompts: originalAssets.every(old => assets.some(row => row.id === old.id && row.imageId === old.imageId && row.prompt === old.prompt)),
  originalImageRecords: digest(imageRows(before)) === digest(imageRows(live)),
  originalCardImages: originalCards.every(old => { const card = live.prepare("SELECT imagePath,imageId FROM o_characterCard WHERE id=?").get(old.id); return card?.imagePath === old.imagePath && card?.imageId === old.imageId; }),
  originalUserConstraints: originalAssets.every(old => {
    const current = assets.find(row => row.id === old.id);
    return current && (JSON.parse(old.descriptionMeta || "{}").userConstraints || "") === (JSON.parse(current.descriptionMeta || "{}").userConstraints || "");
  }),
};
const report = { verifiedAt: new Date().toISOString(), projectId, backupPath, run,
  scripts: { total: scripts.length, succeeded: scripts.filter(row => row.extractState === 1 && !row.errorReason).length, failed: scripts.filter(row => row.extractState === -1).map(row => ({ id: row.id, errorReason: row.errorReason })) },
  assets: { before: originalAssets.length, after: assets.length, updatedOrCreated: updatedAssets.length },
  protectedData, originalImageCount: imageRows(before).length, originalCardsWithImages: originalCards.length,
  invalidFacts, cardBindings,
  vera: (() => { const asset = assets.find(row => row.id === 354); const meta = JSON.parse(asset?.descriptionMeta || "{}"); return { imageId: asset?.imageId, descriptionVersion: asset?.descriptionVersion, scriptFacts: meta.scriptFacts || [], characterCard: meta.characterCard || null }; })(),
  steps: live.prepare("SELECT stage,count(*) AS count FROM o_assetExtractionStep WHERE runId=? GROUP BY stage").all(run?.runId || ""),
};
report.success = run?.status === "completed" && report.scripts.succeeded === originalScripts.length && report.scripts.failed.length === 0
  && Object.values(protectedData).every(Boolean) && invalidFacts.length === 0 && cardBindings.every(card => card.exists);
fs.writeFileSync("docs/asset-extraction-retry-verification-2026-10-09.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ success: report.success, run: { status: run?.status, stage: run?.stage, label: run?.label, error: run?.error },
  scripts: report.scripts, assets: report.assets, protectedData, invalidFacts: invalidFacts.length, cardBindings: cardBindings.length }));
before.close(); live.close();
if (!report.success) process.exitCode = 1;
