import '../src/env';
import u from '../src/utils';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { extractScriptAssets } from '../src/utils/scriptAssetExtraction';
async function main() {
 const projectId=1790218938911;
 const report=JSON.parse(fs.readFileSync('.runtime/asset-discovery-probe.json','utf8'));
 const existing=await u.db('o_assets').where({projectId});
 if(report.existingAssetRefs.some((r:any)=>r.assetId===137)) throw new Error('Wrong role still selected');
 for(const a of report.newAssets) if(!existing.some(b=>b.name===a.name&&b.type===a.type&&!b.assetsId)) throw new Error('Unexpected new asset '+a.name);
 const backupDir='data/backups/asset-selection-'+Date.now();fs.mkdirSync(backupDir,{recursive:true});
 const sqlite=new Database('data/db2.sqlite');await sqlite.backup(backupDir+'/before.sqlite');sqlite.close();
 fs.writeFileSync(backupDir+'/discovery.json',JSON.stringify(report,null,2));
 const result=await extractScriptAssets({db:u.db,system:'Replay validated live discovery without another provider call',invoke:async(request:any)=>{
   if(JSON.parse(request.messages[0].content).asset) throw new Error('Unexpected asset redesign');
   await request.tools.resultTool.execute(report,{});return {};
 }},{projectId,scriptIds:[31],updateExistingDescriptions:false});
 await u.db.transaction(async trx=>{
  const bad=await trx('o_assets').where({id:137,projectId}).first();
  if(!bad||bad.name!=='麦迪逊的两个朋友'||bad.imageId||bad.prompt||bad.flowId) throw new Error('Asset changed; cleanup stopped');
  for(const [table,col] of [['o_scriptAssets','assetId'],['o_image','assetsId'],['o_assets','assetsId'],['o_assets2Storyboard','assetId'],['o_assetsRole2Audio','assetsRoleId']] as const) {
   if((await trx(table as any).where(col,137)).length) throw new Error('Asset has dependent records in '+table);
  }
  await trx('o_assetDescriptionHistory').where({assetId:137,projectId}).delete();
  await trx('o_assets').where({id:137,projectId}).delete();
 });
 const links=await u.db('o_scriptAssets').join('o_assets','o_assets.id','o_scriptAssets.assetId').where('scriptId',31).select('o_assets.id','o_assets.name');
 const after=await u.db('o_assets').where({projectId});
 for(const a of existing.filter(a=>a.id!==137)) if(JSON.stringify(a)!==JSON.stringify(after.find(b=>b.id===a.id))) throw new Error('Unrelated asset changed '+a.id);
 console.log(JSON.stringify({backupDir,result,links,unchangedAssets:existing.length-1,removedAsset137:!after.some(a=>a.id===137)},null,2));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
