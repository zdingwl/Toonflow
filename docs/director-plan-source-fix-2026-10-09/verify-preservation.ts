import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { validateDirectorFacts } from "../../src/agents/productionAgent/screenplay";
import { validateDirectorExecution } from "../../src/agents/productionAgent/directorPlanQuality";
import { extractDirectorPlan } from "../../src/agents/productionAgent/directorPlan";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const dir = path.resolve("docs/director-plan-source-fix-2026-10-09");
const before = JSON.parse(fs.readFileSync(path.join(dir, "before-state.json"), "utf8"));
const Database = createRequire(path.resolve("package.json"))("better-sqlite3");
const db = new Database(path.resolve("data/db2.sqlite"), { readonly: true });
try {
  const source = db.prepare("select content from o_script where id=? and projectId=?").get(before.source.id, before.source.projectId);
  const workspaces = db.prepare("select id,data from o_agentWorkData order by id").all().map((row: any) => ({ id: row.id, hash: hash(row.data ?? "") }));
  const counts = Object.fromEntries(Object.keys(before.counts).map(table => [table, db.prepare(`select count(*) as n from ${table}`).get().n]));
  const workspace = db.prepare("select data from o_agentWorkData where projectId=? and episodesId=? and key='productionAgent'").get(before.source.projectId, before.source.id);
  const currentPlan = JSON.parse(workspace.data).scriptPlan;
  const failures = ["", "-2", "-3", "-4", "-5"].map(suffix => {
    const file = `docs/director-plan-evaluation/2026-10-09-source-candidate${suffix}.md`;
    const plan = fs.readFileSync(file, "utf8");
    return { file, errors: [...validateDirectorFacts(source.content, plan), ...validateDirectorExecution(source.content, plan)] };
  });
  const earlierFeedback = "docs/director-plan-evaluation/2026-10-09-source-feedback-final.attempt-2.md";
  if (fs.existsSync(earlierFeedback)) failures.push({ file: earlierFeedback, errors: [
    ...validateDirectorFacts(source.content, fs.readFileSync(earlierFeedback, "utf8")),
    ...validateDirectorExecution(source.content, fs.readFileSync(earlierFeedback, "utf8")),
  ] });
  const previousPass = "docs/director-plan-evaluation/2026-10-09-source-direct-review-pass.attempt-1.md";
  if (fs.existsSync(previousPass)) failures.push({ file: previousPass, errors: [
    ...validateDirectorFacts(source.content, fs.readFileSync(previousPass, "utf8")),
    ...validateDirectorExecution(source.content, fs.readFileSync(previousPass, "utf8")),
  ] });
  const finalFile = process.argv[2] ?? "docs/director-plan-evaluation/2026-10-09-source-final-qualified.json";
  let finalCandidate = null;
  if (fs.existsSync(finalFile)) {
    const evaluation = JSON.parse(fs.readFileSync(finalFile, "utf8"));
    const raw = fs.readFileSync(evaluation.attempts.at(-1).rawOutput, "utf8");
    const plan = fs.readFileSync(evaluation.finalCandidateOutput, "utf8");
    finalCandidate = {
      file: evaluation.finalCandidateOutput, attempts: evaluation.attemptCount,
      currentValidationErrors: [...validateDirectorFacts(source.content, plan), ...validateDirectorExecution(source.content, plan)],
      rawResponseUnchanged: hash(raw) === evaluation.rawResponseHash,
      candidateExactlyExtractedFromRaw: extractDirectorPlan(raw) === plan,
      currentSkillMatchesGeneration: hash(fs.readFileSync("data/skills/production_execution_director_plan.md", "utf8")) === evaluation.skillHash,
      currentSourceMatchesGeneration: hash(source.content) === evaluation.sourceHash,
    };
  }
  const result = {
    sourceUnchanged: hash(source.content) === before.sourceHash,
    allWorkspacesUnchanged: JSON.stringify(workspaces) === JSON.stringify(before.workspaces),
    countsUnchanged: JSON.stringify(counts) === JSON.stringify(before.counts),
    counts, sourceHash: hash(source.content), savedPlanHash: hash(currentPlan),
    savedPlanValidationErrors: [...validateDirectorFacts(source.content, currentPlan), ...validateDirectorExecution(source.content, currentPlan)],
    activeRuns: db.prepare("select id,status from o_agentRun where status='running'").all(),
    activeTasks: db.prepare("select id,state from o_tasks where state='进行中'").all(),
    skillHash: hash(fs.readFileSync("data/skills/production_execution_director_plan.md", "utf8")),
    retrospectiveChecks: failures,
    finalCandidate,
  };
  fs.writeFileSync(path.join(dir, "preservation-verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.sourceUnchanged || !result.allWorkspacesUnchanged || !result.countsUnchanged || result.savedPlanValidationErrors.length) process.exitCode = 1;
} finally { db.close(); }
