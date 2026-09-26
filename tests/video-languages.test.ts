import test from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { migrateVideoLanguages, generateLanguageVariants, resolveLanguagePrompt, dialogueLanguagesSchema } from "../src/utils/videoLanguages";

async function fixture() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_videoTrack", (t) => {
    t.integer("id").primary();
    t.text("prompt");
  });
  await db("o_videoTrack").insert({ id: 1, prompt: "<Picture 1> 女孩说：“你好。”" });
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

test("format rejection shows the rejected draft rather than unrelated old text", async () => {
 const db=await fixture();try {
 await db("o_videoPromptVariant").insert({trackId:1,language:"en-US",prompt:"old English",state:"已完成"});
 const rejected=Object.assign(new Error("H3 format error"),{candidatePrompt:"actual rejected draft"});
 await generateLanguageVariants(db,1,["en-US"],async()=>"fresh base",async()=>{throw rejected},true);
 const row=await db("o_videoPromptVariant").first();assert.equal(row.prompt,rejected.candidatePrompt);assert.equal(row.state,"生成失败");assert.equal(row.reason,rejected.message);
 assert.equal((await db("o_videoTrack").first()).prompt,'<Picture 1> 女孩说：“你好。”');
 }finally{await db.destroy()}
});
