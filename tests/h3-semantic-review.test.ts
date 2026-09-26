import test from "node:test";
import assert from "node:assert/strict";
import { parseH3SemanticReview } from "../src/utils/h3SemanticReview";

const issue = {
  code: "EVENT_ORDER",
  evidence: "She taunts Ava after the shove.",
  reason: "The storyboard places the taunt before the deliberate shove.",
};

test("a clean semantic review is an explicit empty issues array", () => {
  assert.deepEqual(parseH3SemanticReview('{"issues":[]}'), []);
  assert.throws(() => parseH3SemanticReview(""), /需要完整 JSON/);
  assert.throws(() => parseH3SemanticReview("No issues."), /需要完整 JSON/);
});

test("parses exact evidence without rewriting quotes or original dialogue language", () => {
  const dialogueIssue = { code: "DIALOGUE_MEANING", evidence: '"Sister"', reason: "源对白明确称呼姐姐；此处没有保留年长关系。" };
  const issues = [issue, dialogueIssue];
  assert.deepEqual(parseH3SemanticReview(JSON.stringify({ issues })), issues);
});

test("accepts a single outer JSON fence but rejects wrapper prose and extra results", () => {
  const json = JSON.stringify({ issues: [issue] });
  assert.deepEqual(parseH3SemanticReview(` \n\`\`\`json\n${json}\n\`\`\`\n `), [issue]);
  assert.deepEqual(parseH3SemanticReview(`\`\`\`\r\n${json}\r\n\`\`\``), [issue]);
  for (const malformed of [
    `Review:\n${json}`, `${json}\nDone.`, `${json}\n${json}`,
    `\`\`\`javascript\n${json}\n\`\`\``, `\`\`\`json\n${json}`,
  ]) assert.throws(() => parseH3SemanticReview(malformed), /需要完整 JSON/);
});

test("rejects unknown top-level shapes instead of treating them as a passing review", () => {
  for (const value of [null, [], true, "approved", {}, { issues: null }, { issues: {} }, { issues: "none" }, { issues: [], passed: true }]) {
    assert.throws(() => parseH3SemanticReview(JSON.stringify(value)), /顶层只能包含 issues 数组/);
  }
});

test("every issue requires exactly the three named fields", () => {
  for (const value of [null, [], "problem", {}, { code: issue.code, reason: issue.reason }, { ...issue, severity: "error" }]) {
    assert.throws(() => parseH3SemanticReview(JSON.stringify({ issues: [value] })), /只能包含 code、evidence、reason/);
  }
});

test("rejects empty, whitespace-only or non-string issue fields", () => {
  for (const field of ["code", "evidence", "reason"]) {
    for (const value of ["", " \n\t", null, 1, false, [], {}]) {
      assert.throws(() => parseH3SemanticReview(JSON.stringify({ issues: [{ ...issue, [field]: value }] })), /必须是非空字符串/);
    }
  }
});

test("bounds the review to eight actionable issues without silently truncating", () => {
  assert.equal(parseH3SemanticReview(JSON.stringify({ issues: Array.from({ length: 8 }, () => issue) })).length, 8);
  assert.throws(() => parseH3SemanticReview(JSON.stringify({ issues: Array.from({ length: 9 }, () => issue) })), /最多允许 8 项/);
});
