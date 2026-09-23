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
