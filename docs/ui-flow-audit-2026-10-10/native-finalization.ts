import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(path.resolve('package.json'));
const Database=require('better-sqlite3');
const db=new Database(path.resolve('data/db2.sqlite'),{readonly:true});
const dir=path.resolve('docs/ui-flow-audit-2026-10-10');
const label=process.argv[2];
if(!label||!/^[a-z0-9-]+$/.test(label))throw Error('snapshot label required');
try {
 const runs=db.prepare('select id,status,error,createTime,updateTime from o_agentRun where projectId=? and episodesId=? order by createTime desc limit 3').all(1791442875668,71);
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const history=runs.map((run:any)=>({
  ...run,steps:db.prepare('select stepKey,status,inputContent,output,resultRef,error from o_agentStep where runId=? order by createTime').all(run.id).map((step:any)=>{
   let input:any={};try{input=JSON.parse(step.inputContent??'{}')}catch{}
   return {key:input.key??step.stepKey,status:step.status,resultRef:step.resultRef,error:step.error,outputChars:step.output?.length??0,outputHash:step.output?hash(step.output):null};
  }),
 }));
 const latest=runs[0];
 if(!latest||latest.status!=='completed')throw Error('latest native run is not completed');
 const reports=db.prepare('select inputContent,output,status from o_agentStep where runId=? order by createTime').all(latest.id)
  .filter((step:any)=>{try{return JSON.parse(step.inputContent??'{}').key==='productionAgent:supervisionAgent'}catch{return false}});
 const report=reports.at(-1);
 if(!report||report.status!=='completed'||!report.output)throw Error('latest native supervision report was not finalized');
 fs.writeFileSync(path.join(dir,label+'.native-steps.json'),JSON.stringify({at:new Date().toISOString(),history},null,2),{flag:'wx'});
 fs.writeFileSync(path.join(dir,label+'.supervision.md'),report.output,{flag:'wx'});
 console.log(JSON.stringify({latestRun:latest.id,status:latest.status,steps:history[0].steps,supervisionHash:hash(report.output)}));
} finally {db.close();}
