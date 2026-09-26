const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const DB = require('better-sqlite3');
const { assertH3PromptContract } = require('../../src/utils/h3PromptContract.ts');
const { assertH3ReferenceBindings } = require('../../src/utils/h3ReferenceBindings.ts');
const root = process.cwd();
const ids = [1790319537445, 1790319543870];
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const snapshot = new DB(path.join(__dirname, 'snapshot.sqlite'), { readonly: true });
const live = new DB(path.join(root, 'data/db2.sqlite'));
live.pragma('busy_timeout = 5000');
const approved = ids.map(id => {
  const dir = path.join(__dirname, String(id));
  const source = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
  const base = fs.readFileSync(path.join(dir, 'base.txt'), 'utf8');
  const english = fs.readFileSync(path.join(dir, 'en-US.txt'), 'utf8');
  const track = snapshot.prepare('SELECT * FROM o_videoTrack WHERE id=?').get(id);
  const variant = snapshot.prepare('SELECT * FROM o_videoPromptVariant WHERE trackId=? AND language=?').get(id, 'en-US');
  assert.equal(track.state, '已完成'); assert.equal(variant.state, '已完成');
  assert.equal(track.prompt, base); assert.equal(variant.prompt, english);
  const plans = [base, english].map(prompt => {
    const row = snapshot.prepare('SELECT * FROM o_h3ReferencePlan WHERE trackId=? AND promptHash=?').get(id, hash(prompt));
    assert.ok(row, 'Missing approved immutable plan');
    const plan = JSON.parse(row.plan);
    assert.equal(plan.slots.length, source.assets.length);
    assert.ok(plan.slots.every(slot => !slot.kind), 'Only whole reference sheets may be promoted');
    assertH3PromptContract(prompt, Number(source.duration), plan.slots.length);
    assertH3ReferenceBindings(prompt, plan.slots, prompt === english ? base : undefined);
    assert.deepEqual(plan.slots.map(s => [s.assetId, s.path]), source.assets.map(a => [a.id, a.filePath]));
    return row;
  });
  return { id, source, base, english, plans };
});
function beforeState() {
  return ids.map(id => ({
    track: live.prepare('SELECT * FROM o_videoTrack WHERE id=?').get(id),
    variants: live.prepare('SELECT * FROM o_videoPromptVariant WHERE trackId=? ORDER BY language').all(id),
    plans: live.prepare('SELECT * FROM o_h3ReferencePlan WHERE trackId=? ORDER BY promptHash').all(id),
    videos: live.prepare('SELECT * FROM o_video WHERE videoTrackId=? ORDER BY id').all(id),
    videoLanguages: live.prepare('SELECT l.* FROM o_videoLanguage l JOIN o_video v ON v.id=l.videoId WHERE v.videoTrackId=? ORDER BY l.videoId').all(id),
  }));
}
const backupPath = path.join(__dirname, 'before-live-promotion-' + Date.now() + '.json');
let receipt;
try {
  live.transaction(() => {
    const before = beforeState();
    for (const item of approved) {
      const state = before.find(s => s.track.id === item.id);
      assert.notEqual(state.track.state, '生成中');
      assert.ok(!state.videos.some(v => v.state === '生成中'), 'Target video generation is still running');
      assert.equal(state.track.projectId, item.source.request.projectId);
      assert.equal(Number(state.track.duration), Number(item.source.duration));
      const story = live.prepare('SELECT id,duration,videoDesc FROM o_storyboard WHERE trackId=? ORDER BY id').all(item.id);
      assert.deepEqual(story, item.source.story, 'Storyboard changed since generation');
      const assets = live.prepare('SELECT DISTINCT a.id,a.name,a.type,a.imageId,i.filePath FROM o_assets a LEFT JOIN o_image i ON i.id=a.imageId JOIN o_assets2Storyboard l ON l.assetId=a.id JOIN o_storyboard s ON s.id=l.storyboardId WHERE s.trackId=? ORDER BY a.id').all(item.id);
      assert.deepEqual(assets, item.source.assets, 'Reference assets changed since generation');
    }
    fs.writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), before }, null, 2), { flag: 'wx' });
    for (const item of approved) {
      for (const plan of item.plans) {
        live.prepare('INSERT INTO o_h3ReferencePlan (trackId,promptHash,plan) VALUES (?,?,?) ON CONFLICT(trackId,promptHash) DO NOTHING').run(plan.trackId, plan.promptHash, plan.plan);
        assert.equal(live.prepare('SELECT plan FROM o_h3ReferencePlan WHERE trackId=? AND promptHash=?').get(plan.trackId, plan.promptHash).plan, plan.plan);
      }
      assert.equal(live.prepare('UPDATE o_videoTrack SET prompt=?,state=?,reason=NULL WHERE id=? AND projectId=?').run(item.base, '已完成', item.id, item.source.request.projectId).changes, 1);
      live.prepare('INSERT INTO o_videoPromptVariant (trackId,language,prompt,state,reason) VALUES (?,?,?,?,NULL) ON CONFLICT(trackId,language) DO UPDATE SET prompt=excluded.prompt,state=excluded.state,reason=NULL').run(item.id, 'en-US', item.english, '已完成');
    }
    const after = beforeState();
    for (let i = 0; i < before.length; i++) {
      const b = before[i], a = after[i], candidate = approved[i];
      assert.deepEqual(a.videos, b.videos); assert.deepEqual(a.videoLanguages, b.videoLanguages);
      assert.deepEqual(a.track, { ...b.track, prompt: candidate.base, state: '已完成', reason: null });
      assert.deepEqual(a.variants, b.variants.map(v => v.language === 'en-US' ? { ...v, prompt: candidate.english, state: '已完成', reason: null } : v));
      for (const old of b.plans) assert.ok(a.plans.some(p => p.promptHash === old.promptHash && p.plan === old.plan));
    }
    receipt = { savedAt: new Date().toISOString(), backupPath, tracks: approved.map(c => ({ id: c.id, baseHash: hash(c.base), englishHash: hash(c.english), references: c.source.assets.length, historyPreserved: true })) };
  }).immediate();
  fs.writeFileSync(path.join(__dirname, 'promotion-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { snapshot.close(); live.close(); }
