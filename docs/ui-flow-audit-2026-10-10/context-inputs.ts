import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(path.resolve('package.json'));
const Database=require('better-sqlite3');
const db=new Database(path.resolve('data/db2.sqlite'),{readonly:true});
try {
  const script=db.prepare('select content from o_script where id=? and projectId=?').get(71,1791442875668);
  const row=db.prepare("select data from o_agentWorkData where projectId=? and episodesId=? and key='productionAgent'").get(1791442875668,71);
  const data=JSON.parse(row?.data??'{}');
  const dir=path.resolve('docs/ui-flow-audit-2026-10-10');
  for(const [name,content] of [['original-script.md',script.content],['confirmed-director-plan.md',data.scriptPlan]]) {
    fs.writeFileSync(path.join(dir,name),String(content??''),{flag:'wx'});
  }
  const progress=data.storyboardTableProgress;
  console.log(JSON.stringify({scriptChars:script.content.length,planChars:data.scriptPlan.length,progress:progress&&{taskId:progress.taskId,total:progress.total,revision:progress.revision,complete:progress.complete,savedScenes:Object.keys(progress.scenes??{})}}));
} finally {db.close();}
