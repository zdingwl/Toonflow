// Read-only production verification; never import application startup/migrations or call generators.
import Database from "better-sqlite3";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const projectId = Number(process.argv[2] || 1791442875668);
const backup = process.argv[3];
const db = new Database("data/db2.sqlite", { readonly: true });
const cards = db.prepare("SELECT id,name,version,imagePath,imageId,imageState FROM o_characterCard WHERE status='active' ORDER BY id").all();
const attempts = db.prepare("SELECT id,cardId,baseVersion,resultVersion,state,model,resolution,filePath,sourceImageId,errorReason,createdAt,finishedAt FROM o_characterCardImage ORDER BY id").all();
const images = [];
for (const card of cards) {
  const filePath = card.imagePath && path.resolve("data/oss", card.imagePath.replace(/^[/\\]+/, ""));
  let metadata, exists = false;
  if (filePath) {
    try { metadata = await sharp(await fs.readFile(filePath)).metadata(); exists = true; } catch { /* report missing outputs */ }
  }
  images.push({ ...card, exists, width: metadata?.width, height: metadata?.height,
    fullSheet: !!metadata?.width && !!metadata?.height && metadata.width / metadata.height >= 1.7 });
}
let sourceIntegrity;
if (backup) {
  const before = new Database(backup, { readonly: true });
  const queries = {
    assets: "SELECT * FROM o_assets WHERE projectId=? ORDER BY id",
    scripts: "SELECT * FROM o_script WHERE projectId=? ORDER BY id",
    links: "SELECT * FROM o_scriptAssets WHERE scriptId IN (SELECT id FROM o_script WHERE projectId=?) ORDER BY scriptId,assetId",
    images: "SELECT * FROM o_image WHERE assetsId IN (SELECT id FROM o_assets WHERE projectId=?) ORDER BY id",
  };
  const digest = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  sourceIntegrity = Object.fromEntries(Object.entries(queries).map(([name, sql]) => {
    const original = before.prepare(sql).all(projectId), live = db.prepare(sql).all(projectId);
    return [name, { unchanged: digest(original) === digest(live), before: original.length, after: live.length }];
  })); before.close();
}
db.close();
const report = { verifiedAt: new Date().toISOString(), projectId, backup: backup || null,
  cards: images, attempts, sourceIntegrity,
  totals: { cards: cards.length, withImages: images.filter(c => c.exists).length,
    cardsAwaitingImages: images.filter(c => !c.exists).length,
    currentFailedCards: cards.filter(card => attempts.filter(a => a.cardId === card.id && (a.baseVersion === card.version || a.resultVersion === card.version)).at(-1)?.state === "failed").length,
    distinctGeneratedFiles: new Set(attempts.filter(a => a.filePath && !a.sourceImageId).map(a => a.filePath)).size,
    completed: attempts.filter(a => a.state === "completed").length,
    running: attempts.filter(a => a.state === "running").length, failed: attempts.filter(a => a.state === "failed").length },
};
await fs.writeFile("docs/character-card-images-verification-2026-10-09.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ totals: report.totals, sourceIntegrity, failed: attempts.filter(a => a.state === "failed").map(a => ({ cardId: a.cardId, reason: a.errorReason })) }));
