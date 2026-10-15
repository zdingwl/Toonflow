// 一次性恢复已完成的旧任务。默认只检查；显式 --apply 才备份并恢复。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('用法：node recover.mjs [--apply]');
const apply = args.includes('--apply');
const reportDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(reportDir, '../..');
const dbPath = path.join(root, 'data/db2.sqlite');
const ossRoot = path.join(root, 'data/oss');
const comfyOutput = 'D:\\new_comfyui\\output\\Toonflow';
const baseUrl = 'http://127.0.0.1:8188';
const projectId = 1791442875669;
const scriptId = 96;
const mappings = [
  { videoId: 104, taskId: 652, trackId: 1790766041590, promptId: '1855cdf6-9593-42a5-bb7a-57d500d1b545',
    filePath: '/1791442875669/video/2f8d3f2e-7419-493c-978e-1189420babd4.mp4',
    filename: 'H3_1792028358373_44679577_00001_.mp4', bytes: 11301775,
    references: ['A01', 'A04', 'A03', 'A06', 'A05'] },
  { videoId: 107, taskId: 655, trackId: 1790766041593, promptId: 'c91aa840-a458-40a1-8bf5-dbea1f41ac14',
    filePath: '/1791442875669/video/8aa09607-a2fd-449b-9c35-ef4765d529f2.mp4',
    filename: 'H3_1792032610429_860203766_00001_.mp4', bytes: 12800408,
    references: ['A01', 'A08', 'A06', 'A12'] },
];
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
const reportPath = path.join(reportDir, `${apply ? '恢复' : '只读检查'}-${runId}.json`);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => sha(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const report = {
  说明: '仅恢复两个原视频记录及其任务；不重新生成，不修改轨道、选片、提示词或参考计划。生成成功不代表画面、台词或参考绑定已通过人工验收。',
  模式: apply ? '应用恢复' : '只读检查', 时间UTC: new Date().toISOString(), 数据库: dbPath,
  结果: '检查中', 记录: [],
};
let db;
let committed = false;
const createdFiles = [];
const stagingFiles = [];

function inside(base, target) {
  const relative = path.relative(base, target);
  assert(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), `路径超出允许目录：${target}`);
  return target;
}
function destination(relative) {
  const target = inside(ossRoot, path.resolve(ossRoot, relative.replace(/^[/\\]+/, '')));
  // Also reject junctions/symlinks redirecting the existing parent outside OSS.
  inside(fs.realpathSync(ossRoot), path.join(fs.realpathSync(path.dirname(target)), path.basename(target)));
  return target;
}
function selectedRows(database) {
  return mappings.map(m => ({
    video: database.prepare('SELECT * FROM o_video WHERE id=?').get(m.videoId),
    task: database.prepare('SELECT * FROM o_tasks WHERE id=?').get(m.taskId),
    track: database.prepare('SELECT * FROM o_videoTrack WHERE id=?').get(m.trackId),
  }));
}
function unrelated(database) {
  return {
    视频: database.prepare('SELECT * FROM o_video WHERE id NOT IN (104,107) ORDER BY id').all(),
    任务: database.prepare('SELECT * FROM o_tasks WHERE id NOT IN (652,655) ORDER BY id').all(),
    全部轨道: database.prepare('SELECT * FROM o_videoTrack ORDER BY id').all(),
  };
}
function snapshot(database) {
  return Object.fromEntries(Object.entries(unrelated(database)).map(([key, rows]) => [key, { 行数: rows.length, JSON_SHA256: jsonHash(rows) }]));
}
function probe(filename) {
  const raw = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,nb_frames:format=duration,size,bit_rate',
    '-of', 'json', filename], { encoding: 'utf8', timeout: 60000 }));
  const v = raw.streams?.find(stream => stream.codec_type === 'video');
  const a = raw.streams?.find(stream => stream.codec_type === 'audio');
  const [numerator, denominator] = String(v?.r_frame_rate || '0/0').split('/').map(Number);
  const fields = { width: Number(v?.width), height: Number(v?.height), fps: numerator / denominator,
    bitrate: Number(v?.bit_rate || raw.format?.bit_rate), codec: v?.codec_name,
    actualDuration: Number(raw.format?.duration) };
  assert(fields.width === 1344 && fields.height === 768 && fields.fps === 24 && Number(v.nb_frames) === 362,
    `视频规格与已确认任务不一致：${filename}`);
  assert(fields.codec && fields.bitrate > 0 && Math.abs(fields.actualDuration - 362 / 24) < 0.02 && a?.codec_name,
    `视频时长、编码或音轨无效：${filename}`);
  return { fields, audioCodec: a.codec_name, bytes: Number(raw.format.size), frames: Number(v.nb_frames) };
}
async function fetchOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert(response.ok, `读取失败 ${response.status}：${url}`);
  return response;
}

try {
  // All business reads and validation use a read-only database until backup finishes.
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const before = selectedRows(db);
  const unaffectedBefore = snapshot(db);
  report.恢复前 = before;
  report.无关记录恢复前 = unaffectedBefore;
  const history = await (await fetchOk(`${baseUrl}/history`)).json();
  const prepared = [];
  for (let index = 0; index < mappings.length; index++) {
    const m = mappings[index];
    const { video, task, track } = before[index];
    assert(video && task && track, `原记录缺失：${m.videoId}`);
    assert(video.projectId === projectId && video.scriptId === scriptId && video.videoTrackId === m.trackId && video.filePath === m.filePath,
      `视频归属或原路径已变化：${m.videoId}`);
    assert(video.state === '生成失败' && video.errorReason === 'timeout' && task.state === '生成失败' && task.reason === 'timeout',
      `仅允许恢复原始 timeout 失败记录，重复应用会拒绝：${m.videoId}`);
    assert(task.projectId === projectId && task.model === 'MiniMax-H3-local' && task.taskClass === '视频生成', `任务归属错误：${m.taskId}`);
    assert(track.projectId === projectId && track.scriptId === scriptId && track.videoId === null && track.duration === 15, `轨道已变化：${m.trackId}`);
    const related = JSON.parse(task.relatedObjects);
    assert(related.projectId === projectId && related.scriptId === scriptId && related.videoId === m.videoId && !related.providerTask,
      `任务关联信息不符合原记录：${m.taskId}`);
    const matches = Object.entries(history).filter(([, item]) => Object.values(item.prompt?.[2] || {}).some(node => node.inputs?.prompt === track.prompt));
    assert(matches.length === 1 && matches[0][0] === m.promptId, `完整提示词无法唯一匹配：${m.videoId}`);
    const h = history[m.promptId];
    const graph = h.prompt[2];
    const conditioning = graph['5'];
    assert(h.status?.status_str === 'success' && h.status.completed === true && conditioning?.class_type === 'MiniMaxH3ReferenceToVideo',
      `ComfyUI 任务并未成功：${m.promptId}`);
    const submitDelay = h.prompt[3]?.create_time - task.startTime;
    assert(submitDelay > 0 && submitDelay < 60000 && h.prompt[3].client_id === 'toonflow-h3', `提交时间或客户端不匹配：${m.promptId}`);
    assert(conditioning.inputs.width === 1344 && conditioning.inputs.height === 768 && conditioning.inputs.length === 362 && graph['13']?.inputs.fps === 24,
      `ComfyUI 输入规格不匹配：${m.promptId}`);
    const output = h.outputs?.['14']?.images?.[0];
    assert(h.outputs['14'].images.length === 1 && output.filename === m.filename && output.subfolder === 'Toonflow' && output.type === 'output',
      `输出路径不匹配：${m.promptId}`);
    const sourcePath = path.join(comfyOutput, m.filename);
    const targetPath = destination(m.filePath);
    assert(!fs.existsSync(targetPath), `原目标已有文件，拒绝覆盖：${targetPath}`);
    const sourceUrl = `${baseUrl}/view?filename=${encodeURIComponent(m.filename)}&subfolder=Toonflow&type=output`;
    const bytes = Buffer.from(await (await fetchOk(sourceUrl)).arrayBuffer());
    const digest = sha(bytes);
    assert(bytes.length === m.bytes && sha(fs.readFileSync(sourcePath)) === digest, `本地源文件与 /view 字节不同：${m.videoId}`);
    const media = probe(sourcePath);
    assert(media.bytes === bytes.length, `ffprobe 文件大小不一致：${m.videoId}`);
    const referenceEvidence = [];
    for (let slot = 0; slot < m.references.length; slot++) {
      const edge = conditioning.inputs[`ref_images.ref_image_${slot}`];
      const inputName = graph[edge?.[0]]?.inputs?.image;
      assert(inputName, `参考槽位缺失：${m.videoId}/${slot}`);
      const inputBytes = Buffer.from(await (await fetchOk(`${baseUrl}/view?type=input&filename=${encodeURIComponent(inputName)}`)).arrayBuffer());
      const assetPath = path.join(ossRoot, 'import-studio/cb00d4f3-f239-4abd-b54d-bae01567dd7f/assets', m.references[slot] + '.png');
      assert(sha(inputBytes) === sha(fs.readFileSync(assetPath)), `历史参考图字节变化：${m.videoId}/${slot}`);
      referenceEvidence.push({ Picture: slot + 1, 历史实际资产: m.references[slot], Comfy输入文件: inputName, SHA256: sha(inputBytes) });
    }
    const receipt = { provider: 'comfyui', promptId: m.promptId, baseUrl, outputNode: '14' };
    const evidence = { 视频ID: m.videoId, 任务ID: m.taskId, 轨道ID: m.trackId, Comfy任务ID: m.promptId,
      完整提示词SHA256: sha(track.prompt), 全历史唯一匹配数量: matches.length, 提交延迟毫秒: submitDelay,
      Comfy状态: h.status, 输出: output, 源路径: sourcePath, 源URL: sourceUrl, 原目标路径: targetPath,
      字节数: bytes.length, SHA256: digest, 媒体: media, 历史参考图: referenceEvidence,
      注意: '历史实际参考槽位与当前保存计划存在排列差异。仅恢复原生成结果，不据此判定内容合格，不自动选片。',
      拟更新视频字段: { state: '生成成功', errorReason: null, ...media.fields },
      拟更新任务字段: { state: '已完成', reason: null, relatedObjects: { ...related, providerTask: receipt } } };
    report.记录.push(evidence);
    prepared.push({ m, bytes, digest, media, targetPath, receipt, related, evidence });
  }
  if (!apply) {
    report.恢复后 = selectedRows(db);
    report.无关记录恢复后 = snapshot(db);
    assert(jsonHash(before) === jsonHash(report.恢复后) && jsonHash(unaffectedBefore) === jsonHash(report.无关记录恢复后), '只读检查期间数据库已变化');
    report.结果 = '只读检查通过；未修改数据库或视频文件。';
  } else {
    const backupPath = path.join(reportDir, `恢复前数据库-${runId}.sqlite`);
    assert(!fs.existsSync(backupPath), '备份路径已存在');
    await db.backup(backupPath);
    const backupDb = new Database(backupPath, { readonly: true });
    try { assert(backupDb.pragma('integrity_check', { simple: true }) === 'ok', '备份完整性检查失败'); }
    finally { backupDb.close(); }
    report.数据库备份 = { 路径: backupPath, SHA256: sha(fs.readFileSync(backupPath)) };
    db.close();
    db = new Database(dbPath, { fileMustExist: true });
    for (const p of prepared) {
      const staging = inside(ossRoot, path.join(path.dirname(p.targetPath), `.恢复-${runId}-${p.m.videoId}.mp4`));
      fs.writeFileSync(staging, p.bytes, { flag: 'wx' });
      stagingFiles.push(staging);
      assert(jsonHash(probe(staging)) === jsonHash(p.media), `暂存媒体检查不一致：${p.m.videoId}`);
      fs.copyFileSync(staging, p.targetPath, fs.constants.COPYFILE_EXCL);
      createdFiles.push({ path: p.targetPath, digest: p.digest });
      assert(sha(fs.readFileSync(p.targetPath)) === p.digest, `恢复文件校验失败：${p.m.videoId}`);
    }
    db.transaction(() => {
      assert(jsonHash(selectedRows(db)) === jsonHash(before) && jsonHash(snapshot(db)) === jsonHash(unaffectedBefore), '恢复前数据库发生并发变化，已停止');
      for (const p of prepared) {
        const f = p.media.fields;
        const videoResult = db.prepare('UPDATE o_video SET state=?,errorReason=NULL,width=?,height=?,fps=?,bitrate=?,codec=?,actualDuration=? WHERE id=? AND state=? AND errorReason=?')
          .run('生成成功', f.width, f.height, f.fps, f.bitrate, f.codec, f.actualDuration, p.m.videoId, '生成失败', 'timeout');
        const taskResult = db.prepare('UPDATE o_tasks SET state=?,reason=NULL,relatedObjects=? WHERE id=? AND state=? AND reason=?')
          .run('已完成', JSON.stringify({ ...p.related, providerTask: p.receipt }), p.m.taskId, '生成失败', 'timeout');
        assert(videoResult.changes === 1 && taskResult.changes === 1, `原记录更新数量错误：${p.m.videoId}`);
      }
      report.无关记录恢复后 = snapshot(db);
      assert(jsonHash(unaffectedBefore) === jsonHash(report.无关记录恢复后), '无关视频、任务或轨道变化，事务回滚');
      report.恢复后 = selectedRows(db);
    }).immediate();
    committed = true;
    // Re-read persisted rows after transaction commit.
    assert(jsonHash(selectedRows(db)) === jsonHash(report.恢复后), '提交后读回不一致');
    report.结果 = '恢复成功；原视频与任务已读回验证，全部轨道及无关视频和任务未变。';
  }
} catch (error) {
  report.结果 = committed ? '数据库已提交，但后续检查失败，请检查报告。' : '停止恢复；数据库恢复事务未提交。';
  report.错误 = error.stack || String(error);
  if (!committed) for (const created of createdFiles) {
    // Remove only files created by this run whose bytes still match the known source.
    if (fs.existsSync(created.path) && sha(fs.readFileSync(created.path)) === created.digest) fs.unlinkSync(created.path);
  }
  process.exitCode = 1;
} finally {
  for (const staging of stagingFiles) if (fs.existsSync(staging)) fs.unlinkSync(staging);
  if (db?.open) db.close();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ 结果: report.结果, 报告: reportPath }, null, 2));
}
