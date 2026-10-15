import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseStoryboardTimeline} from '../../src/agents/productionAgent/storyboardTimeline';
import {extractSourceScene,validateStoryboardScene} from '../../src/agents/productionAgent/storyboardValidator';
import {productionSceneBudget} from '../../src/agents/productionAgent/screenplay';
import {storyboardRoleParentMap} from '../../src/agents/productionAgent/storyboardContext';
const dir=path.resolve('docs/ui-flow-audit-2026-10-10');
const label=process.argv[2];
if(!label||!/^[a-z0-9-]+$/.test(label))throw Error('snapshot label required');
const read=(name:string)=>fs.readFileSync(path.join(dir,name),'utf8');
const final=JSON.parse(read(label+'.json'));
const before=JSON.parse(read('before-reload.json'));
const initial=JSON.parse(read('before-last-runtime.json'));
const preservedFirst=JSON.parse(read('after-memory-stop.json'));
const preservedSecond=JSON.parse(read('bridge-fixed.json'));
const table=read(label+'.storyboard.md');
const script=read('original-script.md'),plan=read('confirmed-director-plan.md');
const headings=[...table.matchAll(/^##\s*场\s*(\d+)\s*[：:]/gm)];
const validations=headings.map((heading,index)=>{
 const scene=Number(heading[1]);
 return validateStoryboardScene(scene,table.slice(heading.index!,headings[index+1]?.index??table.length),extractSourceScene(script,scene),{targetDuration:productionSceneBudget(plan,scene,extractSourceScene(script,scene)),assetIds:final.assets.map((asset:any)=>asset.id),assetParentMap:storyboardRoleParentMap(final.assets)});
});
const ledger=parseStoryboardTimeline(table);
const checks={
 sourceUnchanged:final.sourceHash===before.sourceHash,
 confirmedPlanUnchanged:final.planHash===before.planHash,
 allImageRecordsUnchanged:JSON.stringify(final.imageHashes)===JSON.stringify(before.imageHashes),
 allVideoRecordsUnchanged:JSON.stringify(final.videoHashes)===JSON.stringify(before.videoHashes),
 assetImageSelectionsUnchanged:JSON.stringify(final.assets.map((a:any)=>[a.id,a.imageId]))===JSON.stringify(before.assets.map((a:any)=>[a.id,a.imageId])),
 countsUnchanged:JSON.stringify(final.counts)===JSON.stringify(before.counts),
 originalStoryboardTaskPreserved:final.storyboardProgress?.taskId===initial.storyboardProgress?.taskId,
 qualifiedFirstScenePreserved:final.storyboardProgress?.sceneHashes['1']===preservedFirst.storyboardProgress?.sceneHashes['1'],
 qualifiedSecondScenePreserved:final.storyboardProgress?.sceneHashes['2']===preservedSecond.storyboardProgress?.sceneHashes['2'],
 scenesComplete:JSON.stringify(headings.map(h=>Number(h[1])))===JSON.stringify([1,2,3])&&final.storyboardProgress?.complete===true,
 noActiveGeneration:final.activeRuns.length===0&&final.activeTasks.length===0,
 structurallyValid:validations.length===3&&validations.every(v=>v.valid)&&ledger.errors.length===0,
 budgetsMatched:JSON.stringify(ledger.scenes.map(s=>s.duration))===JSON.stringify([25,20,50]),
};
const report={at:new Date().toISOString(),snapshot:label,projectId:final.projectId,scriptId:final.scriptId,checks,tableHash:createHash('sha256').update(table).digest('hex'),storyboardProgress:final.storyboardProgress,validations,ledger,acceptanceBoundary:'Program checks cover structure, exact parseable dialogue and screen text, timing totals and preservation. Direct content review is recorded separately in review.md. No new image or video was generated or visually accepted.'};
fs.writeFileSync(path.join(dir,label+'.verification.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({checks,shots:ledger.scenes.map(scene=>({scene:scene.scene,shots:ledger.shots.filter(s=>s.scene===scene.scene).length,duration:scene.duration})),errors:validations.flatMap(v=>v.errors)}));
if(!Object.values(checks).every(Boolean))process.exitCode=1;
