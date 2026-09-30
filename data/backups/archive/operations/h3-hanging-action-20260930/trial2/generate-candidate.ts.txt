import fs from 'node:fs';
import { createRequire } from 'node:module';
import { transform } from 'sucrase';
import knex from 'knex';

async function main() {
  const dir = 'data/backups/h3-hanging-action-20260930/trial2';
  const db = knex({client:'better-sqlite3',connection:{filename:`${dir}/probe.sqlite`},useNullAsDefault:true});
  const localRequire = createRequire(`${process.cwd()}/package.json`);
  // Inject the copied database before loading ANY application utilities. Importing
  // the live db module runs startup recovery and incorrectly fails active jobs.
  const dbModule = localRequire.resolve('./src/utils/db.ts');
  localRequire.cache[dbModule] = {id:dbModule,filename:dbModule,loaded:true,exports:{__esModule:true,default:db,db}} as any;
  const u = localRequire('./src/utils').default;
  const service = {exports:{} as any};
  let call = 0;
  const probeU = {...u, db, Ai: {...u.Ai, Text: (...args:any[]) => {
    const client = (u.Ai.Text as any)(...args);
    return {invoke: async (request:any) => {
      const number = ++call;
      fs.writeFileSync(`${dir}/candidate-system-${number}.txt`,request.system);
      const result = await client.invoke(request);
      fs.writeFileSync(`${dir}/candidate-response-${number}.txt`,result.text);
      return result;
    }};
  }}};
  const imports:any = {'@/utils':probeU,'@/utils/db':{db}};
  new Function('require','module','exports',transform(fs.readFileSync('src/utils/videoPromptGeneration.ts','utf8'),{transforms:['typescript','imports']}).code)((id:string)=>imports[id]||localRequire(id),service,service.exports);
  try {
    const request = JSON.parse(fs.readFileSync('data/backups/h3-reference-refresh-20260930/request.json','utf8'));
    const track = request.trackData.find((t:any)=>t.trackId===1790715576565);
    const result = await service.exports.generateVideoPromptForTrack({projectId:request.projectId,model:request.model,mode:request.mode,...track,languages:['en-US'],regenerate:true,replaceBasePrompt:true});
    fs.writeFileSync(`${dir}/candidate-result.json`,JSON.stringify(result,null,2));
    const row = await db('o_videoPromptVariant').where({trackId:track.trackId,language:'en-US'}).first();
    if(row.state!=='已完成') throw new Error(row.reason);
    fs.writeFileSync(`${dir}/candidate-prompt.txt`,row.prompt);
    console.log('Candidate generated and validated in isolated database; live prompts and videos untouched.');
  } finally {await db.destroy();}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
