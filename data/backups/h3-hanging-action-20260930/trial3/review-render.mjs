import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir='data/backups/h3-hanging-action-20260930/trial3';
const id=JSON.parse(fs.readFileSync(`${dir}/candidate-submission.json`)).prompt_id;
const ws=new WebSocket(`ws://127.0.0.1:8188/ws?clientId=hanging-review-${Date.now()}`);
ws.onmessage=e=>{try{const v=JSON.parse(e.data);if(v.data?.prompt_id===id&&['progress','execution_error'].includes(v.type))console.log(JSON.stringify(v));}catch{}};
const deadline=Date.now()+420000;
while(Date.now()<deadline){
  const h=await(await fetch(`http://127.0.0.1:8188/history/${id}`)).json();
  if(h[id]){
    fs.writeFileSync(`${dir}/candidate-history.json`,JSON.stringify(h,null,2));
    if(h[id].status.status_str!=='success')throw Error(JSON.stringify(h[id].status));
    const o=h[id].outputs['14'].images[0];
    const source=path.join('D:/new_comfyui/output',o.subfolder,o.filename);
    for(const t of [0.2,0.8,1.5,2.5,3.5,4.6])execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(t),'-i',source,'-frames:v','1','-q:v','2',`${dir}/frame-${t}.jpg`]);
    console.log('FRAMES_READY',source);ws.close();process.exit(0);
  }
  await new Promise(r=>setTimeout(r,10000));
}
ws.close();throw Error('Render observation timeout; generation was not interrupted.');
