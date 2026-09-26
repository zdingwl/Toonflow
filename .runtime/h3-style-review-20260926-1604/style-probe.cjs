#!/usr/bin/env node
// Independent four-second H3 probe. No database, queue management, or service lifecycle imports.
// prepare uploads only; submit posts at most once; poll only reads this job and downloads its output.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { transform } = require('sucrase');
const sharp = require('sharp');
const axios = require('axios');
const FormData = require('form-data');
require('tsx/cjs');

const ROOT = path.resolve(__dirname, '../..');
const RUN = __dirname;
const BASE_URL = 'http://127.0.0.1:8188';
const PLAN_FILE = path.join(ROOT, '.runtime/h3-prompt-review-1790405174930/1790319537445/plan.json');
const PROMPT_FILE = path.join(RUN, 'style-probe-en-US.txt');
const PROVIDER_FILE = path.join(ROOT, 'data/vendor/comfyui_local.ts');
const UPLOAD_FILE = path.join(RUN, 'style-probe-uploads.json');
const GRAPH_FILE = path.join(RUN, 'style-probe-workflow.json');
const REQUEST_FILE = path.join(RUN, 'style-probe-request.json');
const MANIFEST_FILE = path.join(RUN, 'style-probe-manifest.json');
const RECEIPT_FILE = path.join(RUN, 'style-probe-receipt.json');
const FINAL_PROMPT_FILE = path.join(RUN, 'style-probe-submission-prompt.txt');
const OUTPUT_FILE = path.join(RUN, 'style-probe-output.mp4');
const FIXED_SEED = 822055552;
const MODEL_SETTINGS = {
  baseUrl: BASE_URL, videoBackend: 'comfyui', h3Steps: '20', workflowApi: '', workflowMapping: '',
  h3RefUnet: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  h3Clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  h3VideoVae: 'minimax_h3_video_vae_fp16.safetensors',
  h3AudioVae: 'minimax_h3_audio_vae_fp32.safetensors',
};
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const graphSha = graph => sha(JSON.stringify(canonical(graph)));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}
function localAssetPath(slotPath) {
  const ossRoot = path.join(ROOT, 'data/oss');
  const full = path.resolve(ossRoot, slotPath.replace(/^[/\\]+/, ''));
  const relative = path.relative(ossRoot, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Asset path escapes data/oss');
  return full;
}
function loadProvider() {
  const source = fs.readFileSync(PROVIDER_FILE, 'utf8');
  const api = {};
  const code = transform(`${source}\nexports.probeNativeH3Graph = nativeH3Graph; exports.probeUploadImage = uploadImage;`, {
    transforms: ['typescript', 'imports'],
  }).code;
  new Function('exports', 'axios', 'FormData', 'Buffer', 'fetch', code)(api, axios, FormData, Buffer, globalThis.fetch);
  Object.assign(api.vendor.inputValues, MODEL_SETTINGS);
  return { ...api, sourceSha256: sha(source) };
}
function validators() {
  return {
    ...require(path.join(ROOT, 'src/utils/h3PromptContract.ts')),
    ...require(path.join(ROOT, 'src/utils/h3ReferenceBindings.ts')),
    ...require(path.join(ROOT, 'src/utils/contentConstraints.ts')),
  };
}
function validateGraph(graph, prompt, uploaded) {
  assert.equal(graph['1'].inputs.unet_name, MODEL_SETTINGS.h3RefUnet);
  assert.equal(graph['2'].inputs.clip_name, MODEL_SETTINGS.h3Clip);
  assert.equal(graph['5'].class_type, 'MiniMaxH3ReferenceToVideo');
  assert.equal(graph['5'].inputs.ref_image_size, 'match');
  assert.equal(graph['5'].inputs.width, 1344);
  assert.equal(graph['5'].inputs.height, 768);
  assert.equal(graph['5'].inputs.length, 107); // Native 17n+5 alignment: 107/24 = 4.458 seconds.
  assert.equal(graph['5'].inputs.prompt, prompt);
  assert.equal(graph['6'].inputs.noise_seed, FIXED_SEED);
  assert.equal(graph['9'].inputs.steps, 20);
  assert.equal(Object.keys(graph['5'].inputs.ref_images).length, 4);
  for (let index = 0; index < 4; index++) {
    const link = graph['5'].inputs.ref_images[`ref_image_${index}`];
    assert.equal(graph[link[0]].class_type, 'LoadImage');
    assert.equal(graph[link[0]].inputs.image, uploaded[index]);
  }
  assert.ok(!Object.values(graph).some(node => /lora|upscale|crop/i.test(node.class_type)));
}
function buildGraph(provider, config, uploaded, objectInfo) {
  const graph = provider.probeNativeH3Graph(config, uploaded, objectInfo);
  graph['6'].inputs.noise_seed = FIXED_SEED;
  graph['14'].inputs.filename_prefix = 'Toonflow/H3_style_probe_20260926_1604';
  validateGraph(graph, config.prompt, uploaded);
  return graph;
}
async function getJson(endpoint, timeout = 30000) {
  const response = await fetch(`${BASE_URL}${endpoint}`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`GET ${endpoint} returned ${response.status}`);
  return response.json();
}
async function prepare() {
  if (fs.existsSync(RECEIPT_FILE)) throw new Error('A submission receipt exists; prepared inputs are frozen. Use poll, never prepare or resubmit this probe.');
  const plan = readJson(PLAN_FILE);
  assert.deepEqual(plan.slots.map(slot => slot.assetId), [115, 116, 118, 128]);
  assert.equal(plan.version, 1);
  assert.ok(plan.slots.every(slot => !slot.kind));
  const sourcePrompt = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
  const checks = validators();
  checks.assertH3PromptContract(sourcePrompt, 4, 4);
  checks.assertH3ReferenceBindings(sourcePrompt, plan.slots);
  const prompt = checks.withNonGraphicVisuals(sourcePrompt);
  checks.assertH3PromptContract(prompt, 4, 4);
  checks.assertH3ReferenceBindings(prompt, plan.slots);
  assert.equal(checks.withNonGraphicVisuals(prompt), prompt);
  const provider = loadProvider();
  const objectInfo = await getJson('/object_info');
  const refs = [];
  for (const [index, slot] of plan.slots.entries()) {
    const fullPath = localAssetPath(slot.path);
    const bytes = fs.readFileSync(fullPath);
    const metadata = await sharp(bytes).metadata();
    assert.ok(metadata.width > 0 && metadata.height > 0);
    if (index < 2) assert.ok(metadata.width > metadata.height * 2, 'Expected the complete wide four-view board, not a portrait crop');
    const mime = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[metadata.format];
    if (!mime) throw new Error(`Unsupported original reference format: ${metadata.format}`);
    refs.push({ slot, fullPath, sha256: sha(bytes), width: metadata.width, height: metadata.height,
      base64: `data:${mime};base64,${bytes.toString('base64')}`, mime, bytes: bytes.length });
  }
  const uploadState = fs.existsSync(UPLOAD_FILE) ? readJson(UPLOAD_FILE) : { baseUrl: BASE_URL, images: [] };
  assert.equal(uploadState.baseUrl, BASE_URL);
  const uploaded = [];
  for (const [index, ref] of refs.entries()) {
    const cached = uploadState.images.find(image => image.assetId === ref.slot.assetId && image.sha256 === ref.sha256);
    let filename = cached?.filename;
    if (filename) {
      const query = new URLSearchParams({ filename: path.posix.basename(filename), subfolder: path.posix.dirname(filename) === '.' ? '' : path.posix.dirname(filename), type: 'input' });
      const head = await fetch(`${BASE_URL}/view?${query}`, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      if (!head.ok) filename = undefined;
    }
    if (!filename) {
      filename = await provider.probeUploadImage(ref.base64, index);
      uploadState.images = uploadState.images.filter(image => image.assetId !== ref.slot.assetId);
      uploadState.images.push({ assetId: ref.slot.assetId, sha256: ref.sha256, filename });
      writeJson(UPLOAD_FILE, uploadState);
    }
    uploaded.push(filename);
  }
  const config = { prompt, duration: 4, resolution: '768p', aspectRatio: '16:9', audio: true, mode: ['imageReference:9'],
    referenceList: refs.map(ref => ({ type: 'image', base64: ref.base64, sourceType: 'assets', assetType: ref.slot.assetType, label: ref.slot.label })) };
  const graph = buildGraph(provider, config, uploaded, objectInfo);
  const oldManifest = fs.existsSync(MANIFEST_FILE) ? readJson(MANIFEST_FILE) : null;
  const clientId = oldManifest?.clientId || `toonflow-h3-style-probe-${crypto.randomUUID()}`;
  const manifest = {
    preparedAt: new Date().toISOString(), baseUrl: BASE_URL, clientId, sourcePlan: PLAN_FILE,
    sourcePrompt: PROMPT_FILE, sourcePromptSha256: sha(sourcePrompt), submissionPromptSha256: sha(prompt),
    providerSource: PROVIDER_FILE, providerSourceSha256: provider.sourceSha256, graphSha256: graphSha(graph),
    requestedDuration: 4, actualFrameCount: graph['5'].inputs.length, fps: 24, nominalOutputDuration: graph['5'].inputs.length / 24,
    width: 1344, height: 768, seed: FIXED_SEED, steps: 20, refImageSize: 'match', models: MODEL_SETTINGS,
    references: refs.map((ref, index) => ({ picture: index + 1, assetId: ref.slot.assetId, assetType: ref.slot.assetType,
      label: ref.slot.label, sourcePath: ref.fullPath, sha256: ref.sha256, width: ref.width, height: ref.height,
      bytes: ref.bytes, mime: ref.mime, uploadedFilename: uploaded[index] })),
  };
  fs.writeFileSync(FINAL_PROMPT_FILE, `${prompt}\n`);
  writeJson(GRAPH_FILE, graph);
  writeJson(REQUEST_FILE, { prompt: graph, client_id: clientId });
  writeJson(MANIFEST_FILE, manifest);
  console.log(JSON.stringify({ status: 'prepared_not_submitted', graph: GRAPH_FILE, request: REQUEST_FILE, manifest: MANIFEST_FILE,
    referenceCount: refs.length, requestedDuration: 4, nominalOutputDuration: manifest.nominalOutputDuration, graphSha256: manifest.graphSha256 }, null, 2));
}
async function submit() {
  const manifest = readJson(MANIFEST_FILE);
  const request = readJson(REQUEST_FILE);
  assert.equal(graphSha(request.prompt), manifest.graphSha256, 'Prepared request changed after review');
  assert.equal(request.client_id, manifest.clientId);
  if (fs.existsSync(RECEIPT_FILE)) {
    const receipt = readJson(RECEIPT_FILE);
    if (receipt.promptId) {
      console.log(JSON.stringify({ status: 'already_submitted_no_new_post', promptId: receipt.promptId, receipt: RECEIPT_FILE }, null, 2));
      return;
    }
    throw new Error('Submission was already attempted and its outcome is uncertain. Do not resubmit; use poll to recover from history after completion.');
  }
  const receipt = { status: 'submission_started', startedAt: new Date().toISOString(), baseUrl: BASE_URL,
    clientId: manifest.clientId, graphSha256: manifest.graphSha256, promptId: null };
  fs.writeFileSync(RECEIPT_FILE, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  try {
    const response = await axios.post(`${BASE_URL}/prompt`, request, { timeout: 60000, proxy: false, maxBodyLength: Infinity });
    if (!response.data?.prompt_id) throw new Error(`No prompt_id returned: ${JSON.stringify(response.data?.node_errors || response.data?.error || {})}`);
    Object.assign(receipt, { status: 'submitted', submittedAt: new Date().toISOString(), promptId: response.data.prompt_id });
    writeJson(RECEIPT_FILE, receipt);
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    Object.assign(receipt, { status: 'submission_outcome_uncertain', error: error.message });
    writeJson(RECEIPT_FILE, receipt);
    throw error;
  }
}
function findOutput(value) {
  if (Array.isArray(value)) { for (const item of value) { const found = findOutput(item); if (found) return found; } }
  else if (value && typeof value === 'object') {
    if (typeof value.filename === 'string' && /\.(mp4|webm|mov|mkv)$/i.test(value.filename)) return value;
    for (const item of Object.values(value)) { const found = findOutput(item); if (found) return found; }
  }
  return null;
}
async function poll() {
  const receipt = readJson(RECEIPT_FILE);
  let history;
  if (!receipt.promptId) {
    history = await getJson('/history');
    const matches = Object.entries(history).filter(([, task]) => task.prompt?.[2] && graphSha(task.prompt[2]) === receipt.graphSha256);
    if (matches.length !== 1) throw new Error(`Submission outcome remains uncertain; ${matches.length} matching completed histories. No new submission was made.`);
    Object.assign(receipt, { promptId: matches[0][0], status: 'recovered_from_history' });
    writeJson(RECEIPT_FILE, receipt);
  } else history = await getJson(`/history/${encodeURIComponent(receipt.promptId)}`);
  const task = history[receipt.promptId];
  if (!task) { console.log(JSON.stringify({ status: 'waiting', promptId: receipt.promptId })); return; }
  if (task.prompt?.[2]) assert.equal(graphSha(task.prompt[2]), receipt.graphSha256, 'History belongs to a different graph');
  writeJson(path.join(RUN, 'style-probe-history.json'), task);
  if (['error', 'failed'].includes(task.status?.status_str)) {
    Object.assign(receipt, { status: 'failed', historyStatus: task.status });
    writeJson(RECEIPT_FILE, receipt);
    throw new Error(`H3 probe failed; inspect style-probe-history.json. No automatic retry.`);
  }
  const output = findOutput(task.outputs?.['14']);
  if (!output) { console.log(JSON.stringify({ status: task.status?.status_str || 'waiting', promptId: receipt.promptId, outputReady: false })); return; }
  if (!fs.existsSync(OUTPUT_FILE)) {
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
    const response = await fetch(`${BASE_URL}/view?${query}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error(`Download returned ${response.status}`);
    const temporary = `${OUTPUT_FILE}.download-${process.pid}`;
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'wx' }));
      await fsp.rename(temporary, OUTPUT_FILE);
    } catch (error) {
      if (fs.existsSync(temporary)) await fsp.unlink(temporary);
      throw error;
    }
  }
  Object.assign(receipt, { status: 'downloaded', output: OUTPUT_FILE, outputSha256: sha(fs.readFileSync(OUTPUT_FILE)), completedAt: new Date().toISOString() });
  writeJson(RECEIPT_FILE, receipt);
  console.log(JSON.stringify({ status: receipt.status, promptId: receipt.promptId, output: receipt.output, sha256: receipt.outputSha256 }, null, 2));
}
async function main() {
  process.chdir(ROOT);
  const command = process.argv[2];
  if (command === 'prepare') return prepare();
  if (command === 'submit') return submit();
  if (command === 'poll') return poll();
  if (!command || command === '--help') {
    console.log('Usage: node .runtime/h3-style-review-20260926-1604/style-probe.cjs prepare|submit|poll\nprepare uploads four original references and writes a reviewable request; it never submits.\nsubmit performs one POST protected by a persistent exclusive receipt. Repeating submit never adds another job.\npoll only reads this receipt/history and downloads this job output. No database, queue-management, or service lifecycle operations.');
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
module.exports = { loadProvider, buildGraph, validateGraph, graphSha, MODEL_SETTINGS };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
