const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const DB = require('better-sqlite3');
async function main() {
  const db = new DB(path.join(process.cwd(), 'data/db2.sqlite'), { readonly: true });
  const user = db.prepare('SELECT name,password FROM o_user ORDER BY id LIMIT 1').get();
  db.close();
  const endpoint = 'http://127.0.0.1:10588/api';
  const login = await fetch(endpoint + '/login/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.name, password: user.password }) });
  assert.equal(login.status, 200, 'Local application login failed');
  const session = await login.json();
  const response = await fetch(endpoint + '/production/workbench/getGenerateData', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: session.data.token }, body: JSON.stringify({ projectId: 1790218938911, scriptId: 31 }) });
  assert.equal(response.status, 200, 'Workbench readback failed');
  const result = await response.json();
  const verified = [1790319537445, 1790319543870].map(id => {
    const row = result.data.trackList.find(row => row.id === id);
    assert.ok(row, 'Track is not visible in application response');
    assert.equal(row.prompt, fs.readFileSync(path.join(__dirname, String(id), 'base.txt'), 'utf8'));
    const variant = row.variants.find(v => v.language === 'en-US');
    assert.equal(variant.prompt, fs.readFileSync(path.join(__dirname, String(id), 'en-US.txt'), 'utf8'));
    assert.equal(row.state, '已完成'); assert.equal(variant.state, '已完成');
    return { id, state: row.state, englishState: variant.state, historyVideos: row.videoList.length, currentReferences: row.medias.filter(m => m.sources === 'assets' && m.fileType === 'image').map(m => m.id) };
  });
  const receipt = { verifiedAt: new Date().toISOString(), endpoint: '/production/workbench/getGenerateData', tracks: verified };
  fs.writeFileSync(path.join(__dirname, 'api-readback.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
