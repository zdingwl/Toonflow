import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = {
  seedance2: "seedance2Multi-parameterMode.md",
  "first-last": "universalFirstAndLastFrameMode.md",
  "multi-reference": "universalMulti-parameterMode.md",
  "wan2.6": "wan2.6Single-imageFirstFrameMode.md",
};
const templates = Object.fromEntries(Object.entries(files).map(([family, name]) => [family, readFileSync("data/modelPrompt/video/" + name, "utf8")]));

for (const [family, source] of Object.entries(templates)) {
  test(`${family} identifies its family and accepts the actual source and media contracts`, () => {
    assert.equal([...source.matchAll(/<!-- toonflow-video-template: ([^>]+) -->/g)].length, 1);
    assert.ok(source.startsWith(`<!-- toonflow-video-template: ${family} -->`));
    assert.match(source, /七列 Markdown 表格：序号 \| 画面描述 \| 时长 \| 景别 \| 运镜 \| 台词 \| 音效/);
    assert.match(source, /自然语言/); assert.match(source, /资产 ID 是数字|数字资产 ID/);
    assert.match(source, /role\/scene\/tool|role、scene、tool/);
    for (const field of ["mode", "target_duration", "referenceSlots", "mediaType", "mediaIndex", "frameRole"]) assert.ok(source.includes(field), `${family} missing ${field}`);
    assert.match(source, /共同内容准则/);
    assert.doesNotMatch(source, /按顿号|12个字段|十二字段|shouldGenerateImage|associateAssetsIds|<storyboardItem\b|\[A00\d[,\]]/);
  });

  test(`${family} retains source shots, exact dialogue and time budgets without inventing image observations`, () => {
    assert.match(source, /每个七列表格行对应一个镜头/);
    assert.match(source, /切镜/); assert.match(source, /未知[\s\S]{0,40}不编绝对秒数/);
    assert.match(source, /完整原句/); assert.match(source, /指定语言/);
    assert.match(source, /未收到图片像素时/); assert.match(source, /不声称观察|不声称看过/);
    assert.match(source, /项目[\s\S]{0,80}(媒介|渲染)/);
    assert.match(source, /全景[\s\S]{0,85}(全身|全局)/);
    assert.doesNotMatch(source, /全景\s*\|\s*wide establishing shot|全程单一连贯镜头|绝不切镜|不出现.*绝对秒数|全部用英文|提示词输出全部用英文/);
    assert.doesNotMatch(source, /photorealistic|4K, high contrast|dark flowing robes|light-colored dress|默认音色|反派\/冷酷角色|9 维度|九维度/);
  });

  test(`${family} treats linked voice IDs as metadata and excludes unuploaded audio or video`, () => {
    assert.match(source, /当前[\s\S]{0,20}(只有图片|只上传图片)/);
    assert.match(source, /audio:ID/); assert.match(source, /音色关联/);
    assert.match(source, /不(?:能)?(?:证明|代表|虚构|声称|等于|写)[\s\S]{0,30}(上传|参考|音频)/);
    assert.match(source, /HTML注释/);
    assert.doesNotMatch(source, /不区分 role \/ scene \/ tool \/ audio|音色：取自 @图片|全部无分镜图|强制使用/);
  });
}

test("Seedance uses separate native media indexes and allows supplied storyboard images and target lighting", () => {
  const source = templates.seedance2;
  for (const label of ["@图片N", "@音频N", "@视频N"]) assert.ok(source.includes(label));
  assert.match(source, /媒体序号分别计数/);
  assert.match(source, /只引用实际存在的分镜图/);
  assert.match(source, /合法的光线变化/);
  assert.doesNotMatch(source, /正文与约束包均.*不写|不另描述光影|约束包必挂|禁字幕兜底/);
});

test("first/last mode uses declared transport roles and does not enforce a continuous single take", () => {
  const source = templates["first-last"];
  assert.match(source, /明确 first_frame/); assert.match(source, /明确 last_frame/);
  assert.match(source, /只有首帧时/); assert.match(source, /实际存在尾帧时/);
  assert.match(source, /首尾帧控制不等于一镜到底/);
  assert.match(source, /不强制五段静态清单/);
});

test("generic multi-reference does not pretend its aliases or section headings are a universal native protocol", () => {
  const source = templates["multi-reference"];
  assert.match(source, /没有跨模型统一的原生标签/);
  assert.match(source, /不是任何供应商的通用 API 协议/);
  assert.match(source, /不能按资产列表、资产类型或数据库 ID 重新编号/);
  assert.match(source, /不是每条分镜都有图/);
});

test("Wan separates first-frame I2V from ordered R2V character labels and keeps its API limits out of the screenplay", () => {
  const source = templates["wan2.6"];
  assert.match(source, /r2v\/reference-to-video/); assert.match(source, /i2v\/首帧任务/);
  assert.match(source, /它不提供尾帧控制/);
  assert.match(source, /reference_urls 上传顺序/);
  assert.match(source, /slot 原顺序筛出 image\/video/);
  assert.match(source, /character1、character2、character3/);
  assert.match(source, /音频的独立媒体序号不是 character 编号/);
  assert.match(source, /shot_type、prompt_extend/); assert.match(source, /1500字符/);
  assert.doesNotMatch(source, /每次仅输入.*一条|每次仅处理一条|像写小说一样/);
});
