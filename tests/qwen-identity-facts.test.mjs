import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'sucrase';
import { VM } from 'vm2';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'data/vendor/comfyui_qwen21_fourview.ts'), 'utf8');
const exports = {};
const code = transform(source, { transforms: ['typescript'] }).code.replace(/export\s*\{\s*\};?/g, '');
new VM({ sandbox: { exports, Buffer }, eval: false, wasm: false }).run(code + '\nexports.graphForTest = graphFor;');
const { identityFactsOnly } = exports;

for (const fixture of JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/qwen-fourview-layout-regressions.json'), 'utf8'))) {
  test('failed production board becomes four independent single-view requests: ' + fixture.name, () => {
    const cleaned = identityFactsOnly(fixture.prompt);
    assert.match(cleaned, new RegExp(fixture.name));
    assert.doesNotMatch(cleaned, /四栏|各视角|四名视角|第[一二三四]栏|后三栏|从左到右|脸部(?:正面)?特写|正面全身|侧面全身|正后方全身/);
    if (fixture.name === '艾娃') for (const fact of ['黑色长发', '浅灰褐', '长裤', '左臂']) assert.ok(cleaned.includes(fact));
    if (fixture.name === '麦迪逊') for (const fact of ['卷发', '柔粉色', '睡衣', '假笑']) assert.ok(cleaned.includes(fact));
    if (fixture.name === '科尔') for (const fact of ['深黑色短碎发', '交领', '长袍', '赤足', '微湿']) assert.ok(cleaned.includes(fact));
    const graph = exports.graphForTest({prompt:fixture.prompt,size:'1K',aspectRatio:'2:3'});
    for (const id of ['11','20','30','40']) {
      const p = graph[id].inputs.prompt;
      assert.doesNotMatch(p, /从左到右|第各视角|第[一二三四]栏|后三栏/);
      assert.match(p, /^This is a SINGLE-VIEW render of ONE character/);
      assert.match(p, /Render exactly ONE person in this ONE view\.$/);
    }
    assert.match(graph['20'].inputs.prompt, /FINAL FRAMING:.*HEAD-AND-SHOULDERS/);
    assert.match(graph['30'].inputs.prompt, /FINAL FRAMING:.*LEFT SIDE PROFILE/);
    assert.match(graph['40'].inputs.prompt, /FINAL FRAMING:.*BACK view/);
  });
}

test('Qwen retains character facts on both sides of a Chinese layout list in the same sentence', () => {
  const result = identityFactsOnly('艾娃穿红色上衣、黑色短裙，四栏从左到右为脸部特写、正面全身、90°左侧面全身、正后方全身，深棕色马尾与细密发丝。');
  for (const fact of ['艾娃', '红色上衣', '黑色短裙', '深棕色马尾', '细密发丝']) assert.ok(result.includes(fact), fact);
  assert.doesNotMatch(result, /四栏|从左到右|脸部特写|正面全身|90°左侧面全身|正后方全身/);
});

test('Qwen preserves identity and state inside a cross-view consistency clause', () => {
  const result = identityFactsOnly('四栏保持同一个艾娃，深棕色马尾、琥珀色眼睛、红上衣与黑裙完全一致；第一栏也保留左眼下泪痣。');
  for (const fact of ['艾娃', '深棕色马尾', '琥珀色眼睛', '红上衣', '黑裙', '完全一致', '左眼下泪痣']) assert.ok(result.includes(fact), fact);
  assert.doesNotMatch(result, /四栏|第一栏/);
});

test('Qwen retains English facts mixed with panel directions and semicolons', () => {
  const result = identityFactsOnly('Ava wears a red blouse and black skirt; exactly four panels in one horizontal row; fine individual hair strands. The first panel preserves her amber eyes.');
  for (const fact of ['Ava', 'red blouse', 'black skirt', 'fine individual hair strands', 'amber eyes']) assert.ok(result.includes(fact), fact);
  assert.doesNotMatch(result, /four panels|horizontal row|first panel/i);
});

test('Qwen does not remove directional color facts or ambiguous view details', () => {
  const prompt = '艾娃发梢颜色从左到右由黑过渡到银白；四个视角保留衣服左侧三枚铜扣和右肩破损。';
  const result = identityFactsOnly(prompt);
  assert.match(result, /从左到右由黑过渡到银白/);
  assert.match(result, /左侧三枚铜扣和右肩破损/);
  const mixed = identityFactsOnly('四个视角保持正面、背面金色刺绣。四栏从左到右为正面、背面金色刺绣。');
  assert.equal((mixed.match(/背面金色刺绣/g) || []).length, 2);
});

test('Qwen establishes facts in the front and derives other views from its actual image', () => {
  const graph = exports.graphForTest({
    prompt: '艾娃穿红色上衣、黑色短裙，四栏从左到右为脸部特写、正面全身、侧面全身、背面全身。皮肤保留细微纹理。',
    size: '1K', aspectRatio: '2:3',
  });
  for (const node of ['11']) {
    const prompt = graph[node].inputs.prompt;
    assert.match(prompt, /红色上衣/);
    assert.match(prompt, /黑色短裙/);
    assert.match(prompt, /皮肤保留细微纹理/);
    assert.match(prompt, /CURRENT ASSET FACTS/);
    assert.match(prompt, /SINGLE-VIEW render of ONE character/);
  }
});


for (const style of [
  'premium anime-realistic concept art, polished illustration rendering, clean premium shading, 冷灰蓝背景',
  '2D flat cel animation with clean ink outlines and flat colors',
  'live-action photographic character with natural skin texture',
  'semi-realistic Chinese 3D donghua with PBR cloth and fine hair strands',
]) {
  test('Qwen single-view jobs preserve the supplied project rendering style: ' + style, () => {
    const graph = exports.graphForTest({
      prompt: 'Project style: ' + style + '. Ava, red blouse, black skirt, low ponytail. One same character in four views.',
      size: '1K', aspectRatio: '2:3',
    });
    for (const id of ['11', '20', '30', '40']) {
      const prompt = graph[id].inputs.prompt;
      if (id === '11') {
        assert.ok(prompt.includes(style));
        assert.match(prompt, /Follow the project rendering style/);
        assert.match(prompt, /display background palette and lighting specified in CURRENT ASSET FACTS/);
        assert.match(prompt, /red blouse, black skirt, low ponytail/);
      } else {
        assert.match(prompt, /Preserve the reference person's identity/);
        assert.doesNotMatch(prompt, /CURRENT ASSET FACTS|red blouse, black skirt, low ponytail/);
        assert.deepEqual(graph[id].inputs['images.image_1'], id === '40' ? ['32', 0] : ['14', 0]);
      }
      assert.match(prompt, /SINGLE-VIEW render of ONE character/);
      assert.doesNotMatch(prompt, /cinematic stylized realistic 3D animated CGI character|no live-action photographic look|PBR cloth and skin/);
    }
    assert.deepEqual(graph['50'].inputs.image1, ['22', 0]);
    assert.deepEqual(graph['50'].inputs.image2, ['14', 0]);
    assert.deepEqual(graph['51'].inputs.image2, ['32', 0]);
    assert.deepEqual(graph['52'].inputs.image2, ['42', 0]);
  });
}

test('optional style reference controls render treatment without becoming character identity', () => {
  const graph = exports.graphForTest({ prompt: '2D ink character, red coat.', size: '1K', aspectRatio: '2:3' }, 'front.png', 'style.png');
  for (const id of ['20', '30', '40']) {
    const node = graph[id];
    assert.match(node.inputs.prompt, /<image2> only for the requested project rendering style, NEVER for identity, clothing, scene, or composition/);
    assert.deepEqual(node.inputs['images.image_2'], ['15', 0]);
  }
});
