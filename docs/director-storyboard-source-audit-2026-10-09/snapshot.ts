import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const Database=createRequire(path.resolve('package.json'))('better-sqlite3');
const db=new Database(path.resolve('data/db2.sqlite'),{readonly:true});
const hash=(s:string)=>createHash('sha256').update(s??'').digest('hex');
const dir=path.resolve('docs/director-storyboard-source-audit-2026-10-09');
try {
 const source=db.prepare('select * from o_script where id=?').get(71);
 const project=db.prepare('select * from o_project where id=?').get(source.projectId);
 const workspace=db.prepare("select * from o_agentWorkData where projectId=? and episodesId=? and key='productionAgent'").get(source.projectId,71);
 const data=JSON.parse(workspace.data);
 const assets=db.prepare('select id,name,type,assetsId from o_assets where projectId=? order by id').all(source.projectId);
 const evidence={source,project,workspaceId:workspace.id,data,assets,
  sourceHash:hash(source.content),planHash:hash(data.scriptPlan??''),
  workspaces:db.prepare('select id,data from o_agentWorkData order by id').all().map((w:any)=>({id:w.id,hash:hash(w.data)})),
  counts:Object.fromEntries(['o_video','o_storyboard','o_assets'].map(t=>[t,db.prepare(`select count(*) n from ${t}`).get().n])),
  mode:db.prepare("select value from o_setting where key='agentUseMode'").get()?.value,
  deployments:db.prepare("select key,modelName,temperature,maxOutputTokens from o_agentDeploy where key in ('productionAgent','productionAgent:storyboardTableAgent')").all(),
  activeRuns:db.prepare("select id,status from o_agentRun where status='running'").all(),
  activeTasks:db.prepare("select id,state from o_tasks where state='进行中'").all()};
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'before-state.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
 fs.writeFileSync(path.join(dir,'source.md'),source.content,{flag:'wx'});
 fs.writeFileSync(path.join(dir,'saved-director-plan.md'),data.scriptPlan??'',{flag:'wx'});
 fs.writeFileSync(path.join(dir,'existing-storyboard.md'),data.storyboardTable??'',{flag:'wx'});
 console.log(JSON.stringify({workspaceId:workspace.id,dataKeys:Object.keys(data),storyboardChars:(data.storyboardTable??'').length,assets,project,mode:evidence.mode,deployments:evidence.deployments,counts:evidence.counts,activeRuns:evidence.activeRuns,activeTasks:evidence.activeTasks}));
} finally {db.close();}
