/**
 * Verify the effective text-provider pipeline against a read-only production snapshot.
 * All migrations and extraction writes take place in :memory:. No image/video calls are made.
 * Run: npx tsx scripts/verify-character-card-pipeline.ts --project-id 1791442875668 --asset-id 352
 */
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import knex from "knex";
import { VM } from "vm2";
import { transform } from "sucrase";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { extractScriptAssets } from "../src/utils/scriptAssetExtraction";
import { migrateAssetDescriptions } from "../src/utils/assetDescriptionVersion";
import { migrateCharacterCards, getCharacterCard } from "../src/utils/characterCards";
import { getAssetExtractionVisualDesignSkill, getCharacterCardGenerationSkill, buildAssetExtractionTemplateContext } from "../src/utils/assetVisualDesignSkill";
import { buildAssetExtractionArtContext } from "../src/utils/assetPrompt";
import { withContentConstraints } from "../src/utils/contentConstraints";
import { estimateAssetExtractionRequestTokens, resolveAssetExtractionBudgetPolicy } from "../src/utils/assetExtractionContext";
const Database = createRequire(path.resolve("package.json"))("better-sqlite3");

type RequestRecord = {
  stage: string; estimated: number; budget: number; elapsedMs: number; provider: boolean; finishReason?: string;
  usage?: unknown; toolErrors?: string[]; sources?: number; excerpts?: number; facts?: number;
};

export async function verifyCharacterCardPipeline(options: { projectId: number; assetId: number; sourcePath?: string; reportPath?: string }) {
  const sourcePath = path.resolve(options.sourcePath || "data/db2.sqlite");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  const report: any = { sourcePath, projectId: options.projectId, assetId: options.assetId, productionReadOnly: true,
    extractionDatabase: ":memory:", imageCalls: 0, requests: [] as RequestRecord[], startedAt: new Date().toISOString(), success: false };
  const secrets: string[] = [];
  const safeError = (cause: any) => {
    let text = String(cause?.message || cause || "未知错误");
    if (/\b(?:insert into|update|select|delete from)\b/i.test(text) && text.includes(" - ")) text = text.slice(text.lastIndexOf(" - ") + 3);
    for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
    return text.slice(0, 1200);
  };
  try {
    const project: any = source.prepare("SELECT * FROM o_project WHERE id=?").get(options.projectId);
    const asset: any = source.prepare("SELECT * FROM o_assets WHERE id=? AND projectId=? AND type='role'").get(options.assetId, options.projectId);
    assert.ok(project && asset, "项目或人物不存在");
    const scripts: any[] = source.prepare("SELECT s.* FROM o_script s JOIN o_scriptAssets a ON a.scriptId=s.id WHERE a.assetId=? AND s.projectId=? ORDER BY s.id").all(asset.id, project.id);
    assert.ok(scripts.length > 0, "人物没有关联剧本");
    const peers: any[] = source.prepare("SELECT * FROM o_assets WHERE projectId=? AND type='role' AND assetsId IS NULL AND id<>? ORDER BY id LIMIT 8").all(project.id, asset.id);
    const assetBefore = JSON.stringify(asset);
    const scriptContentsBefore = new Map(scripts.map(script => [script.id, script.content]));
    for (const table of ["o_project", "o_script", "o_assets", "o_scriptAssets"]) {
      const definition: any = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      assert.ok(definition?.sql, `缺少表 ${table}`);
      await db.raw(definition.sql);
    }
    // Preserve reference IDs without loading or generating any image files.
    await db.schema.createTable("o_image", table => { table.integer("id").primary(); });
    for (const imageId of new Set([asset, ...peers].map(row => row.imageId).filter((id: any) => id != null))) await db("o_image").insert({ id: imageId });
    await db("o_project").insert(project);
    for (const script of scripts) await db("o_script").insert(script);
    await db("o_assets").insert(asset);
    for (const peer of peers) await db("o_assets").insert(peer);
    await db("o_scriptAssets").insert(scripts.map(script => ({ scriptId: script.id, assetId: asset.id })));
    await migrateAssetDescriptions(db);
    await migrateCharacterCards(db);
    const initialCardCount = (await db("o_characterCard")).length;

    const deployment: any = source.prepare("SELECT * FROM o_agentDeploy WHERE key='universalAi'").get();
    assert.ok(deployment?.modelName, "缺少 universalAi 配置");
    const [vendorId, modelName] = deployment.modelName.split(/:(.+)/);
    assert.equal(vendorId, "volcengine", "此验证脚本仅执行当前授权的豆包文本供应商");
    const vendorConfig: any = source.prepare("SELECT * FROM o_vendorConfig WHERE id=?").get(vendorId);
    assert.ok(vendorConfig, "缺少供应商配置");
    const inputValues = JSON.parse(vendorConfig.inputValues || "{}");
    for (const [key, value] of Object.entries(inputValues)) if (/key|secret|token|password/i.test(key) && typeof value === "string") secrets.push(value);
    const code = fs.readFileSync(path.resolve("data/vendor", `${vendorId}.ts`), "utf8");
    const jsCode = transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
    const vendorExports: Record<string, any> = {};
    const sandbox = new VM({ timeout: 1000, sandbox: { exports: vendorExports, createOpenAICompatible, fetch,
      logger: () => {}, Buffer }, eval: false, wasm: false });
    sandbox.run(jsCode);
    Object.assign(vendorExports.vendor.inputValues, inputValues);
    const modelList = new Map<string, any>();
    for (const model of [...vendorExports.vendor.models, ...JSON.parse(vendorConfig.models || "[]")]) modelList.set(model.modelName, model);
    const selected = modelList.get(modelName);
    assert.ok(selected?.type === "text", "当前通用模型不是有效文本模型");
    const model = vendorExports.textRequest(selected, !!selected.think, 0);
    const budget = resolveAssetExtractionBudgetPolicy({ ...selected, maxOutputTokens: deployment.maxOutputTokens || selected.maxOutputTokens || undefined });
    report.model = deployment.modelName;
    report.scriptCount = scripts.length;
    report.sourceCharacters = scripts.reduce((count, script) => count + String(script.content || "").length, 0);
    report.peerCount = peers.length;
    report.imageIdBefore = asset.imageId;
    report.budget = budget;

    const template: any = source.prepare("SELECT * FROM o_prompt WHERE type='scriptAssetExtraction'").get();
    const templateContext = buildAssetExtractionTemplateContext(template);
    const styleFile = path.resolve("data/skills/art_skills", project.artStyle || "", "prefix.md");
    const artContext = fs.existsSync(styleFile) ? buildAssetExtractionArtContext(fs.readFileSync(styleFile, "utf8")) : "";
    const roleSystem = templateContext.designSystem + "\n\n" + getAssetExtractionVisualDesignSkill() + "\n\n" + getCharacterCardGenerationSkill()
      + "\n项目画风标识：" + project.artStyle + "\n" + artContext + "\n当前 resultTool 的字段结构优先于旧模板。";
    console.log(JSON.stringify({ event: "start", model: report.model, scriptCount: report.scriptCount,
      sourceCharacters: report.sourceCharacters, peerCount: report.peerCount, budget, memoryOnly: true }));
    const invoke = async (request: any) => {
      const input = JSON.parse(request.messages[0].content), schema = await request.tools.resultTool.inputSchema.jsonSchema;
      const stage = schema.properties.newAssets ? "discovery" : schema.properties.decisions ? "factReview" : schema.properties.mode ? "match" : schema.properties.describe ? "card" : "facts";
      const record: RequestRecord = { stage, estimated: estimateAssetExtractionRequestTokens(request.system, input, schema),
        budget: budget.inputTokenBudget, elapsedMs: 0, provider: stage !== "discovery", sources: input.scripts?.length,
        excerpts: input.scripts?.reduce((count: number, script: any) => count + (script.excerpts?.length || 0), 0), facts: input.verifiedFacts?.length };
      report.requests.push(record);
      assert.ok(record.estimated <= record.budget, `${stage}请求超过预算`);
      console.log(JSON.stringify({ event: "request", ...record }));
      const start = performance.now();
      if (stage === "discovery") {
        // Focus on the selected character; facts, scope review, matching and design use the real provider.
        await request.tools.resultTool.execute({ newAssets: [], existingAssetRefs: [{ assetId: asset.id,
          scriptIds: [...new Set(input.scripts.map((script: any) => script.id))] }] }, {});
        record.elapsedMs = Math.round(performance.now() - start);
        record.finishReason = "fixed-discovery";
        return { finishReason: "tool-calls" };
      }
      const result = await generateText({ ...request, system: withContentConstraints(request.system), model,
        temperature: request.temperature ?? deployment.temperature ?? undefined,
        abortSignal: AbortSignal.timeout(180000), maxRetries: 0 } as Parameters<typeof generateText>[0]);
      record.elapsedMs = Math.round(performance.now() - start);
      record.finishReason = result.finishReason;
      record.usage = result.usage;
      record.toolErrors = result.content.filter((part: any) => part.type === "tool-error").map((part: any) => safeError(part.error));
      console.log(JSON.stringify({ event: "provider-result", ...record }));
      return result;
    };
    report.result = await extractScriptAssets({ db, invoke, system: roleSystem, roleSystem,
      discoverySystem: templateContext.discoverySystem, budget, characterCards: { artStyle: project.artStyle, ownerId: project.userId } },
    { projectId: project.id, scriptIds: scripts.map(script => script.id), updateExistingDescriptions: true, groupSize: 5 });
    const saved = await db("o_assets").where({ id: asset.id }).first();
    const meta = JSON.parse(saved.descriptionMeta || "{}");
    const card = await getCharacterCard(db, meta.characterCard.cardId, project.userId, meta.characterCard.version);
    assert.ok(card, "生成的角色卡没有持久化到内存数据库");
    assert.equal(saved.imageId, asset.imageId, "已有选图不能被替换");
    assert.equal(saved.prompt, asset.prompt, "已有绘图提示词不能被替换");
    assert.equal(JSON.stringify(source.prepare("SELECT * FROM o_assets WHERE id=?").get(asset.id)), assetBefore, "生产人物发生变化");
    for (const script of scripts) assert.equal((source.prepare("SELECT content FROM o_script WHERE id=?").get(script.id) as any)?.content, scriptContentsBefore.get(script.id));
    report.success = true;
    report.imageIdAfter = saved.imageId;
    report.productionAssetUnchanged = true;
    report.productionScriptsUnchanged = true;
    report.cardCountBefore = initialCardCount;
    report.cardCountAfter = (await db("o_characterCard")).length;
    report.cardBinding = meta.characterCard;
    report.savedFactCount = meta.scriptFacts?.length || 0;
    report.savedFacts = meta.scriptFacts || [];
    report.card = card;
    report.description = saved.describe;
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify({ event: "complete", success: true, providerCalls: report.requests.filter((request: RequestRecord) => request.provider).length,
      imageIdBefore: report.imageIdBefore, imageIdAfter: report.imageIdAfter, savedFactCount: report.savedFactCount, cardBinding: report.cardBinding }));
    return report;
  } catch (cause) {
    report.error = safeError(cause);
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify({ event: "failure", error: report.error }));
    return report;
  } finally {
    if (options.reportPath) {
      const file = path.resolve(options.reportPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
    }
    source.close();
    await db.destroy();
  }
}

if (require.main === module) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  void verifyCharacterCardPipeline({ projectId: Number(args.get("--project-id") || 1791442875668), assetId: Number(args.get("--asset-id") || 352),
    sourcePath: args.get("--source-db"), reportPath: args.get("--report") || "docs/character-card-pipeline-verification-2026-10-09.json" })
    .then(report => { if (!report.success) process.exitCode = 1; });
}
