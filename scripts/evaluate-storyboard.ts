/** Real configured text model, read-only production DB, untouched per-scene responses. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {generateText,tool,jsonSchema,stepCountIs} from 'ai';
import {loadVendorTemplate,resolveDirectorDeployment} from './evaluate-director-plan';
import {buildStoryboardContext,storyboardTemperature,storyboardOutputTokenLimit} from '../src/agents/productionAgent/storyboardContext';
import {parseScriptScenes,productionSceneBudget} from '../src/agents/productionAgent/screenplay';
import {validateStoryboardScene} from '../src/agents/productionAgent/storyboardValidator';
import {extractStoryboardTable} from '../src/agents/productionAgent/storyboardTable';
import {buildSkillPrompt,createSkillTools,parseFrontmatter,scanSkills} from '../src/utils/agent/skillsTools';
import {withContentConstraints} from '../src/utils/contentConstraints';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const Database=createRequire(path.resolve('package.json'))('better-sqlite3');
const secrets:string[]=[];
const redact=(s:string)=>secrets.reduce((text,secret)=>text.split(secret).join('[REDACTED]'),s);

async function main(){
 const args=new Map<string,string>();
 for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1]) throw Error('需要 --episode ID --output 唯一名称 [--scene N --review-candidate 文件 --review-feedback 文件]');args.set(process.argv[i].slice(2),process.argv[i+1]);}
 const episode=Number(args.get('episode')),name=args.get('output')??'';
 if(!Number.isSafeInteger(episode)||episode<=0||!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error('episode/output 无效');
 const dir=path.resolve('docs/storyboard-evaluation',name);
 await fs.mkdir(dir,{recursive:false});
 const db=new Database(path.resolve('data/db2.sqlite'),{readonly:true});
 let source:any,project:any,data:any,assets:any[],config:any,child:any,mode:string,vendor:any,settings:any;
 try{
  source=db.prepare('select * from o_script where id=?').get(episode);
  if(!source?.content)throw Error('来源剧本为空');
  project=db.prepare('select * from o_project where id=?').get(source.projectId);
  data=JSON.parse(db.prepare("select data from o_agentWorkData where projectId=? and episodesId=? and key='productionAgent'").get(source.projectId,episode).data);
  if(!data.scriptPlan)throw Error('尚无已确认导演规划');
  const linked=db.prepare('select assetId from o_scriptAssets where scriptId=?').all(episode).map((a:any)=>Number(a.assetId));
  const projectAssets=db.prepare('select asset.id,asset.name,asset.type,asset.assetsId,asset.describe,asset.imageId,image.state as imageState,image.filePath as imagePath,image.errorReason as imageError from o_assets asset left join o_image image on asset.imageId=image.id where asset.projectId=? order by asset.id').all(source.projectId);
  assets=projectAssets.filter((a:any)=>linked.includes(a.id)||linked.includes(a.assetsId)).map((a:any)=>({id:Number(a.id),parentAssetId:a.assetsId==null?null:Number(a.assetsId),name:a.name??'',type:a.type??'',description:a.describe??'',imageId:a.imageId??null,imageState:a.imageState??'未生成',imageAvailable:Boolean(a.imagePath),imageError:a.imageError??''}));
  mode=db.prepare("select value from o_setting where key='agentUseMode'").get()?.value;
  child=db.prepare("select * from o_agentDeploy where key='productionAgent:storyboardTableAgent'").get();
  config=resolveDirectorDeployment(mode,child,db.prepare("select * from o_agentDeploy where key='productionAgent'").get());
  const vendorId=String(config.modelName).split(':')[0];
  if(!/^[\w-]+$/.test(vendorId)) throw Error('vendor ID 无效');
  vendor=db.prepare('select inputValues,models from o_vendorConfig where id=?').get(vendorId);
  settings=JSON.parse(vendor.inputValues);
  for(const [key,value]of Object.entries(settings)) if(/key|token|secret|password/i.test(key)&&typeof value==='string'&&value)secrets.push(value,value.replace(/^Bearer\s+/i,''));
 }finally{db.close();}
 const skillsRoot=path.resolve('data/skills');
 const mainFiles=[...await scanSkills(path.join(skillsRoot,'art_skills',project.artStyle,'driector_skills','*.md')),
 ...await scanSkills(path.join(skillsRoot,'story_skills',project.directorManual,'driector_skills','*.md')),
 ...await scanSkills(path.join(skillsRoot,'production_skills','*.md'))];
 const skills=await Promise.all(mainFiles.map(async file=>({path:file,...parseFrontmatter(await fs.readFile(file,'utf8'))})));
 const skillReads:{path:string;hash:string}[]=[];
 const read=async(file:string)=>{const text=await fs.readFile(file,'utf8');skillReads.push({path:file,hash:hash(text)});return text;};
 const system=withContentConstraints(await read(path.join(skillsRoot,'production_execution_storyboard_table.md')));
 const requests:Record<string,unknown>[]=[];
 const [vendorId,modelName]=String(config.modelName).split(/:(.+)/);
 const adapter=loadVendorTemplate(await fs.readFile(path.resolve('data/vendor',vendorId+'.ts'),'utf8'),requests);
 Object.assign(adapter.vendor.inputValues,settings);
 adapter.vendor.models=[...new Map([...adapter.vendor.models,...JSON.parse(vendor.models??'[]')].map(m=>[m.modelName,m])).values()];
 const modelConfig=adapter.vendor.models.find((m:any)=>m.modelName===modelName&&m.type==='text');
 if(!modelConfig)throw Error('当前有效文本模型不存在');
 const model=await adapter.textRequest(modelConfig,false,0);
 const scenes=parseScriptScenes(source.content),selected=args.has('scene')?scenes.filter(s=>s.scene===Number(args.get('scene'))):scenes;
 if(!selected.length)throw Error('指定场次不存在');
 if(Boolean(args.get('review-candidate'))!==Boolean(args.get('review-feedback')))throw Error('候选和反馈需要成对指定');
 const temperature=storyboardTemperature(config.temperature),maxOutputTokens=storyboardOutputTokenLimit(config.maxOutputTokens);
 const taskId='isolated-'+name;
 const outputs:Record<string,string>={};
 const result:any={episode,projectId:source.projectId,mode,model:config.modelName,think:false,thinkLevel:0,temperature,maxOutputTokens,sourceHash:hash(source.content),planHash:hash(data.scriptPlan),systemHash:hash(JSON.stringify(system)),contextHash:hash(await fs.readFile(path.resolve('src/agents/productionAgent/storyboardContext.ts'),'utf8')),skillReads,requests,scenes:[]};
 const modelInfo=`项目使用的模型如下：\n图像模型：${project.imageModel.split(':').slice(1).join(':')}\n视频模型：${project.videoModel.split(':').slice(1).join(':')}\n多参：是`;
 for(const scene of selected){
  const skillTools=createSkillTools(skills,{mainSkill:skills,secondarySkills:[],tertiarySkills:[]},skillsRoot,read);
  const previousScene=outputs[String(scene.scene-1)]??(args.has('previous-scene')?await fs.readFile(path.resolve(args.get('previous-scene')!),'utf8'):'');
  const protocol=`\n【后端固定任务协议】只处理第${scene.scene}场，共${scenes.length}场，task=${taskId}。必须仅输出一份完整闭合的 <storyboardTable scene="${scene.scene}" total="${scenes.length}" task="${taskId}">该场完整Markdown</storyboardTable>；不要生成其他场次，不要自行变更 task/total。\n${buildStoryboardContext(source.content,data.scriptPlan,scene.scene,assets!,previousScene)}\n创作要求：依据已确认导演规划生成当前场完整可执行分镜表。`;
  const messages:any[]=[{role:'assistant',content:buildSkillPrompt(skills)+'\n'+modelInfo},{role:'user',content:protocol}];
  if(Boolean(args.get('review-directory'))!==Boolean(args.get('review-feedback-directory')))throw Error('整集候选目录与反馈目录需要成对指定');
  if(args.has('review-directory')) {
   const candidate=path.resolve(args.get('review-directory')!,`scene-${scene.scene}.attempt-1.response.xml`);
   const feedback=path.resolve(args.get('review-feedback-directory')!,`scene-${scene.scene}-feedback.md`);
   messages.push({role:'assistant',content:await fs.readFile(candidate,'utf8')},{role:'user',content:'【直接审稿反馈，仅指出旧候选问题，不是新增剧本事实】\n'+await fs.readFile(feedback,'utf8')+'\n保持初始剧本事实、原台词、真实资产及导演节拍，逐项修复重新输出当前场。使用初始后端新分配的task/total，旧候选task不得复用。只输出当前场唯一完整闭合 XML，不输出草稿、自评或说明。'});
  }
  if(args.has('review-candidate')){
   if(selected.length!==1)throw Error('直接反馈只允许单场');
   messages.push({role:'assistant',content:await fs.readFile(path.resolve(args.get('review-candidate')!),'utf8')},{role:'user',content:'上一候选直接审稿反馈，不能作为新剧本事实：\n'+await fs.readFile(path.resolve(args.get('review-feedback')!),'utf8')+'\n保留原事实、完整台词、屏幕文字、已确认节拍和预算，重新输出当前场唯一闭合 XML。'});
  }
  await fs.writeFile(path.join(dir,`scene-${scene.scene}.input.json`),JSON.stringify({system,messages},null,2),{flag:'wx'});
  for(let attempt=1;attempt<=3;attempt++){
   const started=Date.now();
   await fs.writeFile(path.join(dir,`scene-${scene.scene}.attempt-${attempt}.input.json`),JSON.stringify({system,messages},null,2),{flag:'wx'});
   const generated=await generateText({model,system,messages,temperature,maxOutputTokens,abortSignal:AbortSignal.timeout(600000),stopWhen:stepCountIs(12),tools:{...skillTools,
    get_flowData:tool({description:'只读本次来源、已确认规划、资产及逻辑前场；不写入生产库',inputSchema:jsonSchema<any>({type:'object',properties:{key:{type:'string',enum:['script','scriptPlan','assets','storyboardTable']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:12000}},required:['key']}),execute:async({key,offset,limit})=>{
     const value=key==='script'?source.content:key==='scriptPlan'?data.scriptPlan:key==='assets'?data.assets:key==='storyboardTable'?Object.values(outputs).join('\n\n'):'';
     if(offset===undefined&&limit===undefined)return value;
     if(typeof value==='string'||Array.isArray(value)){const start=offset??0,count=limit??(typeof value==='string'?6000:10),end=Math.min(start+count,value.length);return {data:value.slice(start,end),offset:start,total:value.length,nextOffset:end<value.length?end:null};}return value;
    }})}});
   const prefix=path.join(dir,`scene-${scene.scene}.attempt-${attempt}`);
   await fs.writeFile(prefix+'.response.xml',generated.text,{flag:'wx'});
   const errors:string[]=[];let markdown='';let validation:any=null;
   try{const parsed=extractStoryboardTable(generated.text);if(parsed.mode!=='scene'||parsed.scene!==scene.scene||parsed.total!==scenes.length||parsed.taskId!==taskId)throw Error('当前场或task/total不符');markdown=parsed.content;validation=validateStoryboardScene(scene.scene,markdown,scene.text,{targetDuration:productionSceneBudget(data.scriptPlan,scene.scene,scene.text),assetIds:assets!.map(a=>a.id)});errors.push(...validation.errors);}catch(e){errors.push((e as Error).message);}
   await fs.writeFile(prefix+'.md',markdown||generated.text,{flag:'wx'});
   const evidence={scene:scene.scene,attempt,errors,validation,previousSceneHash:hash(previousScene),finishReason:generated.finishReason,usage:generated.usage,elapsedMs:Date.now()-started,rawHash:hash(generated.text),raw:prefix+'.response.xml',markdown:prefix+'.md',toolCalls:generated.steps.flatMap(s=>s.toolCalls.map(t=>({name:t.toolName,input:t.input})))};
   result.scenes.push(evidence);
   await fs.writeFile(prefix+'.json',JSON.stringify(evidence,null,2),{flag:'wx'});
   console.log(JSON.stringify(evidence));
   if(!errors.length){outputs[String(scene.scene)]=markdown;break;}
   if(attempt===3)break;
   for(const step of generated.steps){const content:any[]=[];for(const t of step.toolResults)if(t.toolName==='activate_skill'||t.toolName==='read_skill_file')content.push({name:t.toolName,result:t.output});if(content.length)messages.push({role:'assistant',content:'本次已加载技能正文（继续沿用）：\n'+JSON.stringify(content)});}
   messages.push({role:'assistant',content:generated.text},{role:'user',content:`上一候选未通过检查，具体问题：\n${errors.join('\n')}\n修复后重新生成当前场完整唯一闭合 XML，事实、台词、节拍预算以最初来源为准。`});
  }
 }
 await fs.writeFile(path.join(dir,'candidate.md'),Object.values(outputs).join('\n\n'),{flag:'wx'});
 await fs.writeFile(path.join(dir,'evaluation.json'),JSON.stringify(result,null,2),{flag:'wx'});
 if(Object.keys(outputs).length!==selected.length)process.exitCode=1;
}
main().catch(e=>{console.error(redact(e instanceof Error?e.message:String(e)));process.exitCode=1;});
