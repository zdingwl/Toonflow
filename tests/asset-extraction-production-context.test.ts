import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { transform } from "sucrase";
import knex from "knex";
import * as skill from "../src/utils/assetVisualDesignSkill";
import { buildAssetExtractionArtContext } from "../src/utils/assetPrompt";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, estimateAssetExtractionRequestTokens } from "../src/utils/assetExtractionContext";
import { validateFields } from "../src/middleware/middleware";
import { success, error } from "../src/lib/responseFormat";

const defaultTemplate = readFileSync("data/modelPrompt/system/scriptAssetExtraction.md", "utf8").trim();
const originalQuote = "  艾娃是女性，黑色长发，日常穿白色衬衫。";
const userGoal = "明确要求网红美型脸、非常漂亮和完整时髦穿搭；原文已定衣装类别保留，未规定的裁剪、妆发与少量日常配饰可以美化。";
const visual = {
  face: "流畅小鹅蛋脸，杏眼与微挑眉尾，精致鼻尖，清楚唇峰与柔雾玫瑰豆沙妆，五官比例协调。",
  body: "自然比例，清楚肩线与衣装剪影，不推断年龄或成人曲线。",
  hair: "墨黑色顺滑长发，高马尾与弧形脸周发束，颅顶有自然蓬松度。",
  clothing: "象牙白翻领柔缎衬衫搭黑色短款收腰外套，奶油白高腰中长A字裙，裙摆垂坠且保留活动松量，黑色低跟踝靴与小型银色耳饰，材质和长短比例清楚。",
  environment: "", shape: "",
};
const priorDesign = { ...visual, face: "原有鹅蛋脸与自然眉眼，面部比例协调。", clothing: "白色翻领衬衫、灰色长裤与黑色平底鞋，领口规整，面料自然垂坠。" };

async function fixture(t: TestContext, useData: string | null = null, maximumPeers = false) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_project", table => { table.integer("id"); table.text("artStyle"); });
  await db.schema.createTable("o_prompt", table => { for (const field of ["type", "data", "useData"]) table.text(field); });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId");
    for (const field of ["name", "content", "errorReason"]) table.text(field);
    table.integer("extractState");
  });
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); table.primary(["scriptId", "assetId"]); });
  await migrateAssetDescriptions(db);
  await db("o_project").insert({ id: 1, artStyle: "realistic_3d_anime" });
  await db("o_prompt").insert({ type: "scriptAssetExtraction", data: defaultTemplate, useData });
  await db("o_script").insert({ id: 701, projectId: 1, name: "第一集", content: originalQuote, extractState: 1 });
  await db("o_assets").insert({ id: 10, projectId: 1, name: "艾娃", type: "role", imageId: 40,
    describe: "女性，黑色长发，白色翻领衬衫配灰色长裤与黑色平底鞋，面部比例协调。", prompt: "保留既有图提示词",
    descriptionMeta: JSON.stringify({ userConstraints: userGoal, visualDesign: priorDesign }) });
  await db("o_scriptAssets").insert({ scriptId: 701, assetId: 10 });
  for (let index = 0; index < 8; index++) {
    const peerDesign = maximumPeers ? { ...visual, face: "精".repeat(120), hair: "发".repeat(100), clothing: "衣".repeat(180) } : visual;
    await db("o_assets").insert({ id: 20 + index, projectId: 1, name: `同项目角色${index + 1}`, type: "role",
      descriptionMeta: JSON.stringify({ visualDesign: peerDesign }) });
  }
  const calls: { request: any; input: any; schema: any; estimated: number }[] = [];
  let completion: Promise<unknown> | undefined;
  const invoke = async (request: any) => {
    const input = JSON.parse(request.messages[0].content), schema = await request.tools.resultTool.inputSchema.jsonSchema;
    const estimated = estimateAssetExtractionRequestTokens(request.system, input, schema);
    calls.push({ request, input, schema, estimated });
    const value = schema.properties.newAssets ? { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [701] }] }
      : { describe: "女性，黑色长发，象牙白翻领衬衫与完整黑白剪裁搭配，玫瑰豆沙妆，保持自然比例。",
        visualDesign: visual, scriptFacts: [{ sourceRef: "701:1", fact: "黑色长发" }], conflicts: [] };
    await request.tools.resultTool.execute(value, {});
    return { finishReason: "tool-calls" };
  };
  const imports: Record<string, any> = {
    "@/utils": { db, getPath: (parts: string[]) => path.join(process.cwd(), "data", ...parts), Ai: { Text: () => ({ invoke }) }, error: (cause: any) => ({ message: cause.message }) },
    "@/utils/assetVisualDesignSkill": skill,
    "@/utils/assetPrompt": { buildAssetExtractionArtContext },
    "@/utils/scriptAssetExtraction": { extractScriptAssets: (deps: Parameters<typeof extractScriptAssets>[0], options: Parameters<typeof extractScriptAssets>[1]) => {
      completion = extractScriptAssets(deps, options); return completion;
    } },
    "@/middleware/middleware": { validateFields }, "@/lib/responseFormat": { success, error },
  };
  const localRequire = createRequire(path.resolve("package.json")), mod = { exports: {} as any };
  const code = transform(readFileSync("src/routes/script/extractAssets.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => imports[id] ?? localRequire(id), mod, mod.exports);
  const handler = mod.exports.default.stack.find((layer: any) => layer.route)?.route.stack.at(-1).handle;
  assert.equal(typeof handler, "function", "execute the actual production route, not a mirrored context builder");
  let status = 200, response: any;
  const res = { status(code: number) { status = code; return this; }, send(value: unknown) { response = value; return this; } };
  await handler({ body: { projectId: 1, scriptIds: [701], groupSize: 5, updateExistingDescriptions: true } }, res);
  assert.equal(status, 200); assert.equal(response.code, 200); assert.ok(completion);
  return { db, calls, completion: completion! };
}

test("stage templates keep the default in discovery and preserve custom instructions verbatim in both phases", () => {
  assert.deepEqual(skill.buildAssetExtractionTemplateContext({ data: defaultTemplate, useData: null }),
    { discoverySystem: defaultTemplate, designSystem: "" });
  const custom = "  用户自定义：保留虚构时代的蓝白衣装。\r\n不要改写本段空白与字段说明。  ";
  assert.deepEqual(skill.buildAssetExtractionTemplateContext({ data: defaultTemplate, useData: custom }),
    { discoverySystem: custom, designSystem: custom });
  assert.deepEqual(skill.buildAssetExtractionTemplateContext({ data: defaultTemplate, useData: "" }),
    { discoverySystem: defaultTemplate, designSystem: "" });
  assert.deepEqual(skill.buildAssetExtractionTemplateContext(), { discoverySystem: "", designSystem: "" });
});

test("the real default production route fits full eight-peer designs, legacy design and original evidence within the final budget", async t => {
  const f = await fixture(t); await f.completion;
  assert.equal(f.calls.length, 2, "the short original retains discovery plus one final design");
  const [discovery, final] = f.calls;
  assert.ok(discovery.request.system.startsWith(defaultTemplate));
  assert.ok(!final.request.system.includes(defaultTemplate), "do not load the discovery template again in the final design");
  assert.equal(final.input.siblingDesigns.length, 8);
  for (const peer of final.input.siblingDesigns) {
    assert.equal(peer.face, visual.face); assert.equal(peer.hair, visual.hair); assert.equal(peer.clothing, visual.clothing);
  }
  assert.deepEqual(final.input.previousDesign, priorDesign);
  assert.equal(final.input.legacyDescription, "女性，黑色长发，白色翻领衬衫配灰色长裤与黑色平底鞋，面部比例协调。");
  assert.equal(final.input.userConstraints, userGoal);
  assert.deepEqual(final.input.scripts[0].excerpts, [{ sourceRef: "701:1", quote: originalQuote }]);
  assert.equal(final.schema.properties.scriptFacts.items.properties.sourceRef.pattern, "^[0-9]+:[0-9]+$");
  assert.ok(final.estimated <= ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, `production final context estimated ${final.estimated}`);
  const previousStack = estimateAssetExtractionRequestTokens(defaultTemplate + "\n\n" + final.request.system, final.input, final.schema);
  assert.ok(previousStack > ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, "the same full fixture must expose the old duplicated-template budget failure");
  for (const rule of [/sourceRef/, /程序会按编号填回原句/, /年龄未知不默认成年/, /不能放进 scriptFacts/, /真实未解冲突/, /siblingDesigns/, /完整.*时髦衣装/])
    assert.match(final.request.system, rule, "removing the default discovery template must retain the final source, age, conflict and design contract");
  const saved = await f.db("o_assets").where({ id: 10 }).first();
  assert.deepEqual(JSON.parse(saved.descriptionMeta).scriptFacts, [{ sourceRef: "701:1", scriptId: 701, quote: originalQuote, fact: "黑色长发" }]);
  assert.equal(saved.imageId, 40); assert.equal(saved.prompt, "保留既有图提示词");
});

test("the production route retains complete user customization in discovery and final design", async t => {
  const custom = "  CUSTOM_USER_RULE：人物沿用本项目虚构时代衣装，妆发美型但不推断年龄。\r\nCUSTOM_SECOND_LINE：保持既定白衬衫类别，改良剪裁与搭配。  ";
  const f = await fixture(t, custom); await f.completion;
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.ok(call.request.system.startsWith(custom), "user custom text and its original whitespace survive both phases");
    assert.ok(!call.request.system.includes(defaultTemplate));
    assert.ok(call.estimated <= ASSET_EXTRACTION_INPUT_TOKEN_BUDGET);
  }
});

test("eight simultaneously maximum-length peer summaries still fail safely rather than dropping original evidence", async t => {
  const f = await fixture(t, null, true);
  await assert.rejects(f.completion, /资产最终设计输入超过安全上下文预算/);
  assert.ok(f.calls.every(call => !call.input.previousDesign), "no oversized final request reaches the model");
  const saved = await f.db("o_assets").where({ id: 10 }).first();
  assert.equal(saved.describe, "女性，黑色长发，白色翻领衬衫配灰色长裤与黑色平底鞋，面部比例协调。");
  assert.equal(saved.imageId, 40); assert.equal(saved.prompt, "保留既有图提示词");
  assert.equal((await f.db("o_assetDescriptionHistory")).length, 0);
  assert.deepEqual(await f.db("o_scriptAssets"), [{ scriptId: 701, assetId: 10 }]);
});
