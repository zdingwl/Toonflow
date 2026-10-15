import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

async function main() {
  const require = createRequire(path.resolve('package.json'));
  const Database = require('better-sqlite3');
  const sharp = require('sharp');
  const db = new Database(path.resolve('data/db2.sqlite'), {readonly:true});
  try {
    const rows = db.prepare(`SELECT a.id,a.name,a.imageId AS selectedImageId,
      i.filePath,i.state,i.errorReason FROM o_scriptAssets sa
      JOIN o_assets a ON sa.assetId=a.id LEFT JOIN o_image i ON a.imageId=i.id
      WHERE sa.scriptId=? AND a.projectId=? ORDER BY a.id`).all(71,1791442875668);
    const workspace = JSON.parse(db.prepare('select data from o_agentWorkData where id=42').get().data);
    const ossRoot = path.resolve('data/oss');
    const assets = [];
    for (const row of rows) {
      const localPath = row.filePath ? path.resolve(ossRoot,row.filePath.replace(/^[/\\]+/,'')) : null;
      if (localPath && !localPath.startsWith(ossRoot+path.sep)) throw Error('图片路径超出OSS目录');
      const exists = Boolean(localPath && fs.existsSync(localPath));
      const metadata = exists ? await sharp(localPath).metadata() : null;
      const cached = (workspace.assets ?? []).find((asset:any) => Number(asset.id) === row.id);
      assets.push({...row,localResolvedPath:localPath,exists,
        bytes:exists ? fs.statSync(localPath!).size : 0,
        width:metadata?.width ?? null,height:metadata?.height ?? null,format:metadata?.format ?? null,
        persistedFlowSrc:cached?.src ?? null});
    }
    const result = {verifiedAt:new Date().toISOString(),episode:71,project:1791442875668,
      linkedCount:rows.length,allSelectedImagesExist:assets.every(a=>a.exists && a.bytes>0 && a.width && a.height && a.state==='已完成' && !a.errorReason),
      imageContentReviewed:false,assets,
      correction:'A null src in the persisted flow cache is not proof of a missing selected image. getFlowData refreshes asset image data from current tables.'};
    fs.writeFileSync(path.resolve('docs/director-storyboard-source-audit-2026-10-09/asset-state-verification.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({linkedCount:result.linkedCount,allSelectedImagesExist:result.allSelectedImagesExist,cacheSrcNullCount:assets.filter(a=>!a.persistedFlowSrc).length}));
    if (!result.allSelectedImagesExist || rows.length!==8) process.exitCode=1;
  } finally {db.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
