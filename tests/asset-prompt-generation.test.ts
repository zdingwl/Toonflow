import { readFileSync } from "node:fs";
import { getArtPrompt } from "../src/utils/getArtPrompt";
import sharp from "sharp";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import {
  generateAssetPrompt,
  loadAssetPromptContext,
  reviewAssetImage,
  type AssetPromptInput,
} from "../src/utils/assetPromptGeneration";

const input: AssetPromptInput = { projectId: 1, assetsId: 10, type: "role", name: "艾娃", describe: "现代都市人物，保留已确认外观。" };
const manual = "半写实国漫3D，克制眼脸比例、自然皮肤纹理、细密独立发丝和可读织物。";
const validPrompt = "同一角色的四栏角色设定图，艾娃保持马尾、红色上衣与黑色短裙，脸型与发型跨视角一致。";
const pass = JSON.stringify({ passed: true, issues: [] });
const fail = (issue: string) => JSON.stringify({ passed: false, issues: [issue] });

test("selected concept-art manual reaches both writer and auditor while old images retain identity only", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const selectedManual = getArtPrompt("realistic_3d_anime", "art_skills", "art_character");
  const vision = fakeVision([validPrompt, pass]);
  await generateAssetPrompt(vision.deps, context, selectedManual);
  assert.match(vision.calls[0].system, /premium anime-realistic concept art/);
  assert.match(vision.calls[0].system, /polished illustration rendering/);
  assert.match(vision.calls[0].system, /冷灰蓝/);
  assert.doesNotMatch(vision.calls[0].system, /cinematic semi-realistic Chinese 3D donghua|可信PBR|受控次表面散射|采用纯净浅灰背景/);
  for (const call of vision.calls) {
    const text = call.messages[0].content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    assert.match(text, /不能把旧图的棚拍、塑料CG或其他旧画风锁成身份/);
    assert.match(text, /画风调整不得擅改脸型、年龄、发型、服装与状态/);
  }
  assert.match(vision.calls[1].messages[0].content.at(-1).text, /premium anime-realistic concept art/);
  assert.deepEqual(vision.loaded, ["selected-sheet.png"]);
  assert.equal((await db("o_assets").where({id:10}).first()).prompt, "已有正文");
});

async function fixture(t: TestContext) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(async () => { await db.destroy(); });
  await db.schema.createTable("o_assets", table => {
    table.integer("id").primary(); table.integer("projectId"); table.integer("assetsId");
    table.text("type"); table.text("name"); table.text("describe"); table.text("prompt");
    table.integer("imageId"); table.text("faceReferencePath"); table.text("fullBodyReferencePath");
  });
  await db.schema.createTable("o_image", table => {
    table.integer("id").primary(); table.integer("assetsId"); table.text("filePath"); table.text("state");
  });
  await db("o_assets").insert({
    id: 10, projectId: 1, type: "role", name: "艾娃", describe: input.describe, prompt: "已有正文", imageId: 100,
    faceReferencePath: "stale-face.png", fullBodyReferencePath: "stale-body.png",
  });
  await db("o_image").insert({ id: 100, assetsId: 10, filePath: "selected-sheet.png", state: "已完成" });
  return db;
}

function fakeVision(outputs: string[]) {
  const calls: any[] = [];
  const loaded: string[] = [];
  return {
    calls,
    loaded,
    deps: {
      loadImage: async (path: string) => {
        loaded.push(path);
        return `data:image/png;base64,${Buffer.from(path).toString("base64")}`;
      },
      invoke: async (request: any) => {
        calls.push({
          ...request,
          messages: request.messages.map((message: any) => ({
            ...message,
            content: Array.isArray(message.content) ? message.content.map((part: any) => ({ ...part })) : message.content,
          })),
        });
        assert.ok(calls.length <= outputs.length, "模型调用不能超过已安排的生成/审核次数");
        return { text: outputs[calls.length - 1] };
      },
    },
  };
}

test("asset context rejects wrong project or asset type and a parent from another project", async t => {
  const db = await fixture(t);
  await assert.rejects(loadAssetPromptContext(db, { ...input, projectId: 2 }), /资产不存在、类型不符或不属于当前项目/);
  await assert.rejects(loadAssetPromptContext(db, { ...input, type: "scene" }), /资产不存在、类型不符或不属于当前项目/);
  await db("o_assets").insert({ id: 20, projectId: 2, type: "role", name: "其他项目人物", imageId: 200 });
  await db("o_image").insert({ id: 200, assetsId: 20, filePath: "other-project.png" });
  await db("o_assets").where({ id: 10 }).update({ assetsId: 20 });
  await assert.rejects(loadAssetPromptContext(db, input), /父资产缺失、类型不符或不属于当前项目/);
  await db("o_assets").where({ id: 20 }).update({ projectId: 1, type: "tool" });
  await assert.rejects(loadAssetPromptContext(db, input), /父资产缺失、类型不符或不属于当前项目/);
});

test("first base design may generate without an image, but derivative role requires a parent image", async t => {
  const db = await fixture(t);
  await db("o_assets").where({ id: 10 }).update({ imageId: null });
  const context = await loadAssetPromptContext(db, input);
  assert.equal(context.parent, null);
  assert.deepEqual(context.references, []);
  const vision = fakeVision([validPrompt, pass]);
  assert.equal(await generateAssetPrompt(vision.deps, context, manual), validPrompt);
  assert.deepEqual(vision.loaded, []);
  assert.match(vision.calls[0].messages[0].content[0].text, /无图片的首次基础设计可按事实生成/);
  await db("o_assets").insert({ id: 20, projectId: 1, type: "role", name: "父角色", imageId: null });
  await db("o_assets").where({ id: 10 }).update({ assetsId: 20 });
  await assert.rejects(loadAssetPromptContext(db, input), /衍生人物缺少父角色参考图/);
});

test("context carries independent child states and derivative parent identity", async t => {
  const db = await fixture(t);
  await db("o_assets").insert([
    { id: 11, projectId: 1, assetsId: 10, type: "role", name: "觉醒状态", describe: "虹膜变红", imageId: null },
    { id: 12, projectId: 1, assetsId: 10, type: "role", name: "受伤状态", describe: "左臂干净包扎", imageId: null },
    { id: 13, projectId: 2, assetsId: 10, type: "role", name: "跨项目状态", describe: "不应读入", imageId: null },
  ]);
  const base = await loadAssetPromptContext(db, input);
  assert.deepEqual(base.derivativeStates, [
    { id: 11, name: "觉醒状态", describe: "虹膜变红" },
    { id: 12, name: "受伤状态", describe: "左臂干净包扎" },
  ]);
  const derivative = await loadAssetPromptContext(db, { ...input, assetsId: 11, name: "觉醒状态", describe: "虹膜变红" });
  assert.equal(derivative.parent.id, 10);
  assert.equal(derivative.parent.describe, input.describe);
  assert.deepEqual(derivative.derivativeStates, []);
  assert.deepEqual(derivative.references, [{ path: "selected-sheet.png", role: "parentReference", label: "艾娃 (10)" }]);
});

test("receipt image override loads the previous selected sheet instead of pending image or stale crops", async t => {
  const db = await fixture(t);
  await db("o_image").insert({ id: 101, assetsId: 10, filePath: null, state: "生成中" });
  await db("o_assets").where({ id: 10 }).update({ imageId: 101 });
  const context = await loadAssetPromptContext(db, input, { 10: 100 });
  assert.equal(context.asset.selectedImagePath, "selected-sheet.png");
  assert.deepEqual(context.references, [{ path: "selected-sheet.png", role: "actualReference", label: "艾娃 (10)" }]);
  assert.deepEqual((await loadAssetPromptContext(db, input, { 10: null })).references, []);
  await db("o_image").insert({ id: 102, assetsId: 99, filePath: "another-asset.png" });
  assert.deepEqual((await loadAssetPromptContext(db, input, { 10: 102 })).references, []);
});

test("derivative writer and audit use parent facts without copying the old erroneous output", async t => {
  const db = await fixture(t);
  await db("o_assets").insert({ id: 11, projectId: 1, assetsId: 10, type: "role", name: "艾娃觉醒", describe: "虹膜变红", prompt: "错误机能服和虚构青蓝脉络", imageId: 110 });
  await db("o_image").insert({ id: 110, assetsId: 11, filePath: "awakening-sheet.png" });
  const context = await loadAssetPromptContext(db, { ...input, assetsId: 11, name: "艾娃觉醒", describe: "虹膜变红" });
  const vision = fakeVision([validPrompt, pass]);
  assert.equal(await generateAssetPrompt(vision.deps, context, manual), validPrompt);
  assert.deepEqual(vision.loaded, ["selected-sheet.png"]);
  assert.equal(vision.calls.length, 2);
  assert.match(vision.calls[0].system, /克制眼脸比例/);
  for (const call of vision.calls) {
    const parts = call.messages[0].content;
    const images = parts.filter((part: any) => part.type === "image");
    assert.equal(images.length, 1);
    assert.ok(images.every((part: any) => Buffer.isBuffer(part.image)));
    assert.deepEqual(images.map((part: any) => part.image.toString()), ["selected-sheet.png"]);
    assert.ok(images.every((part: any) => part.mediaType === "image/png"));
    assert.equal(parts[1].text, "parentReference: 艾娃 (10)");
    assert.match(parts[0].text, /parentIdentity=.*艾娃/);
    assert.doesNotMatch(JSON.stringify(call), /错误机能服|虚构青蓝脉络|awakening-sheet|actualReference: 艾娃觉醒|legacyPromptForComparisonOnly/);
  }
});

test("derivative candidate review compares the parent and new candidate, not an old derivative", async t => {
  const db = await fixture(t);
  await db("o_assets").insert({ id: 11, projectId: 1, assetsId: 10, type: "role", name: "艾娃觉醒", describe: "虹膜变红", prompt: "错误机能服", imageId: 110 });
  await db("o_image").insert({ id: 110, assetsId: 11, filePath: "old-wrong-derivative.png" });
  const context = await loadAssetPromptContext(db, { ...input, assetsId: 11, name: "艾娃觉醒", describe: "虹膜变红" });
  const vision = fakeVision([pass]);
  await reviewAssetImage(vision.deps, context, validPrompt, "new-candidate.png");
  assert.deepEqual(vision.loaded, ["selected-sheet.png", "new-candidate.png"]);
  assert.doesNotMatch(JSON.stringify(vision.calls), /错误机能服|old-wrong-derivative/);
  assert.equal((await db("o_assets").where({ id: 11 }).first()).imageId, 110);
});

test("failed consistency audit gets one repair and cannot return a savable prompt if still failing", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const vision = fakeVision([validPrompt, fail("裙装被改成长裤"), "修正候选正文", fail("仍然错误改变衣装")]);
  let returned: string | undefined;
  await assert.rejects(async () => { returned = await generateAssetPrompt(vision.deps, context, manual); }, /资产图文检查未通过：仍然错误改变衣装/);
  assert.equal(returned, undefined);
  assert.equal(vision.calls.length, 4);
  assert.equal(vision.calls[2].messages.length, 3);
  assert.equal(vision.calls[2].messages[1].content, validPrompt);
  assert.match(vision.calls[2].messages[2].content, /裙装被改成长裤/);
  assert.equal((await db("o_assets").where({ id: 10 }).first()).prompt, "已有正文");
});

test("Markdown output is repaired into plain drawing instructions before audit", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const vision = fakeVision(["## 角色设定\n**艾娃**：红色上衣", validPrompt, pass]);
  assert.equal(await generateAssetPrompt(vision.deps, context, manual), validPrompt);
  assert.equal(vision.calls.length, 3);
  assert.match(vision.calls[1].messages.at(-1).content, /不含 Markdown、编号列表或解释/);
  assert.match(vision.calls[2].system, /资产视觉一致性审核员/);
});

test("explicit review-required output and malformed audit fail closed", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const review = fakeVision(["ASSET_REVIEW_REQUIRED: 基础态与觉醒态身份标志冲突"]);
  await assert.rejects(generateAssetPrompt(review.deps, context, manual), /资产设定需要核对：基础态与觉醒态身份标志冲突/);
  assert.equal(review.calls.length, 1);
  const malformed = fakeVision([validPrompt, JSON.stringify({ passed: true, issues: ["冲突仍未解决"] })]);
  await assert.rejects(generateAssetPrompt(malformed.deps, context, manual), /图文一致性检查结果不完整/);
});

test("explicit wardrobe overrides an old selected image and occluded marks need not appear in every view", async t => {
  const db = await fixture(t);
  const target = { ...input, describe: "黑色低马尾，红色长袖上衣、黑色百褶裙；左臂旧刀疤被完整长袖遮挡，不卷袖。" };
  await db("o_assets").where({ id: 10 }).update({ describe: target.describe });
  const context = await loadAssetPromptContext(db, target);
  const wrong = "披发，灰褐无袖上衣和长裤，共四名视角；脸部特写和背面必须清晰展示左臂刀疤。";
  const corrected = "同一人的四个视角，艾娃黑色低马尾，红色长袖上衣、黑色百褶裙，左臂旧刀疤被完整长袖遮挡。";
  const vision = fakeVision([wrong, fail("未遵循明确衣装，强迫露出刀疤且视角量词错误"), corrected, pass]);
  assert.equal(await generateAssetPrompt(vision.deps, context, manual), corrected);
  const text = (call: any) => call.messages[0].content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  assert.match(text(vision.calls[0]), /黑色低马尾，红色长袖上衣、黑色百褶裙/);
  assert.match(text(vision.calls[0]), /旧图仅补充未指定字段/);
  assert.match(vision.calls[1].system, /特写不强制露出手臂/);
  assert.match(vision.calls[1].system, /不能用旧图衣装替换本次指定衣装/);
  assert.match(vision.calls[1].system, /不能误写成“四名视角”/);
  assert.match(vision.calls[2].messages.at(-1).content, /未遵循明确衣装/);
  assert.deepEqual(vision.loaded, ["selected-sheet.png"]);
  assert.equal((await db("o_assets").where({ id: 10 }).first()).prompt, "已有正文");
});

test("repeated malformed audit is bounded and cannot replace a saved prompt", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const broken = '{"passed":false,issues":["服装存在冲突"]}';
  const vision = fakeVision([validPrompt, broken, broken]);
  await assert.rejects(generateAssetPrompt(vision.deps, context, manual), /已自动重试一次/);
  assert.equal(vision.calls.length, 3, "one writer and at most two audit requests");
  assert.equal((await db("o_assets").where({ id: 10 }).first()).prompt, "已有正文");
  assert.equal(vision.calls[0].output, undefined);
  assert.ok(vision.calls[1].output);
  assert.doesNotMatch(vision.calls[1].messages[0].content[0].text, /请将以下资产事实转换|最终绘制正文|只返回 ASSET_REVIEW_REQUIRED/);
});

test("a length-truncated audit must be retried even when its text parses", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const vision = fakeVision([validPrompt, pass, pass]);
  const invoke = vision.deps.invoke;
  vision.deps.invoke = async request => ({ ...await invoke(request), finishReason: vision.calls.length === 2 ? "length" : "stop" });
  assert.equal(await generateAssetPrompt(vision.deps, context, manual), validPrompt);
  assert.equal(vision.calls.length, 3);
});

test("candidate image review rejects inconsistency and preserves selected asset and image rows", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const assetsBefore = await db("o_assets").select("*");
  const imagesBefore = await db("o_image").select("*");
  const writes: string[] = [];
  db.on("query", query => { if (/^\s*(insert|update|delete|replace|create|alter|drop)\b/i.test(query.sql)) writes.push(query.sql); });
  const vision = fakeVision([fail("候选图把红色上衣改为银色盔甲")]);
  await assert.rejects(reviewAssetImage(vision.deps, context, validPrompt, "candidate.png"), /新图片与资产设定不一致，保留原图：候选图把红色上衣改为银色盔甲/);
  assert.deepEqual(vision.loaded, ["selected-sheet.png", "candidate.png"]);
  const candidate = vision.calls[0].messages[0].content.at(-1);
  assert.ok(Buffer.isBuffer(candidate.image));
  assert.equal(candidate.image.toString(), "candidate.png");
  assert.deepEqual(await db("o_assets").select("*"), assetsBefore);
  assert.deepEqual(await db("o_image").select("*"), imagesBefore);
  assert.deepEqual(writes, []);
});

test("oversized reference sheets are bounded for vision without changing the original image", async t => {
  const db = await fixture(t);
  const context = await loadAssetPromptContext(db, input);
  const png = await sharp({ create: { width: 4096, height: 2048, channels: 3, background: "red" } }).png().toBuffer();
  // Valid PNG with harmless trailing bytes models a provider's oversized file.
  const source = Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024)]);
  const dataUrl = `data:image/png;base64,${source.toString("base64")}`;
  const vision = fakeVision([validPrompt, pass]);
  vision.deps.loadImage = async () => dataUrl;
  await generateAssetPrompt(vision.deps, context, manual);
  const sent = vision.calls[0].messages[0].content.find((part: any) => part.type === "image");
  assert.equal(sent.mediaType, "image/jpeg");
  assert.ok(sent.image.byteLength < 8 * 1024 * 1024);
  const metadata = await sharp(sent.image).metadata();
  assert.equal(metadata.width, 3072);
  assert.equal(metadata.height, 1536);
  assert.equal(dataUrl, `data:image/png;base64,${source.toString("base64")}`);
  assert.equal((await db("o_image").where({ id: 100 }).first()).filePath, "selected-sheet.png");
});


for (const scenario of [
  { type: "role" as const, manual: "art_character", name: "艾娃", facts: "黑发低马尾，红色长袖上衣、黑色短裙，左臂旧刀疤由袖子遮挡。", expected: /一张展示板中同一个人的四个视角/ },
  { type: "scene" as const, manual: "art_scene", name: "公寓", facts: "入口在西侧，床在窗下，右侧书桌与暖台灯，通道保持可行走。", expected: /一张单画面主视图/ },
  { type: "tool" as const, manual: "art_prop", name: "巨鲨", facts: "蓝灰色背部、白色腹部、宽大胸鳍与完整鱼尾，自然游动姿态。", expected: /默认一张单画面、一个主体的清晰主视图/ },
]) {
  test("asset writer keeps complete " + scenario.type + " design separate from short video bindings", async t => {
    const db = await fixture(t);
    await db("o_assets").where({ id: 10 }).update({ type: scenario.type, name: scenario.name, describe: scenario.facts });
    const context = await loadAssetPromptContext(db, { ...input, type: scenario.type, name: scenario.name, describe: scenario.facts });
    const styleManual = readFileSync("data/skills/art_skills/realistic_3d_anime/art_prompt/" + scenario.manual + ".md", "utf8");
    const completePrompt = "半写实国漫3D，" + scenario.name + "，" + scenario.facts;
    const vision = fakeVision([completePrompt, pass]);
    assert.equal(await generateAssetPrompt(vision.deps, context, styleManual), completePrompt);
    const writer = vision.calls[0];
    assert.match(writer.system, /资产图片绘制定义/);
    assert.match(writer.system, /不能用“同参考图”或供视频使用的短绑定句替代必要设计/);
    assert.match(writer.system, /审核按完整图片目标检查/);
    assert.match(writer.system, scenario.expected);
    assert.match(writer.system, /全局内容表现约束/);
    assert.ok(writer.messages[0].content[0].text.includes(scenario.facts));
    assert.ok(vision.calls[1].messages[0].content.at(-1).text.includes(completePrompt));
    assert.deepEqual(vision.loaded, ["selected-sheet.png"]);
  });
}

test("asset manuals retain same-state full designs, explicit multi-view exceptions and meaningful derivatives", () => {
  const manual = (name: string) => readFileSync("data/skills/art_skills/realistic_3d_anime/art_prompt/" + name + ".md", "utf8");
  const role = manual("art_character");
  const derivative = manual("art_character_derivative");
  for (const content of [role, derivative]) {
    assert.match(content, /每个子任务只生成一个角色的一种视角/);
    assert.match(content, /同一(?:角色|人物)[、]?同一状态/);
  }
  assert.match(derivative, /目标状态中的变化优先于基础态默认值/);
  assert.match(derivative, /完整描述继承后的身份、衣装和当前状态/);
  const sceneDerivative = manual("art_scene_derivative");
  assert.match(sceneDerivative, /机位只是镜头参数，不单独构成衍生状态/);
  assert.match(sceneDerivative, /陈设布局、损坏状态或事件痕迹/);
  for (const name of ["art_prop", "art_prop_derivative"]) {
    const content = manual(name);
    assert.match(content, /(?:仅|只有)用户事实明确要求多视图时/);
    assert.match(content, /生物.*活体/);
    assert.match(content, /全局表现约束/);
    assert.match(content, /单主体主视图|一个主体的清晰主视图/);
  }
});
