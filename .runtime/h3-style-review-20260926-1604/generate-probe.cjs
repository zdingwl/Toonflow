const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const DB = require("better-sqlite3");
const knex = require("knex");
const { transform } = require("sucrase");
const repo = process.cwd(), out = __dirname;
const trackIds = process.argv.slice(2).map(Number);
const loadCache = new Map();
const u = {};
let db;
function load(file) {
  const abs = path.resolve(repo, file);
  if (loadCache.has(abs)) return loadCache.get(abs).exports;
  const mod = { exports: {} };
  loadCache.set(abs, mod);
  const req = createRequire(abs);
  const injected = id => id === "@/utils" ? u : id === "@/utils/db" ? { db } : req(id);
  new Function("require", "module", "exports", transform(fs.readFileSync(abs,"utf8"), { transforms: ["typescript","imports"] }).code)(injected,mod,mod.exports);
  return mod.exports;
}
async function main() {
  const snapshot = path.join(out,"snapshot.sqlite");
  if (!fs.existsSync(snapshot)) {
    const original = new DB(path.join(repo,"data/db2.sqlite"),{readonly:true});
    await original.backup(snapshot);
    original.close();
  }
  db = knex({client:"better-sqlite3",connection:{filename:snapshot},useNullAsDefault:true});
  u.db = db;
  u.getPath = require(path.join(repo,"src/utils/getPath.ts")).default;
  u.getArtPrompt = require(path.join(repo,"src/utils/getArtPrompt.ts")).getArtPrompt;
  u.error = require(path.join(repo,"src/utils/error.ts")).default;
  u.oss = require(path.join(repo,"src/utils/oss.ts")).default;
  u.vm = load("src/utils/vm.ts").default;
  u.vendor = load("src/utils/vendor.ts");
  const realAi = load("src/utils/ai.ts").default;
  const model = await db("o_agentDeploy").where({key:"universalAi"}).select("modelName").first();
  let activeDir, call = 0;
  u.Ai = { Text: (...args) => {
    const client = realAi.Text(...args);
    return {invoke: async input => {
      const id = ++call, start=Date.now();
      console.log(JSON.stringify({event:"model_start",track:path.basename(activeDir),call:id,model:model.modelName}));
      const safeMessages = input.messages.map(m=>({...m,content: typeof m.content==="string" ? m.content : m.content.map(p=>p.type==="image"? {type:"image",mediaType:p.mediaType,bytes:p.image.length}:p)}));
      fs.writeFileSync(path.join(activeDir,"call-"+id+"-input.json"),JSON.stringify({system:input.system,messages:safeMessages},null,2));
      const result = await client.invoke(input);
      fs.writeFileSync(path.join(activeDir,"call-"+id+"-raw.txt"),result.text);
      const meta={event:"model_done",track:path.basename(activeDir),call:id,elapsedSeconds:(Date.now()-start)/1000,finishReason:result.finishReason,usage:result.usage};
      fs.writeFileSync(path.join(activeDir,"call-"+id+"-meta.json"),JSON.stringify(meta,null,2));
      console.log(JSON.stringify(meta));
      return result;
    }};
  }};
  await db("o_videoTrack").where({id:1790319537445}).update({duration:4});
  await db("o_storyboard").where({trackId:1790319537445}).update({duration:"4",videoDesc:"【风格核验样片，4秒，单一连续近景】\n使用当前四个参考资产：艾娃(115)、麦迪逊(116)、末世海洋(118)、巨鲨(128)。每个人物使用现有完整四视图板，不拆图。\n场景：风暴海面上的倾斜船舷，人物不坠落、不受伤。镜头固定在两位人物胸部以上的近景，艾娃在前，麦迪逊在旁。两张脸以正面至轻微三分之二侧面可见，保持参考图的脸部结构、眼睛相对面部的比例和现有服装。麦迪逊的手轻搭艾娃肩部，4秒内人物仅轻微转动视线，风轻轻带动发丝。背景船舷和海面保持与场景参考一致，远处海面只露出同一条巨鲨的一小段背鳍，不靠近人物。\n人物的写实程度及皮肤、发丝、布料的表面表现沿用当前角色参考图；风暴冷光改变受光，不重新设计人物。保持嘴闭，无对白、无笑声或惨叫；只有海风和远处波浪声，无配乐。\n此为独立风格测试，不承接正式片段的坠落动作。"});
  const {generateVideoPromptForTrack} = load("src/utils/videoPromptGeneration.ts");
  const {loadH3ReferencePlan} = require(path.join(repo,"src/utils/h3ReferencePlan.ts"));
  for (const trackId of trackIds) {
    activeDir=path.join(out,String(trackId)); fs.mkdirSync(activeDir,{recursive:true}); call=0;
    const track=await db("o_videoTrack").where({id:trackId}).first();
    const story=await db("o_storyboard").where({trackId}).orderBy("id");
    const links=await db("o_assets2Storyboard").whereIn("storyboardId",story.map(s=>s.id));
    const assets=await db("o_assets").leftJoin("o_image","o_image.id","o_assets.imageId").whereIn("o_assets.id",[...new Set(links.map(l=>l.assetId))]).select("o_assets.id","o_assets.name","o_assets.type","o_assets.imageId","o_image.filePath").orderBy("o_assets.id");
    const info=[...assets.map(a=>({id:a.id,sources:"assets"})),...story.map(s=>({id:s.id,sources:"storyboard",reference:false}))];
    const request={trackId,projectId:track.projectId,model:"comfyui_local:MiniMax-H3-local",mode:'["imageReference:9"]',info,languages:["en-US"],regenerate:true,replaceBasePrompt:true};
    fs.writeFileSync(path.join(activeDir,"source.json"),JSON.stringify({trackId,duration:track.duration,request,assets,story:story.map(s=>({id:s.id,duration:s.duration,videoDesc:s.videoDesc})),model:model.modelName},null,2));
    try {
      const result=await generateVideoPromptForTrack(request);
      fs.writeFileSync(path.join(activeDir,"result.json"),JSON.stringify(result,null,2));
    } catch(e) {
      fs.writeFileSync(path.join(activeDir,"error.txt"),e.message);
      console.log(JSON.stringify({event:"generation_error",trackId,message:e.message}));
    }
    const saved=await db("o_videoTrack").where({id:trackId}).first();
    const variant=await db("o_videoPromptVariant").where({trackId,language:"en-US"}).first();
    fs.writeFileSync(path.join(activeDir,"base.txt"),saved.prompt||"");
    fs.writeFileSync(path.join(activeDir,"en-US.txt"),variant?.prompt||"");
    const plan=await loadH3ReferencePlan(db,trackId,variant?.prompt||"");
    fs.writeFileSync(path.join(activeDir,"plan.json"),JSON.stringify(plan,null,2));
    console.log(JSON.stringify({event:"track_result",trackId,state:saved.state,variantState:variant?.state,reason:variant?.reason,pictures:plan?.slots.length,output:activeDir}));
  }
  await db.destroy();
}
main().catch(async e=>{console.error(e.message); if(db) await db.destroy(); process.exitCode=1;});

