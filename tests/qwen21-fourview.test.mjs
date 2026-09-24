import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'data/workflows/qwen_image_2_1_kor_4view_api.json'), 'utf8'));
const required = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoader', 'LoadImage', 'TextEncodeQwenImage21', 'KSampler', 'VAEDecode', 'ImageStitch', 'SaveImage'];

test('Qwen 2.1 Kor four-view API graph contains expected native nodes', () => {
  for (const nodeName of required) assert.ok(Object.values(workflow).some(n => n.class_type === nodeName), `${nodeName} missing`);
  assert.equal(workflow['60'].class_type, 'SaveImage');
  assert.deepEqual(workflow['60'].inputs.images, ['52', 0]);
});

test('graph references existing nodes and uses correct output slots', () => {
  for (const [id, n] of Object.entries(workflow)) {
    assert.equal(typeof n.class_type, 'string', `bad node ${id}`);
    for (const [field, value] of Object.entries(n.inputs)) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'number') continue;
      assert.ok(workflow[value[0]], `node ${id} input ${field} references absent node ${value[0]}`);
      assert.ok(Number.isInteger(value[1]) && value[1] >= 0, `bad slot on node ${id}`);
    }
  }
});

test('four-view order is portrait/front/side/back', () => {
  assert.deepEqual(workflow['50'].inputs.image1, ['22', 0]);
  assert.deepEqual(workflow['50'].inputs.image2, ['10', 0]);
  assert.deepEqual(workflow['51'].inputs.image2, ['32', 0]);
  assert.deepEqual(workflow['52'].inputs.image2, ['42', 0]);
});
