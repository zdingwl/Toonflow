import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transform } from 'sucrase';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'data/vendor/comfyui_qwen21_fourview.ts'), 'utf8');
const code = transform(source, { transforms: ['typescript', 'imports'] }).code;

// Fixed snapshots copied read-only from o_assets 352/353/354 on 2026-10-08.
// Running these tests never opens SQLite or contacts a model/provider.
const fixtures = [
  {
    id: 352,
    name: '艾娃',
    prompt: '电影级半写实三维国漫动画角色设定图，同一角色同一状态的四栏展示板。艾娃，气质冷静利落、都市干练。小鹅蛋脸型，下颌线条流畅收束，颧骨与下颌转折协调；舒展杏眼、眼尾微扬，柔挑眉形有辨识度，精致鼻尖，清楚唇峰与自然唇珠；玫瑰豆沙柔雾唇色，少量柔粉腮红自然融入面颊，底妆细腻、皮肤保留次表面透光与细微粗糙度变化。墨黑色长发梳成顺滑高马尾，颅顶蓬松，脸周留弧形发束修饰轮廓，发丝独立细密、三维层次分明、有细微高光。体型自然匀称，肩线平直，四肢比例协调，约七头身修长比例。着装：黑色短款收腰西装外套，肩线结构利落，哑光面料有清晰织纹与自然褶皱；内搭象牙白柔缎翻领衬衫，领口规整，衣摆收进裙内，缎面呈柔和漫反射；奶油白色高腰中长A字裙，裙摆自然垂坠、保留活动松量，棉感面料厚度可见；黑色低跟踝靴，皮质哑光；小型银色水滴耳饰，金属微反射。黑白主辅色对比、短外套与长裙的上下比例、柔缎与哑光面料的材质层次共同构成完整造型。四栏从左到右依次为：第一栏脸部特写，正面朝向，头顶至肩胸完整入画；第二栏正面全身，中性站姿，头顶与脚底完整；第三栏九十度左侧面全身，中性站姿，头顶与脚底完整；第四栏正后方全身，后脑与后背朝向观众，头顶与脚底完整。四栏为同一人同一套设计，脸型、高马尾发束、服装剪裁、颜色与材质完全一致，不因视角增减饰物或改变遮挡关系。低干扰冷灰蓝纯色背景，柔和三点式展示光：主光前上方四十五度、左右两侧柔补光、后方克制轮廓光分离深色发丝与外衣边缘，肤色保留自然透光与受控高光，服装固有色不被环境色覆盖。画面无文字、无水印、无logo。',
    facts: ['艾娃', '小鹅蛋脸型', '舒展杏眼', '柔挑眉形', '玫瑰豆沙柔雾唇色', '柔粉腮红', '次表面透光与细微粗糙度变化', '墨黑色长发', '顺滑高马尾', '黑色短款收腰西装外套', '象牙白柔缎翻领衬衫', '奶油白色高腰中长A字裙', '黑色低跟踝靴', '小型银色水滴耳饰', '金属微反射', '低干扰冷灰蓝纯色背景', '柔和三点式展示光', '电影级半写实三维国漫动画'],
  },
  {
    id: 353,
    name: '麦迪逊',
    prompt: '电影级半写实三维国漫动画，cinematic semi-realistic Chinese 3D animation，半写实美型骨相与自然人体比例，真实皮肤次表面透光、细密发丝三维层次与服装织物材质，cinematic lighting。\n\n麦迪逊，柔和心形小脸，圆润杏眼带温和视线，自然弧眉，精致鼻尖，清楚唇珠与柔光蜜桃唇色，蜜桃粉腮红自然融入面颊，底妆细腻保留皮肤细微粗糙度与受控高光；栗棕色及肩蓬松柔卷发，空气感侧分，脸周发束自然垂落修饰轮廓，发丝层次分明带细微高光；体态自然匀称，肩线柔和，四肢修长适中，身形轻盈；奶油淡黄色细针织开衫，柔软织纹与自然垂坠，内搭米白色规整圆领上衣，领口干净利落；象牙白高腰微褶中长裙，裙摆自然垂坠并保留活动松量；奶油色玛丽珍平底鞋，鞋型圆润柔和；耳垂点缀小型圆珍珠耳饰；整体以奶油淡黄、米白、象牙白三层柔和色调与针织柔软、裙料轻垂的材质对比形成温柔甜美且有设计感的日常穿搭剪影。\n\n四栏角色设定图，同一角色同一状态，从左到右依次为：第一栏脸部正面特写，头顶至肩胸完整；第二栏正面全身中性站姿，头顶与脚底完整入画；第三栏90°左侧面全身，中性站姿，头脚完整；第四栏正后方全身，后脑与后背朝向观众，头脚完整。四栏中同一人的脸型、五官比例、发色与发型轮廓、妆色、衣装剪裁与颜色、针织与裙料材质及耳饰位置完全一致。\n\n低干扰冷灰蓝展示背景，柔和三点式主光、环境补光与克制轮廓光，肤色保留自然透光，服装固有色清楚，暗色衣物边缘与背景分离。无文字、无水印、无logo。',
    facts: ['麦迪逊', '柔和心形小脸', '圆润杏眼', '自然弧眉', '柔光蜜桃唇色', '蜜桃粉腮红', '皮肤细微粗糙度与受控高光', '栗棕色及肩蓬松柔卷发', '空气感侧分', '奶油淡黄色细针织开衫', '米白色规整圆领上衣', '象牙白高腰微褶中长裙', '奶油色玛丽珍平底鞋', '小型圆珍珠耳饰', '低干扰冷灰蓝展示背景', '柔和三点式主光', 'cinematic semi-realistic Chinese 3D animation', 'cinematic lighting'],
  },
  {
    id: 354,
    name: '维拉',
    prompt: '电影级半写实三维国漫动画角色设定图，cinematic semi-realistic Chinese 3D animation，国漫式美型骨相与自然人体比例，physically based materials，cinematic lighting。维拉，都会酷飒气质的女性角色，一张展示板呈现同一人的四个视角，从左到右依次为正面脸部特写（头顶至肩胸完整）、正面全身、90°左侧面全身、正后方全身，后三栏头顶与脚底完整入画。修长鹅蛋脸型，颧骨与下颌转折清楚流畅，眼尾微扬，眉形清晰有弧度，鼻梁细致挺直，唇峰清楚、唇珠自然；可可玫瑰柔雾妆，少量柔粉腮红融入面颊，底妆细腻，皮肤保留自然次表面透光与细微粗糙度变化。深巧克力棕色侧分锁骨层次发，脸周发束呈外翻弧线修饰轮廓，发丝有清晰三维层次与细微高光。自然比例体型，肩线平直，四肢修长，脊背挺直，七头身协调比例。巧克力棕色短款麂皮夹克，肩线利落、袖口收束，表面可见细密绒面与柔和哑光；内搭奶白色柔缎翻领衬衫，领口规整、衣摆收进裤腰，缎面轻薄透光、高光柔和；深靛蓝色高腰直筒丹宁长裤，裤线干净、保留活动松量，织纹与微磨白清晰可辨；棕色低跟踝靴；腰间系一条简洁皮质衣装腰带。麂皮、柔缎与丹宁在厚度、织纹、粗糙度与高光形状上形成明确材质对比，色调以巧克力棕、奶白、深靛蓝三层为主，无多余配饰。四栏中同一人的脸型、发型、服装剪裁与颜色严格一致。低干扰冷灰蓝展示背景，柔和三点式主光与环境补光，克制轮廓光使深色衣物边缘与背景分离，肤色及衣装固有色不被冷色覆盖。无文字、无水印、无logo。',
    facts: ['维拉', '修长鹅蛋脸型', '眼尾微扬', '眉形清晰有弧度', '可可玫瑰柔雾妆', '柔粉腮红', '自然次表面透光与细微粗糙度变化', '深巧克力棕色侧分锁骨层次发', '巧克力棕色短款麂皮夹克', '奶白色柔缎翻领衬衫', '深靛蓝色高腰直筒丹宁长裤', '棕色低跟踝靴', '简洁皮质衣装腰带', '无多余配饰', '低干扰冷灰蓝展示背景', '柔和三点式主光', 'cinematic semi-realistic Chinese 3D animation', 'physically based materials', 'cinematic lighting'],
  },
];

// generateAssets.ts and batchGenerateImageAssets.ts use this identical wrapper.
// Apply it once per fixture: these are two routes into the same vendor boundary.
function productionPrompt(name, prompt) {
  return `The visible rendering medium and art direction stated in CURRENT ASSET FACTS are authoritative. Internal project preset id "realistic_3d_anime" is metadata only and must not change that medium. Current character and state: ${name}. Authoritative visible identity, wardrobe and state facts: ${prompt}`;
}

class MemoryFormData {
  values = [];
  append(...args) { this.values.push(args); }
  getHeaders() { return {}; }
}

function mockProvider() {
  const calls = [];
  const uploads = [];
  let graph;
  let objectInfo;
  const sandbox = {
    exports: {}, Buffer, FormData: MemoryFormData,
    axios: {
      get: async url => {
        calls.push({ method: 'GET', url });
        const endpoint = new URL(url).pathname;
        if (endpoint === '/object_info') return { data: objectInfo };
        if (endpoint === '/history/memory-task') return { data: {
          'memory-task': { status: { status_str: 'success' }, outputs: {
            '60': { images: [{ filename: 'memory-fourview.png', subfolder: '', type: 'output' }] },
          } },
        } };
        throw new Error(`Unexpected mock GET ${endpoint}`);
      },
      post: async (url, body) => {
        calls.push({ method: 'POST', url });
        if (new URL(url).pathname === '/upload/image') {
          uploads.push(body.values[0][1].toString());
          return { data: { name: `reference-${uploads.length}.png`, subfolder: 'inputs' } };
        }
        assert.equal(new URL(url).pathname, '/prompt');
        assert.equal(body.client_id, 'toonflow-qwen21-fourview');
        assert.equal(graph, undefined, 'each request must submit exactly one workflow');
        graph = JSON.parse(JSON.stringify(body.prompt));
        return { data: { prompt_id: 'memory-task' } };
      },
    },
    pollTask: async fn => {
      const result = await fn();
      assert.equal(result.completed, true);
      return result;
    },
  };
  vm.runInNewContext(code + '\nexports.graphForTest = graphFor;', sandbox, { timeout: 1000 });
  const { vendor, imageRequest } = sandbox.exports;
  vendor.inputValues.baseUrl = 'http://memory-comfy.invalid';
  objectInfo = Object.fromEntries(['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'KSampler', 'VAEDecode', 'SaveImage', 'ImageStitch', 'EmptyLatentImage'].map(name => [name, {}]));
  for (const [node, field, value] of [
    ['UNETLoader', 'unet_name', vendor.inputValues.unet],
    ['CLIPLoader', 'clip_name', vendor.inputValues.clip],
    ['VAELoader', 'vae_name', vendor.inputValues.vae],
  ]) objectInfo[node] = { input: { required: { [field]: [[value]] } } };
  return {
    uploads,
    buildGraph(anchor, style) {
      return JSON.parse(JSON.stringify(sandbox.exports.graphForTest({ prompt: '半写实3D人物，非对称肩部结构。', size: '1K', aspectRatio: '2:3' }, anchor, style)));
    },
    async run(prompt, referenceList = []) {
      const result = await imageRequest({ prompt, referenceList, size: '1K', aspectRatio: '2:3' }, { modelName: 'qwen-image-2.1-fourview-local' });
      assert.equal(result, 'http://memory-comfy.invalid/view?filename=memory-fourview.png&subfolder=&type=output');
      assert.deepEqual(calls.map(call => `${call.method} ${new URL(call.url).pathname}`), ['GET /object_info', ...referenceList.map(() => 'POST /upload/image'), 'POST /prompt', 'GET /history/memory-task']);
      assert.ok(graph, 'the test must capture the actual imageRequest POST graph');
      return graph;
    },
  };
}

function assetFacts(graph) {
  assert.equal(graph['11'].class_type, 'TextEncodeQwenImage21');
  const match = /CURRENT ASSET FACTS \(identity and CURRENT state, authoritative\): ([\s\S]*?)\. Preserve the specified identity, wardrobe and state\./.exec(graph['11'].inputs.prompt);
  assert.ok(match, 'front encoding must contain an explicit current-asset facts block');
  return match[1];
}

const layoutLeak = /四栏|四格|四宫格|四视图|四个视角|展示板|从左到右(?:固定)?(?:排列)?(?:分别|依次)?为|第[一二三四1-4]栏|后三栏|脸部(?:正面)?(?:至肩胸)?特写|正面(?:脸部|头肩)特写|头(?:顶|部)(?:至|到|与)肩胸(?:完整)?|正面朝向|(?:九十度|90[°度])(?:严格)?左侧面全身|正面全身|正后方全身|后脑(?:与|、)后背朝向观众|头顶(?:与|至|到)脚底完整(?:入画)?|头脚完整/;

function assertBackReferences(graph, frontAnchorId, hasStyle) {
  const back = graph['40'].inputs;
  assert.deepEqual(back['images.image_1'], ['32', 0], 'side remains the rotation and output-size anchor');
  assert.deepEqual(back[`images.image_${hasStyle ? 3 : 2}`], [frontAnchorId, 0], 'the original complete front supplies both sides of garment construction');
  assert.deepEqual(Object.keys(back).filter(key => key.startsWith('images.')), hasStyle
    ? ['images.image_1', 'images.image_2', 'images.image_3'] : ['images.image_1', 'images.image_2']);
  assert.match(back.prompt, /Use <image1> as the approved strict side-view/);
  assert.match(back.prompt, new RegExp(`Use <image${hasStyle ? 3 : 2}> as the approved front-view structure supplement`));
  assert.match(back.prompt, /another 90 degrees TOWARD THE BACK, not back toward the front/);
  assert.match(back.prompt, /garment construction on BOTH sides/);
  assert.match(back.prompt, /wearer-relative LEFT and RIGHT.*never mirror, swap or symmetrize/);
  assert.match(back.prompt, /must not replace the BACK-view composition or copy the front-facing pose, face, chest/);
  assert.match(back.prompt, /FINAL FRAMING:.*180-degree BACK view/);
  assert.doesNotMatch(back.prompt, /CURRENT ASSET FACTS|四栏|从左到右|非对称肩部结构/, 'do not re-inject the full drawing facts or board layout into the edit');
  if (hasStyle) {
    assert.deepEqual(back['images.image_2'], ['15', 0]);
    assert.match(back.prompt, /Use <image2> only for the requested project rendering style, NEVER for identity, clothing, scene, or composition/);
  } else {
    assert.equal(back['images.image_3'], undefined);
    assert.doesNotMatch(back.prompt, /<image3>|only for the requested project rendering style/);
  }
  const tags = [...new Set([...back.prompt.matchAll(/<image(\d+)>/g)].map(match => Number(match[1])))].sort();
  assert.deepEqual(tags, hasStyle ? [1, 2, 3] : [1, 2], 'every prompt image index corresponds to one connected conditioning slot');
  assert.deepEqual(graph['41'].inputs.latent_image, ['40', 2]);
  assert.equal(graph['41'].inputs.steps, 35);
}

function assertSingleViewGraph(graph) {
  const front = graph['11'].inputs.prompt;
  assert.match(front, /straight-on front FULL[- ]BODY/);
  assert.match(front, /唯一一人/);
  assert.match(front, /只呈现一次/);
  assert.doesNotMatch(front, /HEAD-AND-SHOULDERS|LEFT SIDE PROFILE|BACK view/);
  assert.equal(graph['12'].inputs.batch_size, 1);
  for (const id of ['11', '20', '30', '40']) assert.match(graph[id].inputs.prompt, /^This is a SINGLE-VIEW render of ONE character/);
  assert.deepEqual(graph['20'].inputs['images.image_1'], ['14', 0]);
  assert.deepEqual(graph['30'].inputs['images.image_1'], ['14', 0]);
  assert.deepEqual(graph['40'].inputs['images.image_1'], ['32', 0]);
  assertBackReferences(graph, '14', false);
  for (const id of ['20', '30', '40']) {
    assert.doesNotMatch(graph[id].inputs.prompt, /CURRENT ASSET FACTS|四栏|展示板|从左到右依次为|第[一二三四1-4]栏/);
    assert.match(graph[id].inputs.prompt, /CURRENT-STATE anchor/);
  }
  assert.match(graph['20'].inputs.prompt, /FINAL FRAMING:.*HEAD-AND-SHOULDERS/);
  assert.match(graph['30'].inputs.prompt, /FINAL FRAMING:.*LEFT SIDE PROFILE/);
  assert.match(graph['40'].inputs.prompt, /FINAL FRAMING:.*BACK view/);
  assert.deepEqual(graph['50'].inputs.image1, ['22', 0]);
  assert.deepEqual(graph['50'].inputs.image2, ['14', 0]);
  assert.deepEqual(graph['51'].inputs.image2, ['32', 0]);
  assert.deepEqual(graph['52'].inputs.image2, ['42', 0]);
}

for (const fixture of fixtures) {
  test(`stored role ${fixture.id} ${fixture.name}: production wrapper submits clean facts and four independent views`, async () => {
    const graph = await mockProvider().run(productionPrompt(fixture.name, fixture.prompt));
    const facts = assetFacts(graph);
    assert.doesNotMatch(facts, layoutLeak);
    for (const fact of fixture.facts) assert.ok(facts.includes(fact), `lost ${fixture.name} visible fact: ${fact}`);
    assertSingleViewGraph(graph);
  });
}

test('mixed layout prose retains parenthesized identity, scars, back embroidery and current state', async () => {
  const prompt = '电影级半写实三维国漫动画角色设定图，艾娃（左眼下有一颗细小泪痣），黑色长发，发梢颜色从左到右由黑过渡到银白，玫瑰豆沙唇色，穿黑色短款西装与象牙白长裙，第一栏为正面脸部至肩胸特写（完整头部至肩胸，左臂上部闭合低饱和灰褐色旧刀疤），四栏从左到右依次为正面全身、九十度左侧面全身、正后方全身，后脑与后背朝向观众，背面金色鹤纹刺绣与右肩破损保留；左臂刀疤不发光，衣料微湿贴服，但仍是普通状态，不表现觉醒力量；小型银色耳饰；低干扰冷灰蓝背景，柔和电影光照。';
  const graph = await mockProvider().run(productionPrompt('艾娃', prompt));
  const facts = assetFacts(graph);
  assert.doesNotMatch(facts, layoutLeak);
  for (const fact of ['艾娃', '（左眼下有一颗细小泪痣）', '黑色长发', '发梢颜色从左到右由黑过渡到银白', '玫瑰豆沙唇色', '黑色短款西装与象牙白长裙', '左臂上部闭合低饱和灰褐色旧刀疤', '背面金色鹤纹刺绣', '右肩破损', '左臂刀疤不发光', '衣料微湿贴服', '普通状态', '不表现觉醒力量', '小型银色耳饰', '低干扰冷灰蓝背景', '柔和电影光照', '电影级半写实三维国漫动画']) {
    assert.ok(facts.includes(fact), `layout cleanup removed a mixed identity/state fact: ${fact}`);
  }
  assertSingleViewGraph(graph);
});

for (const anchor of [undefined, 'uploaded-front.png']) {
  for (const style of [undefined, 'uploaded-style.png']) {
    test(`native graph back view combines its side anchor and complete ${anchor ? 'uploaded' : 'generated'} front${style ? ', retaining style slot 2' : ''}`, () => {
      const graph = mockProvider().buildGraph(anchor, style);
      const anchorId = anchor ? '10' : '14';
      assertBackReferences(graph, anchorId, Boolean(style));
      for (const id of ['20', '30']) {
        assert.deepEqual(graph[id].inputs['images.image_1'], [anchorId, 0]);
        assert.equal(graph[id].inputs['images.image_3'], undefined);
        if (style) assert.deepEqual(graph[id].inputs['images.image_2'], ['15', 0]);
        else assert.equal(graph[id].inputs['images.image_2'], undefined);
      }
      assert.deepEqual(graph['50'].inputs.image2, [anchorId, 0]);
      if (anchor) { assert.equal(graph['11'], undefined); assert.equal(graph['10'].inputs.image, anchor); }
      else { assert.equal(graph['12'].inputs.batch_size, 1); assert.equal(graph['12'].inputs.width, 640); assert.equal(graph['12'].inputs.height, 960); }
      if (style) assert.equal(graph['15'].inputs.image, style);
      assert.ok(!Object.values(graph).some(node => node.class_type === 'LoraLoader'));
    });
  }
}

const reference = value => ({ type: 'image', base64: `data:image/png;base64,${Buffer.from(value).toString('base64')}` });
for (const withStyle of [false, true]) {
  test(`submitted native graph preserves uploaded front and ${withStyle ? 'style' : 'no-style'} reference roles`, async () => {
    const f = mockProvider(), refs = [reference('front'), ...(withStyle ? [reference('style')] : [])];
    const graph = await f.run('电影级3D人物，右肩宽结构、左肩细带。', refs);
    assert.deepEqual(f.uploads, withStyle ? ['front', 'style'] : ['front']);
    assert.equal(graph['10'].inputs.image, 'inputs/reference-1.png');
    assert.equal(graph['11'], undefined, 'a supplied approved front must not be regenerated');
    if (withStyle) assert.equal(graph['15'].inputs.image, 'inputs/reference-2.png');
    assertBackReferences(graph, '10', withStyle);
  });
}

test('a third internal conditioning image does not authorize a third user reference upload', async () => {
  const f = mockProvider();
  await assert.rejects(f.run('完整角色身份。', [reference('front'), reference('style'), reference('extra')]), /最多接收2张图片参考/);
  assert.deepEqual(f.uploads, []);
});

// The approved front contains the outfit; view edits inherit it without copying
// the whole design/layout prompt. This fixture keeps the actual new bag target.
const persistentBagPrompt = productionPrompt('艾娃',
  '电影级半写实三维国漫，艾娃，小鹅蛋脸，黑色高马尾，穿象牙白精织花呢短夹克、黑真丝心形领上衣与微A短裙，水滴白金耳坠；黑色硬挺迷你皮包，单肩短金属链垂于胯侧，不斜挎。四栏展示板，从左到右依次为：第一栏脸部特写，第二栏正面全身，第三栏90°左侧面全身，第四栏正后方全身。');
const bagContinuity = /persistent part of this SAME outfit|Preserve that exact bag|bag-bearing side|Do not delete the bag|Check the original front supplement <image\d+> for the bag/;

function assertNoBagContinuity(graph) {
  for (const id of ['20', '30', '40']) {
    assert.doesNotMatch(graph[id].inputs.prompt, bagContinuity,
      'a role without an affirmative bag target must not receive a bag-preservation instruction');
  }
}

function assertPersistentBagContinuity(graph, frontAnchorId, withStyle) {
  assertBackReferences(graph, frontAnchorId, withStyle);
  for (const id of ['30', '40']) {
    const prompt = graph[id].inputs.prompt;
    assert.match(prompt, /bag shown in the front anchor is a persistent part of this SAME outfit/);
    assert.match(prompt, /Preserve that exact bag, its strap or chain, size, material and attachment to the same wearer-relative body side/);
    assert.match(prompt, /even when partly occluded/);
    assert.match(prompt, /Do not delete the bag or its entire chain/);
    assert.match(prompt, /Do not introduce any accessory absent from the reference/);
    assert.doesNotMatch(prompt, /CURRENT ASSET FACTS|四栏|展示板|从左到右|艾娃|小鹅蛋脸|精织花呢短夹克|白金耳坠/,
      'carry the bag by its approved reference, without re-injecting the full character facts or layout');
  }
  assert.doesNotMatch(graph['20'].inputs.prompt, bagContinuity,
    'the head-and-shoulders portrait must not be forced to expose a hip-level bag');
  assert.deepEqual(graph['30'].inputs['images.image_1'], [frontAnchorId, 0]);
  assert.match(graph['40'].inputs.prompt,
    new RegExp(`Check the original front supplement <image${withStyle ? 3 : 2}> for the bag even if the side anchor omitted it`));
  assert.doesNotMatch(graph['40'].inputs.prompt,
    new RegExp(`Check the original front supplement <image${withStyle ? 2 : 3}> for the bag`),
    'recover a missing side-view bag from the original front, never from the style image or an unconnected slot');
}

for (const withStyle of [false, true]) {
  test(`submitted bag outfit inherits its exact bag and chain with ${withStyle ? 'style' : 'no-style'} reference roles`, async () => {
    const f = mockProvider();
    const graph = await f.run(persistentBagPrompt,
      [reference('approved-bag-front'), ...(withStyle ? [reference('render-style')] : [])]);
    assert.deepEqual(f.uploads, withStyle ? ['approved-bag-front', 'render-style'] : ['approved-bag-front']);
    assert.equal(graph['10'].inputs.image, 'inputs/reference-1.png');
    for (const id of ['11', '12', '13', '14']) {
      assert.equal(graph[id], undefined, 'an approved uploaded front must remain unchanged, without a new front render');
    }
    assert.deepEqual(graph['50'].inputs.image2, ['10', 0], 'the board keeps the supplied approved front itself');
    if (withStyle) assert.equal(graph['15'].inputs.image, 'inputs/reference-2.png');
    assertPersistentBagContinuity(graph, '10', withStyle);
  });
}

test('submitted generated-front bag outfit keeps cleaned bag facts only in the front and uses that front for recovery', async () => {
  const graph = await mockProvider().run(persistentBagPrompt);
  const facts = assetFacts(graph);
  assert.ok(facts.includes('黑色硬挺迷你皮包'));
  assert.ok(facts.includes('单肩短金属链垂于胯侧，不斜挎'));
  assert.doesNotMatch(facts, layoutLeak);
  assert.doesNotMatch(graph['11'].inputs.prompt, bagContinuity,
    'front generation uses its authoritative facts, rather than a nonexistent approved-front bag');
  assert.equal(graph['12'].inputs.batch_size, 1);
  assert.deepEqual(graph['50'].inputs.image2, ['14', 0]);
  assertPersistentBagContinuity(graph, '14', false);
});

for (const withStyle of [false, true]) {
  test(`submitted outfit without a bag does not add one${withStyle ? ' from its style reference' : ''}`, async () => {
    // 包边/包扎 are legitimate design/state words, not positive bag targets.
    const prompt = productionPrompt('角色', '黑色短外套，象牙白裙，黑丝绒包边，左臂包扎，珍珠耳饰。');
    const graph = await mockProvider().run(prompt,
      [reference('approved-front'), ...(withStyle ? [reference('style-with-unrelated-bag')] : [])]);
    assertNoBagContinuity(graph);
    assertBackReferences(graph, '10', withStyle);
    assert.equal(graph['11'], undefined);
  });
}

for (const prohibition of ['不要手提包', '不带皮包', '无包']) {
  for (const withStyle of [false, true]) {
    test(`submitted ${prohibition} outfit does not activate bag inheritance${withStyle ? ' with a style image' : ''}`, async () => {
      const graph = await mockProvider().run(productionPrompt('角色', `黑色长礼裙，金耳饰；${prohibition}。`),
        [reference('approved-no-bag-front'), ...(withStyle ? [reference('style')] : [])]);
      assertNoBagContinuity(graph);
      assertBackReferences(graph, '10', withStyle);
      assert.equal(graph['11'], undefined);
    });
  }
}

function garmentBackFacts(graph, id = '40') {
  const match = /CURRENT GARMENT BACK DESIGN \(clothing only\): ([\s\S]*?)\. This explicit construction/.exec(graph[id].inputs.prompt);
  assert.ok(match, 'an explicit rear garment design must reach the actual view encoder');
  return match[1];
}

function assertGarmentBackHandoff(graph, expected, anchorId, withStyle) {
  assertBackReferences(graph, anchorId, withStyle);
  for (const id of ['30', '40']) {
    const design = garmentBackFacts(graph, id);
    assert.ok(design.includes(expected), `lost the specified back construction/end point: ${expected}`);
    assert.doesNotMatch(design, /麦迪逊|维拉|心形小脸|柔光蜜桃|巧克力棕|祖母绿耳坠|四栏|展示板|后脑|正后方|伤疤/,
      'only local rear garment geometry is transferred, rather than identity, accessories, state or layout');
    assert.match(graph[id].inputs.prompt, /never infer an opening that is not specified/);
    assert.match(graph[id].inputs.prompt, /do not close it or extend it below its stated end point/);
    assert.match(graph[id].inputs.prompt, /Keep the requested view and natural occlusion; do not turn the person/);
    assert.doesNotMatch(graph[id].inputs.prompt, /CURRENT ASSET FACTS|四栏|展示板|从左到右|第[一二三四]栏/);
  }
  assert.deepEqual(graph['30'].inputs['images.image_1'], [anchorId, 0]);
  assert.equal(graph['30'].inputs['images.image_3'], undefined);
  if (withStyle) assert.deepEqual(graph['30'].inputs['images.image_2'], ['15', 0]);
  else assert.equal(graph['30'].inputs['images.image_2'], undefined);
  assert.doesNotMatch(graph['20'].inputs.prompt, /CURRENT GARMENT BACK DESIGN/,
    'the face portrait must not be reframed to reveal a garment back');
}

// Both compact briefs and the final model's separated clothing clauses are
// real forms of the current targets. No live database or model is used here.
const rearGarmentFixtures = [
  {
    name: '麦迪逊', form: 'low-U brief',
    clothing: '烟粉厚真丝贴身迷你裙，细肩带低垂褶领，胸托腰侧褶塑曲线；斜交叠裙摆至大腿中上段、侧衩，低U开背至腰上、细固定带；香槟细带高跟凉鞋。',
    expected: '低U开背至腰上、细固定带',
  },
  {
    name: '麦迪逊', form: 'low-U separated model clauses',
    clothing: '烟粉色厚真丝贴身迷你裙，细肩带；裙身斜交叠剪裁，裙摆至大腿中上段，侧衩自然开合；背部低U开至腰上，细固定带收束；面料有细腻缎光。',
    expected: '背部低U开至腰上，细固定带收束',
  },
  {
    name: '维拉', form: 'deep-V brief',
    clothing: '黑丝绒低心形露肩长礼裙，雕塑折片胸托公主线塑胸腰胯，深V开背至腰上；孔雀绿腰侧紧凑斜褶；祖母绿耳坠。',
    expected: '深V开背至腰上',
  },
  {
    name: '维拉', form: 'deep-V separated model clauses',
    clothing: '黑丝绒低心形露肩长礼裙，雕塑折片胸托公主线塑胸腰胯；背部深V开至腰上露出脊背线条；腰侧孔雀绿斜褶。',
    expected: '背部深V开至腰上露出脊背线条',
  },
];

const rearLayout = '四栏展示板，从左到右依次为：第一栏脸部特写，第二栏正面全身，第三栏90°左侧面全身，第四栏正后方全身，后脑与后背朝向观众。';
for (const fixture of rearGarmentFixtures) {
  for (const withStyle of [false, true]) {
    test(`submitted ${fixture.form} garment preserves its end point${withStyle ? ' with style slot 2' : ''}`, async () => {
      const prompt = productionPrompt(fixture.name,
        `${fixture.name}，心形小脸，柔光蜜桃唇色，巧克力棕色头发。${fixture.clothing}${rearLayout}`);
      const f = mockProvider();
      const graph = await f.run(prompt,
        [reference('approved-front'), ...(withStyle ? [reference('render-style')] : [])]);
      assertGarmentBackHandoff(graph, fixture.expected, '10', withStyle);
      assertNoBagContinuity(graph);
      assert.equal(graph['10'].inputs.image, 'inputs/reference-1.png');
      for (const id of ['11', '12', '13', '14']) assert.equal(graph[id], undefined,
        'a hidden back construction must not cause an approved front to be regenerated');
      assert.deepEqual(graph['50'].inputs.image2, ['10', 0]);
    });
  }
}

test('submitted rear neckline preserves a separate end-point clause while retaining bag and style reference roles', async () => {
  const prompt = productionPrompt('角色',
    `黑色长礼裙，后背领口采用深V形，开口下缘止于腰线上方，固定带收束；黑色硬挺迷你皮包，单肩短金属链垂于胯侧。${rearLayout}`);
  const graph = await mockProvider().run(prompt, [reference('bag-front'), reference('style')]);
  assertGarmentBackHandoff(graph, '后背领口采用深V形，开口下缘止于腰线上方，固定带收束', '10', true);
  assertPersistentBagContinuity(graph, '10', true);
  assert.doesNotMatch(garmentBackFacts(graph), /皮包|短金属链/,
    'bag continuity belongs to its existing inheritance rule, not the rear-neckline fact block');
});

test('submitted generated front retains full garment facts but only the local back target reaches view edits', async () => {
  const fixture = rearGarmentFixtures[1];
  const graph = await mockProvider().run(productionPrompt(fixture.name, `${fixture.clothing}${rearLayout}`));
  assert.ok(assetFacts(graph).includes(fixture.expected.split('，')[0]));
  assert.doesNotMatch(assetFacts(graph), layoutLeak);
  assert.doesNotMatch(graph['11'].inputs.prompt, /CURRENT GARMENT BACK DESIGN/);
  assertGarmentBackHandoff(graph, fixture.expected, '14', false);
  assert.equal(graph['12'].inputs.batch_size, 1);
  assert.deepEqual(graph['50'].inputs.image2, ['14', 0]);
});

const nonRearGarmentTargets = [
  { name: 'no rear target', facts: '黑色长礼裙，公主线收腰，裙摆至脚踝，珍珠耳饰。' },
  { name: 'back-view layout only', facts: `黑色长礼裙，裙摆至脚踝。${rearLayout}` },
  { name: 'back scar at a covered neckline', facts: '黑色长礼裙，后背领口附近有闭合灰褐色伤疤，背部伤痕不发光。' },
  { name: 'explicitly prohibited open back', facts: '黑色长礼裙，不采用低U开背至腰上的设计，保持背部衣料覆盖。' },
  { name: 'bare-body wording without a garment', facts: '角色只描述后背领口附近身体线条，背部低U开至腰上。' },
];
for (const target of nonRearGarmentTargets) {
  for (const withStyle of [false, true]) {
    test(`submitted ${target.name} does not invent an open-back garment${withStyle ? ' with a style reference' : ''}`, async () => {
      const graph = await mockProvider().run(productionPrompt('角色', target.facts),
        [reference('approved-covered-front'), ...(withStyle ? [reference('style')] : [])]);
      for (const id of ['20', '30', '40']) assert.doesNotMatch(graph[id].inputs.prompt, /CURRENT GARMENT BACK DESIGN/);
      assertNoBagContinuity(graph);
      assertBackReferences(graph, '10', withStyle);
      assert.equal(graph['11'], undefined);
    });
  }
}
