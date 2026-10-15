/**
 * Recheck an existing paid candidate; this script never requests a new image.
 * Run explicitly: npx tsx scripts/review-character-card-candidate.ts --attempt-id 4
 * Only the new review attempt and an accepted card version are written. No migration/recovery runs.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import knex, { type Knex } from "knex";
import { VM } from "vm2";
import { transform } from "sucrase";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { reviewCharacterCardCandidate, sanitizedReviewError } from "../src/utils/characterCardCandidateReview";
export { reviewCharacterCardCandidate, sanitizedReviewError, type CandidateReviewReport } from "../src/utils/characterCardCandidateReview";
import { buildCharacterCardImagePromptContext } from "../src/utils/characterCardImagePromptContext";
import { reviewAssetImage } from "../src/utils/assetPromptGeneration";
import { withContentConstraints } from "../src/utils/contentConstraints";

/** Resolve only a local OSS file and reject directory or symlink escapes. */
export function resolveCandidateFile(ossRoot: string, filePath: string): string {
  const root = fs.realpathSync(path.resolve(ossRoot));
  const file = path.resolve(root, filePath.replace(/^[\\/]+/, ""));
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("候选图片路径超出 OSS 目录");
  const actual = fs.realpathSync(file);
  const actualRelative = path.relative(root, actual);
  if (actualRelative.startsWith("..") || path.isAbsolute(actualRelative) || !fs.statSync(actual).isFile()) throw new Error("候选图片文件不合法");
  return actual;
}

export async function runCharacterCardCandidateReview(options: {
  attemptId: number; ownerId?: number; sourcePath?: string; ossRoot?: string;
}) {
  const Database = createRequire(path.resolve("package.json"))("better-sqlite3");
  const sourcePath = path.resolve(options.sourcePath || "data/db2.sqlite");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let db: Knex | undefined;
  const secrets: string[] = [];
  const safeError = (cause: unknown) => sanitizedReviewError(cause, secrets);
  try {
    // Read configuration separately, without importing app startup, u, db or ai wrappers.
    const deployment: any = source.prepare("SELECT * FROM o_agentDeploy WHERE key='universalAi'").get();
    if (!deployment?.modelName) throw new Error("缺少 universalAi 配置");
    const [vendorId, modelName] = deployment.modelName.split(/:(.+)/);
    if (vendorId !== "volcengine") throw new Error("此复核脚本仅执行当前授权的豆包文本供应商");
    const vendorConfig: any = source.prepare("SELECT * FROM o_vendorConfig WHERE id=?").get(vendorId);
    if (!vendorConfig) throw new Error("缺少供应商配置");
    const inputValues = JSON.parse(vendorConfig.inputValues || "{}");
    for (const [key, value] of Object.entries(inputValues)) if (/key|secret|token|password/i.test(key) && typeof value === "string") secrets.push(value);
    const code = fs.readFileSync(path.resolve("data/vendor", `${vendorId}.ts`), "utf8");
    const jsCode = transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
    const vendorExports: Record<string, any> = {};
    new VM({ timeout: 1000, sandbox: { exports: vendorExports, createOpenAICompatible, fetch, logger: () => {}, Buffer }, eval: false, wasm: false }).run(jsCode);
    Object.assign(vendorExports.vendor.inputValues, inputValues);
    const models = new Map<string, any>();
    for (const model of [...vendorExports.vendor.models, ...JSON.parse(vendorConfig.models || "[]")]) models.set(model.modelName, model);
    const selected = models.get(modelName);
    if (selected?.type !== "text") throw new Error("当前通用模型不是有效文本模型");
    const model = vendorExports.textRequest(selected, !!selected.think, 0);
    const ossRoot = path.resolve(options.ossRoot || "data/oss");
    db = knex({ client: "better-sqlite3", connection: { filename: sourcePath }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
    let providerCalls = 0;
    const report = await reviewCharacterCardCandidate({ db, safeError,
      review: async (card, candidate) => {
        console.log(JSON.stringify({ event: "review-start", sourceAttemptId: candidate.id, cardId: card.id, baseVersion: card.version,
          reviewModel: deployment.modelName, imageModel: candidate.model, resolution: candidate.resolution, imageCalls: 0 }));
        await reviewAssetImage({
          loadImage: async filePath => {
            const file = resolveCandidateFile(ossRoot, filePath);
            const mime = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" } as Record<string, string>)[path.extname(file).toLowerCase()];
            if (!mime) throw new Error("候选图片格式不受支持");
            return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
          },
          invoke: async request => {
            providerCalls += 1;
            const result = await generateText({ ...request, system: withContentConstraints(request.system), model,
              temperature: request.temperature ?? deployment.temperature ?? undefined,
              ...(deployment.maxOutputTokens > 0 ? { maxOutputTokens: deployment.maxOutputTokens } : {}),
              abortSignal: AbortSignal.timeout(180000), maxRetries: 0 } as Parameters<typeof generateText>[0]);
            console.log(JSON.stringify({ event: "review-provider-result", call: providerCalls, finishReason: result.finishReason, usage: result.usage }));
            return result;
          },
        }, buildCharacterCardImagePromptContext(card), candidate.prompt, candidate.filePath!, { fourViewEvidence: true });
      },
    }, options);
    return { ...report, reviewModel: deployment.modelName, providerCalls, imageCalls: 0 };
  } catch (cause) {
    throw new Error(safeError(cause));
  } finally {
    source.close();
    if (db) await db.destroy();
  }
}

if (require.main === module) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  void runCharacterCardCandidateReview({ attemptId: Number(args.get("--attempt-id")),
    ownerId: args.has("--owner-id") ? Number(args.get("--owner-id")) : undefined,
    sourcePath: args.get("--source-db"), ossRoot: args.get("--oss-root") })
    .then(report => { console.log(JSON.stringify({ event: "review-complete", ...report })); if (!report.passed || !report.adopted) process.exitCode = 1; })
    .catch(cause => { console.error(JSON.stringify({ event: "review-failure", error: sanitizedReviewError(cause) })); process.exitCode = 1; });
}
