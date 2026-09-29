import '../src/env';
import u from '../src/utils';
import fs from 'node:fs';
import { extractScriptAssets } from '../src/utils/scriptAssetExtraction';
import { assetExtractionDesignRules } from '../src/routes/script/extractAssets';
import { getAssetVisualDesignSkill } from '../src/utils/assetVisualDesignSkill';
async function main() {
 const projectId=1790218938911;
 const project=await u.db('o_project').where({id:projectId}).first();
 const template=await u.db('o_prompt').where({type:'scriptAssetExtraction'}).first();
 const system=(template?.useData||template?.data||'')+'\n\n'+getAssetVisualDesignSkill()+'\n\n'+assetExtractionDesignRules+'\n项目画风：'+project.artStyle+'\n当前 resultTool 的字段结构优先于旧模板。';
 let discovered:any;
 try {
 await extractScriptAssets({db:u.db,system,invoke:async (request:any)=>{
  const execute=request.tools.resultTool.execute;
  request.tools.resultTool.execute=async(value:any,options:any)=>{const result=await execute(value,options); discovered=value; return result;};
  const result=await u.Ai.Text('universalAi').invoke(request);
  if(!discovered) return result;
  const names=await u.db('o_assets').where({projectId}).select('id','name');
  const report={...discovered,selectedNames:[...discovered.existingAssetRefs.map((r:any)=>names.find(a=>a.id===r.assetId)?.name),...discovered.newAssets.map((a:any)=>a.name)]};
  fs.writeFileSync('.runtime/asset-discovery-probe.json',JSON.stringify(report,null,2));
  console.log('DISCOVERY_PROBE',JSON.stringify(report));
  throw new Error('DRY_RUN_STOP_BEFORE_DESIGN_OR_WRITE');
 }},{projectId,scriptIds:[31]});
 } catch(error:any) {if(!error.message.includes('DRY_RUN_STOP_BEFORE_DESIGN_OR_WRITE')) throw error;}
 if(!discovered) throw new Error('No discovery result');
 if(discovered.existingAssetRefs.some((r:any)=>r.assetId===137)||discovered.newAssets.some((a:any)=>a.name.includes('朋友'))) throw new Error('Background friends still selected');
 for(const id of [115,116,117,136]) if(!discovered.existingAssetRefs.some((r:any)=>r.assetId===id)) throw new Error('Missing required character '+id);
 console.log('LIVE_PROBE_PASS');
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
