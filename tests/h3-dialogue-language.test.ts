import test from "node:test";
import assert from "node:assert/strict";
import { checkH3DialogueBudget, estimateH3SpeechSeconds, h3DialogueLocaleInstruction, resolveH3DialogueLocale } from "../src/utils/h3DialogueLanguage";

test("original-language option preserves the script by default", () => {
  assert.equal(resolveH3DialogueLocale(undefined), "original");
  assert.match(h3DialogueLocaleInstruction(undefined), /Preserve every script dialogue/);
});

test("explicit locale changes spoken lines only", () => {
  assert.equal(resolveH3DialogueLocale("en-US"), "en-US");
  assert.match(h3DialogueLocaleInstruction("en-US"), /ONLY spoken dialogue/);
  assert.match(h3DialogueLocaleInstruction("ja-JP"), /Japanese/);
  assert.throws(() => resolveH3DialogueLocale("US"), /不支持/);
});

test("translated speech budget never silently changes the target clip duration", () => {
  assert.equal(checkH3DialogueBudget(["Hello."], "en-US", 5).fits, true);
  assert.equal(checkH3DialogueBudget(["This is a very long sentence that cannot possibly fit in one single second."], "en-US", 1).fits, false);
  assert.ok(estimateH3SpeechSeconds("你们都得付出代价。", "zh-CN") > 0);
});
