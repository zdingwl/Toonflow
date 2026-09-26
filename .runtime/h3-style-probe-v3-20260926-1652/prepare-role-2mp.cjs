#!/usr/bin/env node
// Prepare only: local reads/writes and GET object_info. No upload, POST, DB or queue operations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const RUN = __dirname;
const SOURCE = path.resolve(RUN, '../h3-style-probe-v2-20260926-1638');
const INPUT_ROOT = 'D:/new_comfyui/input';
const BASE_URL = 'http://127.0.0.1:8188';
const receiptFile = path.join(RUN, 'style-probe-receipt.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const graphSha = graph => sha(JSON.stringify(canonical(graph)));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (name, value) => fs.writeFileSync(path.join(RUN, name), `${JSON.stringify(value, null, 2)}\n`);
// Match Python's round(), including midpoint-to-even rounding in the installed H3 node.
function pyRound(value) {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}
function effectiveSize(width, height, mode, outputWidth, outputHeight) {
  const scale = mode === 'match' ? Math.min(1, Math.sqrt(outputWidth * outputHeight / (width * height)))
    : Math.min(1, 2048 / Math.min(width, height));
  return [Math.max(32, pyRound(width * scale / 32) * 32), Math.max(32, pyRound(height * scale / 32) * 32)];
}

async function prepare() {
  if (fs.existsSync(receiptFile)) throw new Error('A v3 receipt exists; prepared inputs are frozen. Use poll, never prepare or resubmit.');
  const sourceManifestFile = path.join(SOURCE, 'style-probe-manifest.json');
  const sourceRequestFile = path.join(SOURCE, 'style-probe-request.json');
  const source = readJson(sourceManifestFile);
  const originalRequest = readJson(sourceRequestFile);
  const original = originalRequest.prompt;
  assert.equal(graphSha(original), source.graphSha256, 'V2 request no longer matches its manifest');
  assert.equal(source.baseUrl, BASE_URL);
  assert.equal(original['5'].class_type, 'MiniMaxH3ReferenceToVideo');
  assert.equal(original['5'].inputs.ref_image_size, 'match');
  assert.deepEqual(source.references.map(ref => ref.assetId), [115, 116, 118, 128]);
  assert.equal(Object.keys(original['5'].inputs.ref_images).length, 4);
  assert.equal(sha(original['5'].inputs.prompt), source.submissionPromptSha256);

  const infoResponse = await fetch(`${BASE_URL}/object_info/ImageScale`, { method: 'GET', signal: AbortSignal.timeout(15000) });
  if (!infoResponse.ok) throw new Error(`GET object_info/ImageScale: ${infoResponse.status}`);
  const objectInfo = await infoResponse.json();
  const schema = objectInfo.ImageScale.input.required;
  assert.ok(schema.upscale_method[0].includes('lanczos'));
  assert.ok(schema.crop[0].includes('disabled'));
  assert.equal(objectInfo.ImageScale.output[0], 'IMAGE');

  const graph = structuredClone(original);
  const references = [];
  for (const [index, ref] of source.references.entries()) {
    const pictureKey = `ref_image_${index}`;
    const link = original['5'].inputs.ref_images[pictureKey];
    assert.deepEqual(link, [String(15 + index), 0]);
    assert.equal(original[link[0]].class_type, 'LoadImage');
    assert.equal(original[link[0]].inputs.image, ref.uploadedFilename);
    const full = path.resolve(INPUT_ROOT, ref.uploadedFilename);
    const relative = path.relative(INPUT_ROOT, full);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Input path escapes ComfyUI input');
    const bytes = fs.readFileSync(full);
    const metadata = await sharp(bytes).metadata();
    assert.equal(sha(bytes), ref.sha256, 'Uploaded reference bytes changed');
    assert.deepEqual([metadata.width, metadata.height], [ref.width, ref.height]);
    const before = effectiveSize(ref.width, ref.height, 'match', source.width, source.height);
    const after = index < 2 ? [2304, 864] : before;
    assert.ok(after[0] < ref.width && after[1] < ref.height, 'This experiment must downsample original boards, not invent pixels');
    assert.deepEqual(effectiveSize(...after, 'max', source.width, source.height), after);
    assert.ok(after[0] <= schema.width[1].max && after[1] <= schema.height[1].max);
    const scaleId = String(21 + index);
    assert.ok(!Object.hasOwn(graph, scaleId));
    graph[scaleId] = { class_type: 'ImageScale', inputs: {
      image: link, upscale_method: 'lanczos', width: after[0], height: after[1], crop: 'disabled',
    } };
    graph['5'].inputs.ref_images[pictureKey] = [scaleId, 0];
    references.push({ ...ref, reusedUploadedBytesSha256: sha(bytes),
      previousEffectiveWidth: before[0], previousEffectiveHeight: before[1],
      effectiveWidth: after[0], effectiveHeight: after[1],
      previousDitReferenceRows: before[0] * before[1] / 1024,
      ditReferenceRows: after[0] * after[1] / 1024,
      preprocessing: { node: scaleId, method: 'lanczos', crop: 'disabled', newUpload: false },
    });
  }
  graph['5'].inputs.ref_image_size = 'max';
  graph['14'].inputs.filename_prefix = 'Toonflow/H3_style_probe_20260926_1652_role_2mp';
  assert.equal(Object.values(graph).filter(node => node.class_type === 'LoadImage').length, 4);
  assert.equal(Object.values(graph).filter(node => node.class_type === 'ImageScale').length, 4);
  assert.equal(graph['5'].inputs.prompt, original['5'].inputs.prompt);
  assert.equal(graph['6'].inputs.noise_seed, source.seed);
  const reconstructed = structuredClone(graph);
  for (const key of ['21', '22', '23', '24']) delete reconstructed[key];
  reconstructed['5'].inputs.ref_images = structuredClone(original['5'].inputs.ref_images);
  reconstructed['5'].inputs.ref_image_size = original['5'].inputs.ref_image_size;
  reconstructed['14'].inputs.filename_prefix = original['14'].inputs.filename_prefix;
  assert.deepEqual(reconstructed, original, 'Unexpected change beyond reference preprocessing/output prefix');
  for (const ref of references.slice(2)) {
    assert.equal(ref.previousDitReferenceRows, ref.ditReferenceRows, 'Non-role reference budget must stay unchanged');
  }

  const manifestFile = path.join(RUN, 'style-probe-manifest.json');
  const previous = fs.existsSync(manifestFile) ? readJson(manifestFile) : null;
  const clientId = previous?.clientId || `toonflow-h3-style-probe-v3-${crypto.randomUUID()}`;
  const oldRows = references.reduce((sum, ref) => sum + ref.previousDitReferenceRows, 0);
  const newRows = references.reduce((sum, ref) => sum + ref.ditReferenceRows, 0);
  const manifest = { ...source, preparedAt: new Date().toISOString(), clientId,
    sourcePrompt: path.join(RUN, 'style-probe-en-US.txt'),
    sourcePreparedManifest: sourceManifestFile, sourcePreparedRequest: sourceRequestFile,
    sourceGraphSha256: source.graphSha256, graphSha256: graphSha(graph), refImageSize: 'max', references,
    preparation: 'prepare-role-2mp.cjs; reuse v2 uploads; GET object_info only; no submit/upload/queue/DB access',
    interpolationEvidence: {
      nodeSource: 'C:/Users/Admin/ComfyUI-Installs/comfyui (1)/ComfyUI/comfy_extras/nodes_minimax_h3.py',
      installedH3Resize: 'common_upscale(samples, width, height, "lanczos", crop)',
      installedImageScale: 'common_upscale(samples, width, height, upscale_method, crop)',
      nonRoleTreatment: 'same effective dimensions, same Lanczos method, no crop; max retains these 32-aligned dimensions',
    },
    referenceTokenBudget: { previousDitReferenceRows: oldRows, ditReferenceRows: newRows, ratio: newRows / oldRows,
      scope: 'Image-reference DiT spatial rows only. Not total sequence, Qwen tokens, VRAM or runtime prediction.' },
  };
  for (const name of ['style-probe-en-US.txt', 'style-probe-submission-prompt.txt', 'style-probe-uploads.json']) {
    fs.copyFileSync(path.join(SOURCE, name), path.join(RUN, name));
  }
  writeJson('style-probe-workflow.json', graph);
  writeJson('style-probe-request.json', { prompt: graph, client_id: clientId });
  writeJson('style-probe-manifest.json', manifest);
  writeJson('image-scale-schema.json', objectInfo);
  assert.ok(!fs.existsSync(receiptFile), 'Prepare must not create a submission receipt');
  console.log(JSON.stringify({ status: 'prepared_not_submitted', manifest: manifestFile,
    request: path.join(RUN, 'style-probe-request.json'), referenceCount: 4, newUploads: 0,
    samePromptSeedImages: true, refImageSize: 'max', graphSha256: manifest.graphSha256,
    referenceTokenBudget: manifest.referenceTokenBudget }, null, 2));
}
module.exports = { prepare, graphSha };
if (require.main === module) {
  if (process.argv[2] && process.argv[2] !== 'prepare') throw new Error('This script only supports prepare; it can never submit.');
  prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
}
