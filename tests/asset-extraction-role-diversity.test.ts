import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, estimateAssetExtractionRequestTokens } from "../src/utils/assetExtractionContext";

const visual = (name: string) => ({ face: `${name}_FACE_NEW`, hair: `${name}_HAIR_NEW`, clothing: `${name}_CLOTHING_NEW`, body: "自然比例", environment: "", shape: "" });
const meta = (name: string, overrides: any = {}) => JSON.stringify({ visualDesign: { ...visual(name), ...overrides },
  scriptFacts: [{ sourceRef: "9901:1", quote: "其他角色的旧依据，不属于本资产的原文。", fact: "绝不能转成当前角色的事实" }] });

async function fixture(t: TestContext, content: string) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content"); table.integer("extractState"); table.text("errorReason");
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); table.primary(["scriptId", "assetId"]); });
  await db.schema.createTable("o_image", table => { table.integer("id"); table.integer("assetsId"); table.text("filePath"); });
  await migrateAssetDescriptions(db);
  await db("o_script").insert({ id: 701, projectId: 1, name: "本集", content, extractState: 0, errorReason: null });
  const snapshot = async () => ({ assets: await db("o_assets").orderBy("id"), images: await db("o_image").orderBy("id"),
    histories: await db("o_assetDescriptionHistory").orderBy("id"), links: await db("o_scriptAssets").orderBy(["scriptId", "assetId"]), scripts: await db("o_script").orderBy("id") });
  return { db, snapshot };
}

async function submit(request: any, value: any) {
  try { await request.tools.resultTool.execute(value, {}); return { finishReason: "tool-calls" }; }
  catch (error) { return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] }; }
}

async function requestData(request: any) {
  assert.deepEqual(request.toolChoice, { type: "tool", toolName: "resultTool" });
  const input = JSON.parse(request.messages[0].content), schema = await request.tools.resultTool.inputSchema.jsonSchema;
  assert.ok(estimateAssetExtractionRequestTokens(request.system, input, schema) <= ASSET_EXTRACTION_INPUT_TOKEN_BUDGET,
    "peer summaries must be included in the actual request budget");
  return { input, schema };
}

function evidence(input: any) {
  return input.scripts.flatMap((script: any) => (script.excerpts || []).filter((excerpt: any) => excerpt.quote.trim().startsWith(input.asset.name))
    .map((excerpt: any) => ({ sourceRef: excerpt.sourceRef, fact: excerpt.quote.trim(), quote: "模型伪造原句", scriptId: -1 })));
}

const design = (name: string, scriptFacts: any[]) => ({ describe: `${name}的独立稳定造型。`, scriptFacts, visualDesign: visual(name), conflicts: [] });

test("role peers use only same-project base metadata and completed designs, while late forged peer evidence rolls back everything", async t => {
  const quotes = ["  已有主角是女性，黑色齐肩发。", "艾娃是女性，黑色短发。", "麦迪逊是女性，棕色长发。"];
  for (const forgePeerEvidence of [false, true]) {
    const { db, snapshot } = await fixture(t, quotes.join("\r\n"));
    await db("o_assets").insert([
      { id: 10, projectId: 1, name: "已有主角", type: "role", describe: "旧描述", imageId: 40, prompt: "保留已付费图提示词", descriptionMeta: meta("OLD") },
      { id: 11, projectId: 1, name: "同项目基础参考", type: "role", describe: "不可替代视觉摘要", descriptionMeta: meta("DB", { body: "不应发送的身体字段" }) },
      { id: 12, projectId: 1, name: "基础参考觉醒", type: "role", assetsId: 11, descriptionMeta: meta("DERIVED") },
      { id: 13, projectId: 1, name: "场景伪装参考", type: "scene", descriptionMeta: meta("SCENE") },
      { id: 14, projectId: 1, name: "道具伪装参考", type: "tool", descriptionMeta: meta("TOOL") },
      { id: 15, projectId: 2, name: "跨项目参考", type: "role", descriptionMeta: meta("OTHER_PROJECT") },
      { id: 16, projectId: 1, name: "没有元数据", type: "role", describe: "DESCRIBE_IS_NOT_DESIGN" },
      { id: 17, projectId: 1, name: "无效元数据", type: "role", describe: "BROKEN_METADATA_IS_NOT_DESIGN", descriptionMeta: "{" },
    ]);
    await db("o_image").insert({ id: 40, assetsId: 10, filePath: "paid-selected.png" });
    await db("o_scriptAssets").insert({ scriptId: 701, assetId: 10 });
    const before = await snapshot(); let finals = 0, rejected = 0;
    const invoke = async (request: any) => {
      const { input, schema } = await requestData(request);
      assert.deepEqual(await snapshot(), before, "all role designs are prepared before any asset, history, image or link write");
      if (schema.properties.newAssets) return submit(request, { newAssets: ["已有主角", "艾娃", "麦迪逊"].map(name => ({ name, type: "role", desc: "仅发现摘要", scriptIds: [701] })), existingAssetRefs: [] });
      finals++;
      const peers = input.siblingDesigns;
      assert.ok(Array.isArray(peers));
      assert.ok(peers.every((peer: any) => Object.keys(peer).sort().join(",") === "clothing,face,hair,name"));
      assert.ok(peers.every((peer: any) => peer.name !== input.asset.name), "never use the role itself as a sibling reference");
      assert.ok(peers.some((peer: any) => peer.name === "同项目基础参考" && peer.face === "DB_FACE_NEW"));
      assert.ok(peers.every((peer: any) => ["同项目基础参考", "已有主角", "艾娃"].includes(peer.name)), "derived, scene/tool, other-project and absent metadata are excluded");
      for (const marker of ["9901:1", "其他角色的旧依据", "DESCRIBE_IS_NOT_DESIGN", "BROKEN_METADATA_IS_NOT_DESIGN", "不应发送的身体字段"])
        assert.ok(!JSON.stringify(peers).includes(marker), `peer summaries leaked non-design data: ${marker}`);
      if (input.asset.name !== "已有主角") {
        const updated = peers.find((peer: any) => peer.name === "已有主角");
        assert.equal(updated?.face, "已有主角_FACE_NEW", "the newly completed design replaces this identity's persisted OLD design");
        assert.ok(!JSON.stringify(peers).includes("OLD_FACE_NEW"));
      }
      if (input.asset.name === "麦迪逊") {
        assert.ok(peers.some((peer: any) => peer.name === "艾娃" && peer.face === "艾娃_FACE_NEW"), "the next fresh role receives the previous fresh role's completed design");
        if (forgePeerEvidence) {
          const result = await submit(request, design(input.asset.name, [{ sourceRef: "9901:1", fact: "从其他角色资料借来的事实" }]));
          assert.equal(result.content?.[0].type, "tool-error", "peer designs do not enlarge this role's sourceRef authority");
          rejected++; return result;
        }
      }
      return submit(request, design(input.asset.name, evidence(input)));
    };
    const run = extractScriptAssets({ db, invoke, system: "只依据角色自己的剧本证据设计。" }, { projectId: 1, scriptIds: [701], updateExistingDescriptions: true });
    if (forgePeerEvidence) {
      await assert.rejects(run, /麦迪逊.*(?:依据|sourceRef|未返回有效|Invalid)/);
      assert.equal(rejected, 2); assert.equal(finals, 4); assert.deepEqual(await snapshot(), before);
    } else {
      assert.deepEqual(await run, { created: 2, updated: 1, reused: 0 }); assert.equal(finals, 3);
      for (const [index, name] of ["已有主角", "艾娃", "麦迪逊"].entries()) {
        const asset = await db("o_assets").where({ projectId: 1, name }).first();
        assert.deepEqual(JSON.parse(asset.descriptionMeta).scriptFacts,
          [{ sourceRef: `701:${index + 1}`, scriptId: 701, quote: quotes[index], fact: quotes[index].trim() }]);
      }
      const current = await db("o_assets").where({ id: 10 }).first();
      assert.equal(current.imageId, 40); assert.equal(current.prompt, before.assets.find(row => row.id === 10)?.prompt);
      assert.deepEqual(await db("o_image"), before.images);
      assert.equal((await db("o_assetDescriptionHistory").where({ assetId: 10 }).first()).describe, "旧描述");
      for (const asset of before.assets.filter(row => row.id !== 10)) assert.deepEqual(await db("o_assets").where({ id: asset.id }).first(), asset);
    }
  }
});

test("bounded peer summaries fit the real final request without losing long-source evidence", async t => {
  const first = "艾娃是女性，黑色齐肩发。", last = "艾娃日常穿蓝色长袖上衣。";
  const lines = [first, ...Array.from({ length: 500 }, (_value, index) => `走廊第${index + 1}段原文：海风经过固定墙面，远处浪声持续，地面仍保持原状。`), last];
  const { db } = await fixture(t, lines.join("\r\n"));
  for (let index = 0; index < 14; index++) await db("o_assets").insert({ id: 10 + index, projectId: 1, name: `基础角色${index}`, type: "role",
    descriptionMeta: meta(`PEER_${index}`, { face: "脸".repeat(2_000), hair: "发".repeat(2_000), clothing: "衣".repeat(2_000) }) });
  const reviewed = new Map<string, string>(); let collections = 0, finals = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    if (schema.properties.newAssets) return submit(request, { newAssets: [{ name: "艾娃", type: "role", desc: "发现身份", scriptIds: [701] }], existingAssetRefs: [] });
    if (!schema.properties.describe) {
      collections++;
      for (const script of input.scripts) for (const excerpt of script.excerpts) reviewed.set(excerpt.sourceRef, excerpt.quote);
      return submit(request, { scriptFacts: evidence(input) });
    }
    finals++;
    assert.ok(collections > 1, "the original full catalog must go through bounded collection rather than being truncated");
    assert.equal(reviewed.size, lines.length);
    for (const [index, quote] of lines.entries()) assert.equal(reviewed.get(`701:${index + 1}`), quote);
    assert.equal(input.siblingDesigns.length, 8);
    for (const peer of input.siblingDesigns) {
      assert.equal(Object.keys(peer).sort().join(","), "clothing,face,hair,name");
      assert.equal(peer.face.length, 120); assert.equal(peer.hair.length, 100); assert.equal(peer.clothing.length, 180);
    }
    assert.deepEqual(input.evidenceFacts.map((fact: any) => fact.sourceRef), ["701:1", `701:${lines.length}`]);
    return submit(request, design(input.asset.name, evidence(input)));
  };
  await extractScriptAssets({ db, invoke, system: "同项目角色参考只作外观差异化，不当作原文身份依据。" }, { projectId: 1, scriptIds: [701] });
  assert.equal(finals, 1);
  const asset = await db("o_assets").where({ name: "艾娃" }).first();
  assert.deepEqual(JSON.parse(asset.descriptionMeta).scriptFacts.map((fact: any) => fact.quote), [first, last]);
});

test("scene and tool design inputs never receive role sibling summaries", async t => {
  const { db } = await fixture(t, "仓库是固定矩形空间。\r\n救生艇是灰色硬壳艇。");
  await db("o_assets").insert({ id: 10, projectId: 1, name: "同项目基础角色", type: "role", descriptionMeta: meta("ROLE") });
  const before = await db("o_assets").where({ id: 10 }).first(); let finals = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    if (schema.properties.newAssets) return submit(request, { newAssets: [{ name: "仓库", type: "scene", desc: "固定空间", scriptIds: [701] },
      { name: "救生艇", type: "tool", desc: "实体载具", scriptIds: [701] }], existingAssetRefs: [] });
    finals++;
    assert.equal(Object.hasOwn(input, "siblingDesigns"), false);
    return submit(request, { ...design(input.asset.name, evidence(input)), visualDesign: { face: "", body: "", hair: "", clothing: "", environment: "固定空间", shape: "原文明示结构" } });
  };
  assert.deepEqual(await extractScriptAssets({ db, invoke, system: "只设计实体的固定外观。" }, { projectId: 1, scriptIds: [701] }), { created: 2, updated: 0, reused: 0 });
  assert.equal(finals, 2); assert.deepEqual(await db("o_assets").where({ id: 10 }).first(), before);
});
