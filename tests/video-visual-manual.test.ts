import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {getArtPrompt} from '../src/utils/getArtPrompt';
test('video manual uses its own rendering medium while asset design remains illustration',()=>{
 const video=getArtPrompt('realistic_3d_anime','art_skills','art_storyboard_video');
 const character=getArtPrompt('realistic_3d_anime','art_skills','art_character');
 assert.ok(video.startsWith('# 视频渲染目标'));
 assert.match(video,/cinematic semi-realistic 3D animation/);
 assert.match(video,/physically based/);
 assert.doesNotMatch(video,/统一目标为精品二次元写实幻想角色原画|保持有体积的插画渲染|维持插画质感/);
 assert.ok(character.startsWith('# 全局美学基础'));
 assert.match(character,/polished illustration rendering/);
 assert.doesNotMatch(character,/# 视频渲染目标/);
 assert.equal(getArtPrompt('realistic_3d_anime','art_skills','art_storyboard_video.md'),video);
});
test('other styles retain their existing shared prefix unless they provide a video override',()=>{
 const root='data/skills/art_skills';
 const entry=fs.readdirSync(root).find(name=>name!=='realistic_3d_anime'&&fs.existsSync(root+'/'+name+'/prefix.md')&&!fs.existsSync(root+'/'+name+'/video_prefix.md'));
 assert.ok(entry);
 const prefix=fs.readFileSync(root+'/'+entry+'/prefix.md','utf8');
 assert.ok(getArtPrompt(entry,'art_skills','art_storyboard_video').startsWith(prefix));
});
