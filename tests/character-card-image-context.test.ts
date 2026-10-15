import test from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { getCharacterCard, migrateCharacterCards } from "../src/utils/characterCards";
import { descriptionMeta, imageIsStale } from "../src/utils/assetDescriptionVersion";
import { buildCharacterCardImagePromptContext } from "../src/utils/characterCardImagePromptContext";

test("card drawing carries readable age/design metadata and identifies an old selected sheet as a redesign", async t => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy()); await migrateCharacterCards(db);
  const card = (await getCharacterCard(db, 4, 1))!;
  card.imageId = 22; card.imagePath = "/cards/complete-original.jpg"; card.version = 3;
  card.imageNeedsRegeneration = true; card.imageState = "stale";
  const context = buildCharacterCardImagePromptContext(card);
  const meta = descriptionMeta(context.asset);
  assert.deepEqual(meta.visualDesign, card.visualDesign);
  assert.match(meta.userConstraints, /成年青年女性[\s\S]*18至39/);
  assert.equal(imageIsStale(context.asset), true);
  assert.deepEqual(context.references.map(r => r.path), ["/cards/complete-original.jpg"]);
});

test("age-unknown card context preserves unknown bounds and supplies no invented adulthood", async t => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => db.destroy()); await migrateCharacterCards(db);
  const context = buildCharacterCardImagePromptContext((await getCharacterCard(db, 10, 1))!);
  const constraints = descriptionMeta(context.asset).userConstraints;
  assert.match(constraints, /年龄段：unknown[\s\S]*未指定至未指定[\s\S]*不能编造精确数字或默认成年/);
  assert.equal(context.references.length, 0);
  assert.equal(imageIsStale(context.asset), false);
});
