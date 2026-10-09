import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { ASSET_EXTRACTION_INPUT_TOKEN_BUDGET, compactSourceRefSchema, estimateAssetExtractionRequestTokens,
  splitAssetExtractionCatalog, splitAssetExtractionText } from "../src/utils/assetExtractionContext";

type Script = { id: number; name: string; content: string };

async function fixture(t: TestContext, scripts: Script[], roleNames = ["艾娃"]) {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable("o_assets", table => {
    table.increments("id"); table.integer("projectId"); table.integer("assetsId"); table.integer("imageId"); table.bigInteger("startTime");
    for (const field of ["name", "type", "describe", "prompt", "promptState", "promptErrorReason"]) table.text(field);
  });
  await db.schema.createTable("o_script", table => {
    table.integer("id"); table.integer("projectId"); table.text("name"); table.text("content");
    table.integer("extractState"); table.text("errorReason");
  });
  await db.schema.createTable("o_scriptAssets", table => { table.integer("scriptId"); table.integer("assetId"); });
  await db.schema.createTable("o_image", table => { table.integer("id"); table.integer("assetsId"); table.text("filePath"); });
  await migrateAssetDescriptions(db);
  for (let index = 0; index < roleNames.length; index++) {
    await db("o_assets").insert({ id: 10 + index, projectId: 1, name: roleNames[index], type: "role", describe: `已选${roleNames[index]}造型`, prompt: "已完成提示词", imageId: 40 + index });
    await db("o_image").insert({ id: 40 + index, assetsId: 10 + index, filePath: `paid-selected-${index}.png` });
  }
  await db("o_script").insert(scripts.map(script => ({ ...script, projectId: 1, extractState: 1, errorReason: null })));
  await db("o_scriptAssets").insert(scripts.flatMap(script => roleNames.map((_name, index) => ({ scriptId: script.id, assetId: 10 + index }))));
  const mutations: string[] = [];
  db.on("query", query => {
    if (/^\s*(?:insert\s+into|update|delete\s+from)\s+["`]?(?:o_assets|o_assetDescriptionHistory|o_image|o_scriptAssets|o_script)\b/i.test(query.sql)) mutations.push(query.sql);
  });
  const snapshot = async () => ({
    assets: await db("o_assets").orderBy("id"), images: await db("o_image").orderBy("id"),
    histories: await db("o_assetDescriptionHistory").orderBy("id"), links: await db("o_scriptAssets").orderBy(["scriptId", "assetId"]),
    scripts: await db("o_script").orderBy("id"),
  });
  return { db, mutations, snapshot };
}

function episodes(count = 20, lines = 120): Script[] {
  return Array.from({ length: count }, (_value, episode) => ({
    id: 701 + episode, name: `第${episode + 1}集`,
    content: Array.from({ length: lines }, (_line, index) => {
      if (index === 0) return `艾娃第${episode + 1}集稳定识别点：发梢编号${episode + 1}。`;
      if (index === lines - 1) return `艾娃第${episode + 1}集末尾依据：袖口编号${episode + 1}，原文“保留  双空格”。`;
      return `场景${episode + 1}-${index}：艾娃沿着长廊走过，灯光照亮固定墙面，远处传来海浪声音；这是该集第${index}段连续正文。`;
    }).join("\r\n"),
  }));
}

async function submit(request: any, value: any) {
  try {
    await request.tools.resultTool.execute(value, {});
    return { finishReason: "tool-calls" };
  } catch (error) {
    return { finishReason: "tool-calls", content: [{ type: "tool-error", error }] };
  }
}

const visualDesign = { face: "保留既有脸部识别点", body: "自然成年比例", hair: "分层黑发", clothing: "深色皮夹克", environment: "", shape: "" };
const design = (scriptFacts: any[]) => ({ describe: "成年女性，黑发，深色皮夹克，袖口标记完整。", scriptFacts, visualDesign, conflicts: [] });

async function requestData(request: any) {
  assert.deepEqual(request.toolChoice, { type: "tool", toolName: "resultTool" });
  assert.equal(typeof request.stopWhen, "function");
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
  const schema = await request.tools.resultTool.inputSchema.jsonSchema;
  return { input: JSON.parse(request.messages[0].content), schema };
}

function sourceLines(scripts: Script[]): Map<string, string> {
  return new Map<string, string>(scripts.flatMap(script => script.content.split("\r\n").map((quote, index) => [`${script.id}:${index + 1}`, quote] as const)));
}

function excerpts(input: any): { sourceRef: string; quote: string; scriptId: number }[] {
  return (input.scripts || []).flatMap((script: any) => (script.excerpts || []).map((excerpt: any) => ({ ...excerpt, scriptId: script.id })));
}

function relevantFacts(input: any) {
  return excerpts(input).filter(excerpt => /稳定识别点|末尾依据/.test(excerpt.quote)).map(excerpt => ({
    sourceRef: excerpt.sourceRef, fact: excerpt.quote.includes("末尾依据") ? "袖口的稳定识别点" : "发梢的稳定识别点",
    quote: "模型不能改写服务端原句", scriptId: -999,
  }));
}

function assertOriginalFacts(facts: any[], scripts: Script[]) {
  const originals = sourceLines(scripts);
  for (const fact of facts) {
    assert.equal(fact.quote, originals.get(fact.sourceRef), `changed original quote at ${fact.sourceRef}`);
    assert.equal(fact.scriptId, Number(fact.sourceRef.split(":")[0]));
    assert.notEqual(fact.quote, "模型不能改写服务端原句");
  }
}

function assertBudget(system: string, input: any, schema: any) {
  assert.ok(estimateAssetExtractionRequestTokens(system, input, schema) <= ASSET_EXTRACTION_INPUT_TOKEN_BUDGET,
    "the actual system + JSON input + tool schema must fit the input budget");
  assert.ok(JSON.stringify({ system, input, schema }).length < 60_000, "an actual request must not contain the old huge source catalog");
}

function assertCompactSourceRefs(schema: any) {
  const serialized = JSON.stringify(schema);
  assert.ok(serialized.length < 5_000, "source enums must not grow with every source excerpt");
  assert.ok(!/"enum":\["\d+:\d+"/.test(serialized), "wire schema must avoid copying the catalog's reference list");
  assert.match(serialized, /pattern/, "compact source refs still declare a reference syntax");
}

test("twenty episodes preserve every source chunk and the final episode's facts in one final design", async t => {
  const scripts = episodes();
  const { db, mutations } = await fixture(t, scripts);
  const expected = sourceLines(scripts), seen = new Map<string, string>();
  const discovered = new Map<number, string>();
  let factCalls = 0, designs = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema);
    assert.deepEqual(mutations, [], "no assets or relations are written before every design succeeds");
    if (schema.properties.newAssets) {
      assert.match(request.system, /DISCOVERY_INPUT_ONLY/);
      assert.doesNotMatch(request.system, /DESIGN_MANUAL_SENTINEL/);
      for (const script of input.scripts) discovered.set(script.id, (discovered.get(script.id) || "") + script.content);
      return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    }
    assertCompactSourceRefs(schema);
    if (!schema.properties.describe) {
      factCalls++;
      assert.doesNotMatch(request.system, /DESIGN_MANUAL_SENTINEL|DISCOVERY_INPUT_ONLY/, "fact collection must not inherit design or discovery completion instructions");
      assert.match(request.system, /只负责[^。]*稳定视觉事实/);
      assert.match(request.system, /年龄未知[^。]*不默认成年/);
      assert.match(request.system, /开车[^。]*银行[^。]*不证明[^。]*成年/);
      assert.match(request.system, /族裔[^。]*肤色[^。]*不能按姓名/);
      for (const excerpt of excerpts(input)) {
        assert.equal(excerpt.quote, expected.get(excerpt.sourceRef));
        assert.ok(!seen.has(excerpt.sourceRef), `unexpected repeated source chunk ${excerpt.sourceRef}`);
        seen.set(excerpt.sourceRef, excerpt.quote);
      }
      return submit(request, { scriptFacts: relevantFacts(input) });
    }
    designs++;
    assert.equal(seen.size, expected.size, "design starts only after all source spans have been reviewed");
    assert.deepEqual(new Map([...seen].sort()), new Map([...expected].sort()));
    assert.equal(input.evidenceFacts.length, scripts.length * 2);
    assert.ok(input.evidenceFacts.some((fact: any) => fact.sourceRef === "720:120"), "the last episode's last fact cannot disappear");
    assert.equal(excerpts(input).length, input.evidenceFacts.length, "final design receives selected immutable evidence, not all background paragraphs");
    assertOriginalFacts(excerpts(input), scripts);
    // A final writer may select a subset in its own output. It must not discard
    // the previously reviewed, server-grounded facts from persisted evidence.
    return submit(request, design(input.evidenceFacts.slice(0, 1)));
  };
  const result = await extractScriptAssets({ db, invoke, system: "DESIGN_MANUAL_SENTINEL：为资产设计默认服装。", discoverySystem: "DISCOVERY_INPUT_ONLY" },
    { projectId: 1, scriptIds: scripts.map(script => script.id), groupSize: 5, updateExistingDescriptions: true });
  assert.ok(factCalls > 1, "the long source must be split rather than passed to a single design");
  assert.equal(designs, 1);
  assert.equal(result.updated, 1);
  for (const script of scripts) assert.equal(discovered.get(script.id), script.content, `discovery truncated episode ${script.id}`);
  const asset = await db("o_assets").where({ id: 10 }).first();
  const facts = JSON.parse(asset.descriptionMeta).scriptFacts;
  assert.equal(facts.length, scripts.length * 2);
  assertOriginalFacts(facts, scripts);
  assert.ok(facts.some((fact: any) => fact.sourceRef === "720:120" && fact.quote.includes("原文“保留  双空格”")));
  assert.equal(asset.imageId, 40); assert.equal(asset.prompt, "已完成提示词");
  assert.equal((await db("o_assetDescriptionHistory")).length, 1);
});

test("one very long episode splits discovery and evidence without renumbering or truncating its ending", async t => {
  const scripts = episodes(1, 1_600);
  const { db, mutations } = await fixture(t, scripts);
  const expected = sourceLines(scripts), seen = new Map<string, string>();
  let discovered = "", discoveryCalls = 0, factCalls = 0, designs = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) {
      discoveryCalls++;
      assert.ok(input.scripts.every((script: any) => script.id === 701));
      discovered += input.scripts.map((script: any) => script.content).join("");
      return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [701] }] });
    }
    assertCompactSourceRefs(schema);
    if (!schema.properties.describe) {
      factCalls++;
      for (const excerpt of excerpts(input)) { assert.ok(!seen.has(excerpt.sourceRef)); seen.set(excerpt.sourceRef, excerpt.quote); }
      return submit(request, { scriptFacts: relevantFacts(input) });
    }
    designs++;
    assert.deepEqual(new Map([...seen].sort()), new Map([...expected].sort()));
    assert.deepEqual(input.evidenceFacts.map((fact: any) => fact.sourceRef).sort(), ["701:1", "701:1600"].sort());
    return submit(request, design(input.evidenceFacts));
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: [701], updateExistingDescriptions: true });
  assert.ok(discoveryCalls > 1); assert.ok(factCalls > 1); assert.equal(designs, 1);
  assert.equal(discovered, scripts[0].content);
  const facts = JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts;
  assertOriginalFacts(facts, scripts);
  assert.equal(facts.find((fact: any) => fact.sourceRef === "701:1600").quote, scripts[0].content.split("\r\n").at(-1));
});

test("an invalid compact source reference gets one bounded schema correction and exact server-owned quotes", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations } = await fixture(t, scripts);
  let invalid = false, corrected = false, failedInput = "", failedEstimate = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    if (!schema.properties.describe) {
      assertCompactSourceRefs(schema);
      if (!invalid) {
        invalid = true; failedInput = request.messages[0].content;
        failedEstimate = estimateAssetExtractionRequestTokens(request.system, input, schema);
        assert.ok(failedEstimate > ASSET_EXTRACTION_INPUT_TOKEN_BUDGET - 2_500,
          "the failing batch must exercise a nearly full input window, not a trivial short request");
        const result = await submit(request, { scriptFacts: [{ sourceRef: "999999:1", fact: "虚构来源" }] });
        assert.equal(result.content?.[0].type, "tool-error", "the compact wire pattern must not weaken runtime membership validation");
        return result;
      }
      if (!corrected) {
        corrected = true;
        assert.equal(request.messages[0].content, failedInput, "correction must retry the same source batch");
        assert.match(request.system, /上次结果未能保存/);
        assert.ok(estimateAssetExtractionRequestTokens(request.system, input, schema) > failedEstimate,
          "the retry must include schema feedback while staying within the original budget");
      }
      return submit(request, { scriptFacts: relevantFacts(input) });
    }
    return submit(request, design(input.evidenceFacts));
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true });
  assert.ok(invalid && corrected);
  const facts = JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts;
  assertOriginalFacts(facts, scripts); assert.ok(facts.every((fact: any) => fact.sourceRef !== "999999:1"));
});

test("two invalid source submissions fail without any asset, history, image or association writes", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations, snapshot } = await fixture(t, scripts);
  const before = await snapshot(); let factCalls = 0, designs = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    if (schema.properties.describe) { designs++; return submit(request, design([])); }
    factCalls++;
    return submit(request, { scriptFacts: [{ sourceRef: "999999:1", fact: "虚构来源" }] });
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" },
    { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true }), /艾娃.*(?:依据|sourceRef|来源|Invalid|无效|未返回有效)/);
  assert.equal(factCalls, 2); assert.equal(designs, 0);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

test("a long background source can yield empty facts without inventing evidence or skipping final design", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations } = await fixture(t, scripts);
  const expected = sourceLines(scripts), reviewed = new Map<string, string>();
  let designs = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    if (!schema.properties.describe) {
      for (const excerpt of excerpts(input)) {
        assert.ok(!reviewed.has(excerpt.sourceRef), "an empty facts result must not conceal duplicate source coverage");
        reviewed.set(excerpt.sourceRef, excerpt.quote);
      }
      return submit(request, { scriptFacts: [] });
    }
    designs++;
    assert.deepEqual(new Map([...reviewed].sort()), new Map([...expected].sort()));
    assert.deepEqual(input.evidenceFacts, []); assert.deepEqual(excerpts(input), []);
    return submit(request, design([]));
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true });
  assert.equal(designs, 1);
  assert.deepEqual(JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts, []);
});

test("a later role's final stop result rolls back all earlier successful designs", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations, snapshot } = await fixture(t, scripts, ["艾娃", "麦迪逊"]);
  const before = await snapshot(); let successfulDesigns = 0, failedDesigns = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [10, 11].map(assetId => ({ assetId, scriptIds: input.scripts.map((script: any) => script.id) })) });
    if (!schema.properties.describe) return submit(request, { scriptFacts: relevantFacts(input) });
    if (input.asset.name === "艾娃") { successfulDesigns++; return submit(request, design(input.evidenceFacts)); }
    failedDesigns++; return { finishReason: "stop", text: "这名角色已经分析完成。" };
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" },
    { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true }), /麦迪逊.*模型未提交结果工具.*stop/);
  assert.equal(successfulDesigns, 1); assert.equal(failedDesigns, 2);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

test("a long final writer cannot cite an original source ref absent from the selected evidence", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations } = await fixture(t, scripts);
  let finalCalls = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    if (!schema.properties.describe) return submit(request, { scriptFacts: relevantFacts(input) });
    finalCalls++;
    assert.ok(sourceLines(scripts).has("701:2"), "the forbidden ref exists in the complete server catalog");
    assert.ok(!excerpts(input).some(excerpt => excerpt.sourceRef === "701:2"), "the final writer was not shown this ref");
    if (finalCalls === 1) {
      const result = await submit(request, design([{ sourceRef: "701:2", fact: "未经收集而补进来的事实" }]));
      assert.equal(result.content?.[0].type, "tool-error", "final runtime membership must be selected refs rather than all original refs");
      return result;
    }
    assert.match(request.system, /上次结果未能保存/);
    return submit(request, design(input.evidenceFacts));
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true });
  assert.equal(finalCalls, 2);
  const facts = JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts;
  assert.ok(facts.every((fact: any) => fact.sourceRef !== "701:2")); assertOriginalFacts(facts, scripts);
});

test("empty collected evidence enforces maxItems zero instead of letting the final writer invent a citation", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations } = await fixture(t, scripts); let finalCalls = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    if (!schema.properties.describe) return submit(request, { scriptFacts: [] });
    finalCalls++;
    assert.deepEqual(input.evidenceFacts, []); assert.deepEqual(excerpts(input), []);
    assert.equal(schema.properties.scriptFacts.maxItems, 0);
    if (finalCalls === 1) {
      const result = await submit(request, design([{ sourceRef: "701:1", fact: "最终模型不能把未收集原句猜回来" }]));
      assert.equal(result.content?.[0].type, "tool-error"); return result;
    }
    assert.match(request.system, /上次结果未能保存/); return submit(request, design([]));
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true });
  assert.equal(finalCalls, 2);
  assert.deepEqual(JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts, []);
});

test("conflict correction retains the same selected-evidence boundary as the original final design", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations } = await fixture(t, scripts); let initialDesigns = 0, corrections = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    if (!schema.properties.describe) return submit(request, { scriptFacts: relevantFacts(input) });
    if (!input.previousResultForCorrection) {
      initialDesigns++;
      return submit(request, { ...design(input.evidenceFacts), conflicts: ["原文血色与当前表现规则不一致"] });
    }
    corrections++;
    assert.ok(!excerpts(input).some(excerpt => excerpt.sourceRef === "701:2"));
    if (corrections === 1) {
      const result = await submit(request, design([{ sourceRef: "701:2", fact: "冲突校正时也不得越界新增依据" }]));
      assert.equal(result.content?.[0].type, "tool-error", "conflict correction must not widen back to the full source catalog");
      return result;
    }
    assert.match(request.system, /上次结果未能保存/);
    return submit(request, design(input.evidenceFacts));
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true });
  assert.equal(initialDesigns, 1); assert.equal(corrections, 2);
  const facts = JSON.parse((await db("o_assets").where({ id: 10 }).first()).descriptionMeta).scriptFacts;
  assert.ok(facts.every((fact: any) => fact.sourceRef !== "701:2")); assertOriginalFacts(facts, scripts);
});

test("short requests retain the original single design contract without an extra facts stage", async t => {
  const scripts = [{ id: 701, name: "第一集", content: "艾娃黑发黑眼。" }];
  const { db, mutations } = await fixture(t, scripts); let calls = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request); calls++;
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [701] }] });
    assert.ok(schema.properties.describe, "short evidence must not be routed through a separate extraction stage");
    assert.match(request.system, /年龄未知[^。]*不默认成年/);
    assert.match(request.system, /开车[^。]*银行[^。]*不证明[^。]*成年/);
    assert.match(request.system, /不得按姓名[^。]*推断族裔[^。]*肤色/);
    assert.equal(input.evidenceFacts, undefined);
    assert.equal(input.scripts.length, 1); assert.equal(input.scripts[0].excerpts[0].quote, scripts[0].content);
    return submit(request, design([{ sourceRef: "701:1", fact: "黑发黑眼" }]));
  };
  await extractScriptAssets({ db, invoke, system: "rules" }, { projectId: 1, scriptIds: [701], updateExistingDescriptions: true });
  assert.equal(calls, 2);
});

test("a system prompt that cannot fit alone fails explicitly before provider invocation or writes", async t => {
  const scripts = [{ id: 701, name: "第一集", content: "艾娃出现。" }];
  const { db, mutations, snapshot } = await fixture(t, scripts);
  const before = await snapshot(); let calls = 0;
  await assert.rejects(extractScriptAssets({ db, invoke: async () => { calls++; throw new Error("must not call a provider with oversized instructions"); }, system: "长系统约束".repeat(40_000) },
    { projectId: 1, scriptIds: [701], updateExistingDescriptions: true }), /(?:上下文|预算|超出|超过|过长|too long|budget)/i);
  assert.equal(calls, 0); assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

test("oversized final evidence fails explicitly instead of dropping late facts or writing partial designs", async t => {
  const scripts = episodes(4, 200);
  const { db, mutations, snapshot } = await fixture(t, scripts);
  const before = await snapshot(); let factCalls = 0, finalCalls = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: input.scripts.map((script: any) => script.id) }] });
    if (!schema.properties.describe) {
      factCalls++;
      return submit(request, { scriptFacts: excerpts(input).map(excerpt => ({ sourceRef: excerpt.sourceRef, fact: "原文中明确的稳定识别依据。".repeat(30) })) });
    }
    finalCalls++; return submit(request, design(input.evidenceFacts));
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" },
    { projectId: 1, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true }), /(?:上下文|预算|超出|超过|过长|too long|budget)/i);
  assert.ok(factCalls > 1); assert.equal(finalCalls, 0);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

test("a single giant original source span is reviewed in full and cannot be saved as its last slice", async t => {
  const quote = "艾娃的稳定袖口标记出现在这一连续原句中" + "连贯原文字词".repeat(6_000) + "原文末尾识别点。";
  const scripts = [{ id: 701, name: "单条超长原文", content: quote }];
  const { db, mutations, snapshot } = await fixture(t, scripts);
  const before = await snapshot(), delivered: string[] = [];
  let discovered = "", factCalls = 0, finalCalls = 0;
  const invoke = async (request: any) => {
    const { input, schema } = await requestData(request);
    assertBudget(request.system, input, schema); assert.deepEqual(mutations, []);
    if (schema.properties.newAssets) {
      discovered += input.scripts.map((script: any) => script.content).join("");
      return submit(request, { newAssets: [], existingAssetRefs: [{ assetId: 10, scriptIds: [701] }] });
    }
    if (!schema.properties.describe) {
      factCalls++;
      for (const excerpt of excerpts(input)) { assert.equal(excerpt.sourceRef, "701:1"); delivered.push(excerpt.quote); }
      return submit(request, { scriptFacts: [{ sourceRef: "701:1", fact: "同一原句描述稳定的袖口标记" }] });
    }
    finalCalls++; return submit(request, design(input.evidenceFacts));
  };
  await assert.rejects(extractScriptAssets({ db, invoke, system: "rules" },
    { projectId: 1, scriptIds: [701], updateExistingDescriptions: true }), /(?:上下文|预算|超出|超过|过长|too long|budget)/i);
  assert.ok(factCalls > 1); assert.equal(finalCalls, 0, "the full original quote cannot fit; its last slice must not replace it");
  assert.equal(discovered, quote); assert.equal(delivered.join(""), quote);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(mutations, []);
});

test("contiguous source slicing preserves Unicode, punctuation and a long excerpt's original reference", () => {
  const quote = "  原文‘保留双空格’🦈\r\n".repeat(60) + "最后的原句！";
  const slices = splitAssetExtractionText(quote, part => Array.from(part).length <= 120);
  assert.ok(slices.length > 1); assert.equal(slices.join(""), quote);
  assert.ok(slices.every(slice => Array.from(slice).length <= 120));
  assert.ok(slices.every(slice => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(slice)), "never split a Unicode code point");
  const catalog = [{ id: 731, name: "长原文", excerpts: [{ sourceRef: "731:9", quote }] }];
  const batches = splitAssetExtractionCatalog(catalog, batch => excerpts({ scripts: batch }).reduce((size, excerpt) => size + Array.from(excerpt.quote).length, 0) <= 120);
  const delivered = batches.flatMap(batch => excerpts({ scripts: batch }));
  assert.ok(batches.length > 1); assert.ok(delivered.every(excerpt => excerpt.sourceRef === "731:9"));
  assert.equal(delivered.map(excerpt => excerpt.quote).join(""), quote);
  assert.equal(catalog[0].excerpts[0].quote, quote, "slicing must not mutate the server's full original quote");
});

test("compact wire schema preserves unrelated enums and never changes the runtime schema", () => {
  const schema = { type: "object", properties: {
    type: { type: "string", enum: ["role", "scene", "tool"] },
    scriptFacts: { type: "array", items: { type: "object", properties: { sourceRef: { type: "string", enum: ["731:1", "731:9"] }, fact: { type: "string", minLength: 1 } } } },
  } };
  const before = JSON.stringify(schema), compact = compactSourceRefSchema(schema);
  assert.equal(JSON.stringify(schema), before);
  assert.deepEqual(compact.properties.type.enum, ["role", "scene", "tool"]);
  assert.equal(compact.properties.scriptFacts.items.properties.sourceRef.enum, undefined);
  assert.match(compact.properties.scriptFacts.items.properties.sourceRef.pattern, /\[0-9\]/);
  assert.equal(compact.properties.scriptFacts.items.properties.fact.minLength, 1);
});
