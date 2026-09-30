import fs from 'node:fs';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
const dir = 'data/backups/h3-hanging-action-20260930';
const db = new Database('data/db2.sqlite');
const id = 2, projectId = 1790665121730, trackId = 1790715576565;
const row = db.prepare('SELECT * FROM o_storyboard WHERE id=? AND projectId=? AND trackId=?').get(id,projectId,trackId);
assert.ok(row);
assert.ok(!fs.existsSync(`${dir}/storyboard-before.json`),'Do not overwrite the original snapshot');
fs.writeFileSync(`${dir}/storyboard-before.json`,JSON.stringify(row,null,2));
fs.writeFileSync(`${dir}/prompts-before.json`,JSON.stringify({track:db.prepare('SELECT * FROM o_videoTrack WHERE id=?').get(trackId),variants:db.prepare('SELECT * FROM o_videoPromptVariant WHERE trackId=?').all(trackId)},null,2));
await db.backup(`${dir}/before.sqlite`);
const text = row.videoDesc
  .replace('湿滑甲板形成陡坡，艾娃悬在斜坡外侧，左腿缠裹的深色布条与裤料完整遮盖伤处，双手死死抓住斜栏杆；画面上方高处只露出仅剩一个位置的救生艇吊架。','开场艾娃已经悬空挂在邮轮外侧围栏上：双手在头顶上方死死抓住上沿，双臂承受全身重量，躯干和双腿垂在围栏及甲板边缘下方，两只靴子悬在海面上方，与甲板、船壳和横杆均有清晰空隙。镜头同时交代双手、全身、双脚和脚下海面；倾斜甲板位于抓握点内侧上方。左腿深色布条与裤料完整遮盖伤处，远处上方只露出仅剩一个位置的救生艇吊架。')
  .replace('| 2 | 全景 | 手持跟随甲板坡度下压 |','| 2 | 人物全景（手到双脚完整入画） | 船外侧视角，轻微手持下压，保持抓握点、悬空全身及脚下海面同框 |')
  .replace('艾娃仰头望向斜坡上方，手指因用力发白，身体随船身震动外滑；她在风雨中嘶声呼喊，尾音被浪声吞没。','艾娃仍靠头顶上方双手悬吊在船外，仰头望向抓握点上方的甲板；手指因承重发白，船身震动使抓握略微打滑、悬空身体向下沉，双脚始终离开所有支撑。她在风雨中嘶声呼喊，尾音被浪声吞没。')
  .replace('从栏杆手部急促上摇到艾娃面部','从高处抓握栏杆的双手沿受力手臂急促下移到下方仰起的面部，保持双臂向上承重的关系');
assert.notEqual(text,row.videoDesc);
assert.ok(text.includes('两只靴子悬在海面上方'));
assert.ok(!text.includes('急促上摇'));
const result=db.prepare('UPDATE o_storyboard SET videoDesc=? WHERE id=? AND projectId=? AND trackId=? AND videoDesc=?').run(text,id,projectId,trackId,row.videoDesc);
assert.equal(result.changes,1);
const after=db.prepare('SELECT * FROM o_storyboard WHERE id=?').get(id);
fs.writeFileSync(`${dir}/storyboard-after.json`,JSON.stringify(after,null,2));
assert.equal(after.videoDesc,text);
await db.backup(`${dir}/probe.sqlite`);
db.close();
const script=fs.readFileSync('data/backups/h3-style-research-20260930/generate-candidate.ts','utf8')
 .replace("const dir = 'data/backups/h3-style-research-20260930';",`const dir = '${dir}';`)
 .replace('replaceBasePrompt:false','replaceBasePrompt:true');
fs.writeFileSync(`${dir}/generate-candidate.ts`,script);
console.log('Clarified and read back storyboard 2 only; original database and prompts backed up.');
