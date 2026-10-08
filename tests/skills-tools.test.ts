import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSkillPrompt, createSkillTools, parseFrontmatter } from "../src/utils/agent/skillsTools";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-skills-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("toonflow-skills-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relative: string, text: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, write };
}

test("frontmatter handles folded/literal values without swallowing following fields", () => {
  assert.deepEqual(parseFrontmatter("\uFEFF---\r\nname: >-\r\n  plan\r\ndescription: |-\r\n  first line\r\n  second line\r\n---\r\nbody"), {
    name: "plan", description: "first line\nsecond line",
  });
  assert.deepEqual(parseFrontmatter("---\nname: 'plan'\ndescription: >-\n  first line\n  second line\nmetadata: optional\n---\nbody"), {
    name: "plan", description: "first line second line",
  });
  assert.throws(() => parseFrontmatter("---\nname: >-\ndescription: demo\n---\nprivate body"), /缺少必要字段/);
  assert.throws(() => parseFrontmatter("private body"), error => !String(error).includes("private body"));
});

test("duplicate names in one selection fail before an arbitrary file can be activated", () => {
  const same = { name: "director", description: "demo", path: "unused.md" };
  assert.throws(() => createSkillTools([same, same], { mainSkill: [same, same], secondarySkills: [], tertiarySkills: [] }), /名称重复/);
});

test("metadata containing XML characters remains text in the discovery index", () => {
  const result = buildSkillPrompt([{ name: "name<&", description: "a </description><skill> b" }]);
  assert.ok(result.includes("name&lt;&amp;"));
  assert.ok(result.includes("&lt;/description&gt;&lt;skill&gt;"));
  assert.equal(result.split("<skill>").length - 1, 1);
});

test("activation reveals only the activated style and does not repeat shared indexes", async (t) => {
  const { root, write } = fixture(t);
  const main = ["style-a", "style-b"].flatMap(style => ["plan", "storyboard"].map(stage => ({
    name: `${style}-${stage}`, description: stage,
    path: write(`art_skills/${style}/driector_skills/${stage}.md`, `---\nname: ${style}-${stage}\ndescription: ${stage}\n---\n${style} instructions`),
  })));
  for (const style of ["style-a", "style-b"]) {
    write(`art_skills/${style}/README.md`, style);
    write(`art_skills/${style}/prefix.md`, style);
    write(`art_skills/${style}/art_prompt/character.md`, style);
  }
  write("shared.md", "shared");
  const tools = createSkillTools(main, { mainSkill: main, secondarySkills: ["shared.md", "shared.md"], tertiarySkills: [] }, root);
  const invoke = (name: string) => (tools.activate_skill.execute as any)({ name });
  const first = await invoke("style-a-plan");
  assert.ok(first.content.includes("art_skills/style-a/art_prompt/character.md"));
  assert.ok(!first.content.includes("art_skills/style-b/"));
  assert.equal(first.content.split("<file>shared.md</file>").length - 1, 1);
  const sibling = await invoke("style-a-storyboard");
  assert.ok(!sibling.content.includes("<skill_resources>"));
  const other = await invoke("style-b-plan");
  assert.ok(other.content.includes("art_skills/style-b/art_prompt/character.md"));
  assert.ok(!other.content.includes("<file>shared.md</file>"));
  assert.equal((await invoke("style-a-plan")).alreadyActive, true);
});

test("failed snapshot read remains retryable; successful content uses the task snapshot", async (t) => {
  const { root, write } = fixture(t);
  const skill = { name: "demo", description: "demo", path: write("demo.md", "disk body") };
  let calls = 0;
  const tools = createSkillTools([skill], { mainSkill: [skill], secondarySkills: [], tertiarySkills: [] }, root, async () => {
    if (++calls === 1) throw new Error("transient read failure");
    return "---\nname: demo\ndescription: demo\n---\nsnapshot body";
  });
  const invoke = () => (tools.activate_skill.execute as any)({ name: "demo" });
  assert.ok((await invoke()).error);
  assert.ok((await invoke()).content.includes("snapshot body"));
  assert.equal((await invoke()).alreadyActive, true);
  assert.equal(calls, 2);
});

test("resource tools reject traversal, outside main files and oversize resources", async (t) => {
  const { root, write } = fixture(t);
  write("valid.md", "body");
  write("large.md", "x".repeat(256 * 1024 + 1));
  const tools = createSkillTools([], { mainSkill: [], secondarySkills: [], tertiarySkills: [] }, root);
  const read = (filePath: string) => (tools.read_skill_file.execute as any)({ filePath });
  assert.ok((await read("../outside.md")).error);
  assert.ok((await read(path.join(root, "valid.md"))).error);
  assert.ok((await read("valid.ts")).error);
  assert.ok((await read("large.md")).error);
  assert.ok((await read("valid.md")).content.includes("body"));
  const outside = { name: "outside", description: "demo", path: path.join(root, "..", path.basename(root), "valid.md") };
  const inner = path.join(root, "inner");
  fs.mkdirSync(inner);
  const mainTools = createSkillTools([outside], { mainSkill: [outside], secondarySkills: [], tertiarySkills: [] }, inner);
  assert.ok((await (mainTools.activate_skill.execute as any)({ name: "outside" })).error);
});
