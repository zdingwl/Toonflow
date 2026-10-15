import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { reviewAssetImage, type AssetPromptContext } from "../src/utils/assetPromptGeneration";

const context = (): AssetPromptContext => ({
  input: { projectId: 1, assetsId: 11, type: "role", name: "角色卡人物", describe: "明确的脸型、体态、发型和默认衣装" },
  asset: { id: 11, name: "角色卡人物", describe: "明确的脸型、体态、发型和默认衣装", descriptionMeta: "{}" },
  parent: null, derivativeStates: [], references: [],
});
const pass = JSON.stringify({ passed: true, issues: [] });
const failure = (issue: string) => JSON.stringify({ passed: false, issues: [issue] });

async function pngFixture() {
  const width = 1001, height = 360, channels = 3 as const;
  const pixels = Buffer.alloc(width * height * channels, 255);
  const colors = [[100, 20, 30], [30, 120, 40], [40, 50, 140], [110, 90, 60]];
  for (let y = 15; y < height - 18; y++) for (let x = 0; x < width; x++) {
    const column = Math.min(3, Math.floor(x * 4 / width));
    const offset = (y * width + x) * channels;
    for (let channel = 0; channel < channels; channel++) pixels[offset + channel] = colors[column][channel];
  }
  const image = await sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
  return { width, height, pixels, image, dataUrl: `data:image/png;base64,${image.toString("base64")}` };
}
function mockVision(dataUrl: string, responses: string[]) {
  const calls: any[] = [], loads: string[] = [];
  return { calls, loads, deps: {
    loadImage: async (path: string) => { loads.push(path); return dataUrl; },
    invoke: async (input: any) => { calls.push(input); const text = responses.shift(); if (text === undefined) throw new Error("unexpected extra vision call"); return { text }; },
  } };
}

test("four-view review supplies the complete PNG and four original-pixel columns without changing production references", async () => {
  const fixture = await pngFixture();
  const vision = mockVision(fixture.dataUrl, [pass]);
  const original = context();
  const before = JSON.stringify(original);
  await reviewAssetImage(vision.deps, original, "完整四视图，第一栏特写，后三栏全身", "paid-candidate.png", { fourViewEvidence: true });
  assert.deepEqual(vision.loads, ["paid-candidate.png"]);
  assert.equal(vision.calls.length, 1);
  assert.equal(JSON.stringify(original), before);
  const parts = vision.calls[0].messages[0].content;
  const images = parts.filter((part: any) => part.type === "image");
  assert.equal(images.length, 5);
  assert.deepEqual(images[0].image, fixture.image);
  const reconstruction: sharp.OverlayOptions[] = [];
  for (let index = 0; index < 4; index++) {
    const left = Math.floor(fixture.width * index / 4), right = Math.floor(fixture.width * (index + 1) / 4);
    const metadata = await sharp(images[index + 1].image).metadata();
    assert.equal(metadata.width, right - left);
    assert.equal(metadata.height, fixture.height);
    const raw = await sharp(images[index + 1].image).removeAlpha().raw().toBuffer();
    assert.ok(raw.subarray(0, (right - left) * 3).every((pixel: number) => pixel === 255));
    assert.ok(raw.subarray(raw.length - (right - left) * 3).every((pixel: number) => pixel === 255));
    reconstruction.push({ input: images[index + 1].image, left, top: 0 });
  }
  const joined = await sharp({ create: { width: fixture.width, height: fixture.height, channels: 3, background: "white" } }).composite(reconstruction).removeAlpha().raw().toBuffer();
  assert.deepEqual(joined, fixture.pixels);
  const labels = parts.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  assert.match(labels, /原完整图第 1 栏审核细节：正面脸部特写/);
  assert.match(labels, /原完整图第 2 栏审核细节：正面全身/);
  assert.match(labels, /原完整图第 3 栏审核细节：严格左侧面全身/);
  assert.match(labels, /原完整图第 4 栏审核细节：正后方全身/);
  assert.match(labels, /脚尖、鞋底与下方留白完整可见时不能判作脚被裁切/);
});

test("a disputed cropped-foot judgment receives one second review with identical image evidence and its exact original issue", async () => {
  const fixture = await pngFixture();
  const disputed = "第4栏的脚被裁切";
  const vision = mockVision(fixture.dataUrl, [failure(disputed), pass]);
  await reviewAssetImage(vision.deps, context(), "完整四栏人物图", "paid-candidate.png", { fourViewEvidence: true });
  assert.equal(vision.calls.length, 2);
  const first = vision.calls[0].messages[0].content, second = vision.calls[1].messages[0].content;
  assert.deepEqual(second.slice(0, -1), first);
  assert.ok(second.at(-1).text.includes(JSON.stringify([disputed])));
  assert.match(second.at(-1).text, /真实方向、身份、衣装或缺失冲突必须保留/);
  assert.match(second.at(-1).text, /证据不足时不得为了通过而删除问题/);
});

test("a real persistent identity or view mismatch still rejects after the bounded second review", async () => {
  const fixture = await pngFixture();
  const issue = "第4栏仍为正面，和规定的正后方视角冲突";
  const vision = mockVision(fixture.dataUrl, [failure(issue), failure(issue)]);
  await assert.rejects(reviewAssetImage(vision.deps, context(), "完整四栏人物图", "paid-candidate.png", { fourViewEvidence: true }), /新图片与资产设定不一致，保留原图.*第4栏仍为正面/);
  assert.equal(vision.calls.length, 2);
});

test("default image review retains one complete candidate and does not add four-column reinterpretation or a semantic retry", async () => {
  const fixture = await pngFixture();
  const vision = mockVision(fixture.dataUrl, [failure("真实衣装不符")]);
  await assert.rejects(reviewAssetImage(vision.deps, context(), "人物图", "candidate.png"), /真实衣装不符/);
  assert.equal(vision.calls.length, 1);
  const images = vision.calls[0].messages[0].content.filter((part: any) => part.type === "image");
  assert.equal(images.length, 1);
  assert.deepEqual(images[0].image, fixture.image);
});

test("invalid four-view image bytes fail closed before requesting a visual judgment", async () => {
  const vision = mockVision("data:image/png;base64," + Buffer.from("not a real PNG").toString("base64"), [pass]);
  await assert.rejects(reviewAssetImage(vision.deps, context(), "人物图", "invalid.png", { fourViewEvidence: true }));
  assert.equal(vision.calls.length, 0);
});
