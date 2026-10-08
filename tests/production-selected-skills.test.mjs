import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("selected production skills have complete, unique frontmatter", async () => {
  const { parseFrontmatter } = await import("../src/utils/agent/skillsTools.ts");
  const roots = [
    "data/skills/art_skills/realistic_3d_anime/driector_skills",
    "data/skills/story_skills/Scifi_post_apocalypse/driector_skills",
    "data/skills/production_skills",
  ];
  const names = new Set();
  for (const root of roots) {
    for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".md"))) {
      const metadata = parseFrontmatter(fs.readFileSync(path.join(root, file), "utf8"));
      assert.ok(metadata.name, `${root}/${file}: missing name`);
      assert.ok(metadata.description, `${root}/${file}: missing description`);
      assert.ok(!names.has(metadata.name), `${root}/${file}: duplicate skill name ${metadata.name}`);
      names.add(metadata.name);
    }
  }
  assert.ok(names.has("director_planning_style"));
  assert.ok(names.has("director_storyboard"));
  assert.ok(names.has("director_storyboard_table_style"));
  assert.ok(names.has("storyboard_prompt_techniques"));
});

test("every selectable art/story combination has unambiguous activation names", async () => {
  const { parseFrontmatter } = await import("../src/utils/agent/skillsTools.ts");
  const load = root => fs.readdirSync(root).filter(name => name.endsWith(".md")).map(name => {
    const file = path.join(root, name);
    const content = fs.readFileSync(file, "utf8");
    const metadata = parseFrontmatter(content);
    assert.ok(content.replace(/^\uFEFF?---[\s\S]*?\r?\n---/, "").trim(), `${file}: empty skill`);
    return { ...metadata, file };
  });
  const variants = root => fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, "driector_skills"))
    .filter(dir => fs.existsSync(dir))
    .map(load);
  const art = variants("data/skills/art_skills");
  const story = variants("data/skills/story_skills");
  const common = load("data/skills/production_skills");
  assert.ok(art.length && story.length);
  for (const selectedArt of art) {
    for (const selectedStory of story) {
      const names = new Map();
      for (const skill of [...selectedArt, ...selectedStory, ...common]) {
        assert.ok(!names.has(skill.name), `ambiguous ${skill.name}: ${names.get(skill.name)} / ${skill.file}`);
        names.set(skill.name, skill.file);
      }
    }
  }
});
