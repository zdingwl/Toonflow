import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {extractStoryboardTable} from '../../src/agents/productionAgent/storyboardTable';
import {validateStoryboardScene,extractSourceScene} from '../../src/agents/productionAgent/storyboardValidator';
import {productionSceneBudget} from '../../src/agents/productionAgent/screenplay';
const dir=path.resolve('docs/director-storyboard-source-audit-2026-10-09');
const before=JSON.parse(fs.readFileSync(path.join(dir,'before-state.json'),'utf8'));
const hash=(s:string)=>createHash('sha256').update(s??'').digest('hex');
const Database=createRequire(path.resolve('package.json'))('better-sqlite3');
const db=new Database(path.resolve('data/db2.sqlite'),{readonly:true});
try{
 const source=db.prepare('select content from o_script where id=71 and projectId=?').get(before.source.projectId).content;
 const row=db.prepare("select data from o_agentWorkData where id=? and key='productionAgent'").get(before.workspaceId),data=JSON.parse(row.data);
 const workspaces=db.prepare('select id,data from o_agentWorkData order by id').all().map((w:any)=>({id:w.id,hash:hash(w.data)}));
 const counts=Object.fromEntries(Object.keys(before.counts).map(t=>[t,db.prepare(`select count(*) n from ${t}`).get().n]));
 const linked=db.prepare('select assetId from o_scriptAssets where scriptId=71').all().map((a:any)=>a.assetId);
 const assets=db.prepare('select a.id,a.name,a.assetsId,i.filePath from o_assets a left join o_image i on a.imageId=i.id where a.projectId=?').all(before.source.projectId).filter((a:any)=>linked.includes(a.id)||linked.includes(a.assetsId));
 const finals=[1,2,3].map(scene=>{
  const evalDir=path.resolve(`docs/storyboard-evaluation/2026-10-10-final-scene${scene}`);
  const metadata=JSON.parse(fs.readFileSync(path.join(evalDir,'evaluation.json'),'utf8'));
  const last=metadata.scenes.at(-1),raw=fs.readFileSync(last.raw,'utf8'),markdown=fs.readFileSync(last.markdown,'utf8');
  const extracted=extractStoryboardTable(raw);
  const validation=validateStoryboardScene(scene,markdown,extractSourceScene(source,scene),{targetDuration:productionSceneBudget(data.scriptPlan,scene,extractSourceScene(source,scene)),assetIds:assets.map((a:any)=>a.id)});
  const rows=markdown.split(/\r?\n/).filter(line=>/^\|\s*\d+\s*\|/.test(line)).map(line=>line.split('|').slice(1,-1));
  return {scene,file:last.markdown,rawFile:last.raw,rawHash:hash(raw),rawHashUnchanged:hash(raw)===last.rawHash,exactExtract:extracted.content===markdown,model:metadata.model,sourceHashMatches:metadata.sourceHash===hash(source),planHashMatches:metadata.planHash===hash(data.scriptPlan),validation,shots:rows.length,duration:rows.reduce((n:number,cells:string[])=>n+Number(cells[2].trim()),0),markdown};
 });
 const result={verifiedAt:new Date().toISOString(),sourceUnchanged:hash(source)===before.sourceHash,planUnchanged:hash(data.scriptPlan)===before.planHash,allWorkspacesUnchanged:JSON.stringify(workspaces)===JSON.stringify(before.workspaces),countsUnchanged:JSON.stringify(counts)===JSON.stringify(before.counts),counts,
  sourceHash:hash(source),planHash:hash(data.scriptPlan),storyboardProductionChars:(data.storyboardTable??'').length,
  missingAssetImages:assets.filter((a:any)=>!a.filePath).map((a:any)=>({id:a.id,name:a.name})),
  activeRuns:db.prepare("select id,status from o_agentRun where status='running'").all(),activeTasks:db.prepare("select id,state from o_tasks where state='进行中'").all(),
  totalShots:finals.reduce((n,s)=>n+s.shots,0),totalDuration:finals.reduce((n,s)=>n+s.duration,0),finals:finals.map(({markdown,...e})=>e),
  artifactDisposition:'Isolated raw text candidates with direct review feedback; production screenplay, director plan, storyboard, assets and videos were not overwritten. Text execution PASS does not certify pixels or audio.'};
 fs.writeFileSync(path.join(dir,'final-verification.json'),JSON.stringify(result,null,2));
 const joined=finals.map(s=>s.markdown).join('\n\n');
 const artifact=path.join(dir,'qualified-storyboard.md');
 if(fs.existsSync(artifact)){if(fs.readFileSync(artifact,'utf8')!==joined)throw Error('已经存在的合格稿不一致，禁止覆盖');}else fs.writeFileSync(artifact,joined,{flag:'wx'});
 console.log(JSON.stringify(result));
 if(!result.sourceUnchanged||!result.planUnchanged||!result.allWorkspacesUnchanged||!result.countsUnchanged||finals.some(s=>!s.validation.valid||!s.rawHashUnchanged||!s.exactExtract||!s.sourceHashMatches||!s.planHashMatches))process.exitCode=1;
}finally{db.close();}
