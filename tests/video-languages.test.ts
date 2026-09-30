import test from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrateVideoLanguages, generateLanguageVariants, resolveLanguagePrompt, resolveLanguageVariant, dialogueLanguagesSchema, assertTranslatedDialogueLanguage } from "../src/utils/videoLanguages";

async function fixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_videoTrack", (t) => {
    t.integer("id").primary();
    t.text("prompt");
    t.float("duration");
  });
  await db("o_videoTrack").insert({ id: 1, prompt: "<Picture 1> 女孩说：“你好。”", duration: 5 });
  await migrateVideoLanguages(db);
  return db;
}

test("explicit regeneration uses fresh visual instructions and preserves other languages and video history", async () => {
  const db = await fixture();
  try {
    await db("o_videoPromptVariant").insert([
      { trackId: 1, language: "en-US", prompt: "old English", state: "已完成", videoId: 91 },
      { trackId: 1, language: "ja-JP", prompt: "edited Japanese", state: "已完成", videoId: 92 },
    ]);
    await db("o_videoLanguage").insert({ videoId: 91, language: "en-US", prompt: "original video snapshot" });
    let baseCalls = 0;
    await generateLanguageVariants(db, 1, ["en-US"], async () => {
      baseCalls++;
      return "<Picture 1> modern donghua updated visual manual";
    }, async (_, source) => {
      assert.match(source, /updated visual manual/);
      return source + " spoken language: en-US";
    }, true);
    assert.equal(baseCalls, 1);
    const english = await db("o_videoPromptVariant").where({ language: "en-US" }).first();
    assert.match(english.prompt, /updated visual manual/);
    assert.equal(english.videoId, 91);
    assert.equal(english.state, "已完成");
    assert.equal((await db("o_videoPromptVariant").where({ language: "ja-JP" }).first()).prompt, "edited Japanese");
    assert.equal((await db("o_videoLanguage").first()).prompt, "original video snapshot");
    assert.match((await db("o_videoTrack").first()).prompt, /你好/);
    await generateLanguageVariants(db, 1, ["en-US"], async () => "<Picture 1> fresh", async () => { throw new Error("provider failed"); }, true);
    const failed = await db("o_videoPromptVariant").where({ language: "en-US" }).first();
    assert.equal(failed.prompt, english.prompt);
    assert.equal(failed.state, "生成失败");
    await generateLanguageVariants(db, 1, ["en-US"], async () => "", async () => "<Picture 1> retried");
    assert.equal((await db("o_videoPromptVariant").where({ language: "en-US" }).first()).state, "已完成");
  } finally { await db.destroy(); }
});

test("migration is repeatable and preserves original prompts and language selections", async () => {
  const db = await fixture();
  try {
    await db("o_videoLanguageSelection").insert({ projectId: 1, scriptId: 2, languages: JSON.stringify(["en-US", "ja-JP"]) });
    await migrateVideoLanguages(db);
    assert.deepEqual(JSON.parse((await db("o_videoLanguageSelection").first()).languages), ["en-US", "ja-JP"]);
    assert.match((await db("o_videoTrack").first()).prompt, /你好/);
  } finally {
    await db.destroy();
  }
});

test("rejects source-language dialogue that is mislabeled as a completed English variant", async () => {
  assert.throws(
    () => assertTranslatedDialogueLanguage("<d>[Chinese] 你好。</d>", "en-US"),
    /PROMPT_DIALOGUE_LANGUAGE/,
  );
  assert.throws(
    () => assertTranslatedDialogueLanguage("spoken language: zh-CN\n<d>[English] Hello.</d>", "en-US"),
    /spoken language/,
  );
  assert.throws(
    () => assertTranslatedDialogueLanguage('The visible button reads "领取". spoken language: en-US\n<d>[English] Claim.</d>', "en-US"),
    /PROMPT_VISIBLE_TEXT_LANGUAGE/,
  );
  assert.throws(
    () => assertTranslatedDialogueLanguage('Clean Chinese system lines appear: "Claim". <d>[English] Claim.</d>', "en-US"),
    /PROMPT_VISIBLE_TEXT_LANGUAGE/,
  );
  assert.throws(
    () => assertTranslatedDialogueLanguage('The screen shows the required Chinese characters: "Claim". <d>[English] Claim.</d>', "en-US"),
    /PROMPT_VISIBLE_TEXT_LANGUAGE/,
  );
  assert.doesNotThrow(() => assertTranslatedDialogueLanguage(
    'Premium semi-realistic Chinese 3D donghua. The visible English button reads "Claim". spoken language: en-US\n<d>[English] Claim.</d>', "en-US",
  ));
});

test("batch fill treats completed English variants with Chinese visible text as incomplete", async () => {
  const db = await fixture();
  try {
    await db("o_videoPromptVariant").insert({
      trackId: 1, language: "en-US", state: "已完成",
      prompt: '<Picture 1> The screen reads "领取". <d>[English] Claim.</d>',
    });
    let calls = 0;
    await generateLanguageVariants(db, 1, ["en-US"], async () => "unused", async () => {
      calls++;
      return '<Picture 1> The screen reads "Claim". <d>[English] Claim.</d>';
    });
    assert.equal(calls, 1);
    const saved = await db("o_videoPromptVariant").where({ trackId: 1, language: "en-US" }).first();
    assert.equal(saved.state, "已完成");
    assert.doesNotMatch(saved.prompt, /\p{Script=Han}/u);
  } finally { await db.destroy(); }
});

test("generates independent languages, retries only failures, and preserves manually edited variants", async () => {
  const db = await fixture();
  try {
    let calls = 0;
    const generateBase = async () => {
      throw new Error("must preserve original");
    };
    const first = await generateLanguageVariants(db, 1, ["en-US", "ja-JP"], generateBase, async (system, source) => {
      calls++;
      assert.match(source, /你好/);
      if (system.includes("ja-JP")) throw new Error("temporary provider failure");
      return '<Picture 1> She says "Hello." Spoken language: en-US';
    });
    assert.equal(first.find((v) => v.language === "en-US").state, "已完成");
    assert.equal(first.find((v) => v.language === "ja-JP").state, "生成失败");
    await db("o_videoPromptVariant").where({ language: "en-US" }).update({ prompt: "human-edited English", videoId: 91 });
    await generateLanguageVariants(db, 1, ["en-US", "ja-JP"], generateBase, async (system) => {
      calls++;
      assert.match(system, /ja-JP/);
      return "<Picture 1> 彼女：「こんにちは。」 Spoken language: ja-JP";
    });
    assert.equal(calls, 3);
    const english = await db("o_videoPromptVariant").where({ language: "en-US" }).first();
    assert.equal(english.prompt, "human-edited English");
    assert.equal(english.videoId, 91);
    assert.equal(await resolveLanguagePrompt(db, 1, "en-US", "wrong client prompt", true), "human-edited English");
    assert.match((await db("o_videoTrack").first()).prompt, /你好/);
  } finally {
    await db.destroy();
  }
});

test("blocks missing translations, silent generation, changed picture slots, and timing review", async () => {
  const db = await fixture();
  try {
    await assert.rejects(resolveLanguagePrompt(db, 1, "en-US", "source", true), /尚未就绪/);
    await assert.rejects(resolveLanguagePrompt(db, 1, "en-US", "source", false), /开启声音/);
    await generateLanguageVariants(
      db,
      1,
      ["en-US", "ja-JP"],
      async () => "",
      async (system) => (system.includes("en-US") ? "<Picture 2> Hello" : "LANGUAGE_TIMING_REVIEW: 台词过长"),
    );
    const variants = await db("o_videoPromptVariant");
    assert.ok(variants.every((v) => v.state === "生成失败" && !v.prompt));
    assert.match(variants.find((v) => v.language === "en-US").reason, /参考图编号/);
    assert.match(variants.find((v) => v.language === "ja-JP").reason, /台词过长/);
    assert.equal(await resolveLanguagePrompt(db, 1, undefined, "legacy"), "legacy");
    assert.equal(dialogueLanguagesSchema.safeParse(["en-US", "en-US"]).success, false);
    assert.equal(dialogueLanguagesSchema.safeParse(["unknown"]).success, false);
  } finally {
    await db.destroy();
  }
});

test("overlapping requests do not duplicate translation, and base failures remain retryable", async () => {
  const db = await fixture();
  try {
    let calls = 0;
    const translate = async () => {
      calls++;
      return "<Picture 1> Hello";
    };
    await Promise.all([
      generateLanguageVariants(db, 1, ["en-US"], async () => "", translate),
      generateLanguageVariants(db, 1, ["en-US"], async () => "", translate),
    ]);
    assert.equal(calls, 1);
    await db("o_videoTrack").insert({ id: 2, prompt: "" });
    await assert.rejects(
      generateLanguageVariants(
        db,
        2,
        ["ja-JP"],
        async () => {
          throw new Error("base generation failed");
        },
        translate,
      ),
    );
    assert.equal((await db("o_videoPromptVariant").where({ trackId: 2 }).first()).state, "生成失败");
  } finally {
    await db.destroy();
  }
});

test("a rejected base never overwrites saved language text or becomes a new language draft", async () => {
  const db = await fixture();
  try {
    await db("o_videoPromptVariant").insert([
      { trackId: 1, language: "en-US", prompt: "saved English", state: "已完成", videoId: 91 },
      { trackId: 1, language: "ja-JP", prompt: "saved Japanese", state: "已完成", videoId: 92 },
    ]);
    await db("o_videoLanguage").insert({ videoId: 91, language: "en-US", prompt: "completed video snapshot" });
    const failure = Object.assign(new Error("H3 content review: wrong event order"), { candidatePrompt: "未经校验的中文基版" });
    let translations = 0;
    await assert.rejects(generateLanguageVariants(db, 1, ["en-US", "ko-KR"], async () => { throw failure; }, async () => {
      translations++;
      return "unexpected";
    }, true), /wrong event order/);
    const english = await db("o_videoPromptVariant").where({ language: "en-US" }).first();
    assert.equal(english.prompt, "saved English");
    assert.equal(english.state, "生成失败");
    assert.equal(english.reason, failure.message);
    assert.equal(english.videoId, 91);
    const korean = await db("o_videoPromptVariant").where({ language: "ko-KR" }).first();
    assert.equal(korean.prompt, "");
    assert.equal(korean.state, "生成失败");
    assert.equal(korean.reason, failure.message);
    const japanese = await db("o_videoPromptVariant").where({ language: "ja-JP" }).first();
    assert.equal(japanese.prompt, "saved Japanese");
    assert.equal(japanese.state, "已完成");
    assert.equal(japanese.videoId, 92);
    assert.equal((await db("o_videoLanguage").first()).prompt, "completed video snapshot");
    assert.equal((await db("o_videoTrack").first()).prompt, '<Picture 1> 女孩说：“你好。”');
    assert.equal(translations, 0);
  } finally { await db.destroy(); }
});

test("rejected translations preserve any saved prompt, other languages and existing video links", async () => {
  const db = await fixture();
  try {
    await db("o_videoPromptVariant").insert([
      { trackId: 1, language: "en-US", prompt: "human-corrected text after earlier failure", state: "生成失败", videoId: 91 },
      { trackId: 1, language: "ja-JP", prompt: "saved Japanese", state: "已完成", videoId: 92 },
    ]);
    const failure = Object.assign(new Error("H3 semantic review: wrong speaker"), { candidatePrompt: "rejected translated candidate" });
    await generateLanguageVariants(db, 1, ["en-US", "ko-KR"], async () => "<Picture 1> fresh validated base", async () => { throw failure; }, true);
    const english = await db("o_videoPromptVariant").where({ language: "en-US" }).first();
    assert.equal(english.prompt, "human-corrected text after earlier failure");
    assert.equal(english.state, "生成失败");
    assert.equal(english.reason, failure.message);
    assert.equal(english.videoId, 91);
    const korean = await db("o_videoPromptVariant").where({ language: "ko-KR" }).first();
    assert.equal(korean.prompt, "");
    assert.equal(korean.state, "生成失败");
    assert.equal(korean.reason, failure.message);
    const japanese = await db("o_videoPromptVariant").where({ language: "ja-JP" }).first();
    assert.equal(japanese.prompt, "saved Japanese");
    assert.equal(japanese.state, "已完成");
    assert.equal(japanese.videoId, 92);
    assert.equal((await db("o_videoTrack").first()).prompt, '<Picture 1> 女孩说：“你好。”');
  } finally { await db.destroy(); }
});

test("translation compares unique structural reference labels, not repeats or spoken literal tags", async () => {
  const db = await fixture();
  try {
    await db("o_videoTrack").where({ id: 1 }).update({ prompt: '<Subject 1> is the woman in <Picture 1>. <Subject 1> says <d>[Chinese] 标记写着 <Picture 99>。</d>' });
    const translation = '<Subject 1> is the woman in <Picture 1>. <Subject 1> turns. <Subject 1> says <d>[English] The label says <Subject 8>.</d>';
    await generateLanguageVariants(db, 1, ["en-US"], async () => "unexpected", async () => translation);
    const saved = await db("o_videoPromptVariant").where({ language: "en-US" }).first();
    assert.equal(saved.state, "已完成", saved.reason);
    assert.equal(saved.prompt, translation);
    await generateLanguageVariants(db, 1, ["ja-JP"], async () => "unexpected", async () => '<Subject 1> says <d>[Japanese] <Picture 1></d>');
    const missing = await db("o_videoPromptVariant").where({ language: "ja-JP" }).first();
    assert.equal(missing.state, "生成失败");
    assert.match(missing.reason, /参考图编号/);
    assert.equal(missing.prompt, "");
  } finally { await db.destroy(); }
});


test("target language gets its own duration and a second timing pass when natural speech is longer", async () => {
  const db = await fixture();
  try {
    const source = '<Picture 1> <d>[Chinese] 快走。</d>';
    await db("o_videoTrack").where({ id: 1 }).update({ prompt: source, duration: 5 });
    const english = '<Picture 1> <d>[English] We need to get out of here right now before they find us.</d>';
    let calls = 0;
    const variants = await generateLanguageVariants(
      db,
      1,
      ["en-US"],
      async () => { throw new Error("base should already exist"); },
      async (system, current, language, targetDuration) => {
        calls++;
        assert.equal(language, "en-US");
        if (calls === 1) {
          assert.equal(current, source);
          assert.equal(targetDuration, 5);
          return english;
        }
        assert.match(system, /new target duration/i);
        assert.equal(current, english);
        assert.ok(Number(targetDuration) > 5);
        return english;
      },
    );
    const saved = variants.find((v: any) => v.language === "en-US");
    assert.equal(saved.state, "已完成", saved.reason);
    assert.ok(saved.duration > 5);
    assert.equal(calls, 2);
    const columns = await db("o_videoPromptVariant").columnInfo();
    assert.ok(columns.duration);
  } finally { await db.destroy(); }
});

test("language timing review fails instead of speed-reading a translation beyond the 15 second clip limit", async () => {
  const db = await fixture();
  try {
    await db("o_videoTrack").where({ id: 1 }).update({
      prompt: '<Picture 1> <d>[Chinese] 走。</d>',
      duration: 5,
    });
    const veryLong = '<Picture 1> <d>[English] ' + Array.from({ length: 45 }, (_, i) => 'word' + i).join(' ') + '.</d>';
    const variants = await generateLanguageVariants(
      db,
      1,
      ["en-US"],
      async () => { throw new Error("base should already exist"); },
      async () => veryLong,
    );
    const saved = variants.find((v: any) => v.language === "en-US");
    assert.equal(saved.state, "生成失败");
    assert.match(saved.reason, /LANGUAGE_TIMING_REVIEW/);
    assert.ok(!saved.prompt);
  } finally { await db.destroy(); }
});


test("old completed variant cannot bypass target-language retiming when generating video directly", async () => {
  const db = await fixture();
  try {
    await db("o_videoTrack").where({ id: 1 }).update({
      prompt: '<Picture 1> <d>[Chinese] 快走。</d>',
      duration: 5,
    });
    await db("o_videoPromptVariant").insert({
      trackId: 1,
      language: "en-US",
      state: "已完成",
      prompt: '<Picture 1> <d>[English] We need to get out of here right now before they find us.</d>',
      duration: null,
    });
    await assert.rejects(
      resolveLanguageVariant(db, 1, "en-US", "wrong", 5, true),
      /需要按目标语言重新规划时间轴/,
    );
  } finally { await db.destroy(); }
});
