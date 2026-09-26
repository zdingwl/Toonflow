#!/usr/bin/env node
// V3 runner: prepare delegates exclusively to prepare-role-2mp.cjs.
// Submit and poll retain the reviewed V2 receipt/idempotency behavior.
// No database, upload, queue-management, provider-building or service lifecycle imports.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const { graphSha } = require('./prepare-role-2mp.cjs');
const RUN = __dirname;
const BASE_URL = 'http://127.0.0.1:8188';
const REQUEST_FILE = path.join(RUN, 'style-probe-request.json');
const MANIFEST_FILE = path.join(RUN, 'style-probe-manifest.json');
const RECEIPT_FILE = path.join(RUN, 'style-probe-receipt.json');
const OUTPUT_FILE = path.join(RUN, 'style-probe-output.mp4');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}
async function getJson(endpoint, timeout = 30000) {
  const response = await fetch(`${BASE_URL}${endpoint}`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`GET ${endpoint} returned ${response.status}`);
  return response.json();
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
  const command = process.argv[2];
  if (command === 'prepare') return require('./prepare-role-2mp.cjs').prepare();
  if (command === 'submit') return submit();
  if (command === 'poll') return poll();
  if (!command || command === '--help') {
    console.log('Usage: node style-probe.cjs prepare|submit|poll\nprepare delegates to the dedicated local-copy/GET-only V3 preparation; it never uploads/submits.\nsubmit is a separate explicit one-shot action guarded by its own persistent receipt.\npoll reads only this receipt/history and downloads its output.');
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
