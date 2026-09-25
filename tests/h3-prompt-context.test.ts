import test from "node:test";
import assert from "node:assert/strict";
import {
  buildH3PromptInput,
  buildH3ReferenceSubjects,
  h3BindingSlots,
  h3PromptWordCounts,
} from "../src/utils/h3PromptContext";
import { assertH3ReferenceBindings, type H3ReferenceBindingSlot } from "../src/utils/h3ReferenceBindings";
import { assertH3PromptContract } from "../src/utils/h3PromptContract";
import type { H3SlotItem } from "../src/utils/h3ReferenceSlots";

type View = "FACE" | "FULL_BODY_FRONT" | "FULL_BODY_SIDE" | "FULL_BODY_BACK";
const role = (id: number, view: View, more: Record<string, unknown> = {}): H3SlotItem => ({
  id, type: "role", name: "Ava", _referenceRole: view, ...more,
});
const jsonBlock = (input: string, tag: string) => {
  const block = input.match(new RegExp("<" + tag + ">\\s*([\\s\\S]*?)\\s*</" + tag + ">"));
  assert.ok(block, "missing " + tag);
  return JSON.parse(block[1]);
};

test("a four-view character board contributes one Subject and an independent scene contributes one more", () => {
  const slots = [
    role(129, "FACE", { name: "觉醒状态脸部身份参考", assetsId: 115 }),
    role(129, "FULL_BODY_FRONT", { name: "觉醒状态正面全身参考", assetsId: 115 }),
    role(129, "FULL_BODY_SIDE", { name: "觉醒状态侧面全身参考", assetsId: 115 }),
    role(129, "FULL_BODY_BACK", { name: "觉醒状态背面全身参考", assetsId: 115 }),
    { id: 118, type: "scene", name: "末世海洋" },
  ];
  const before = structuredClone(slots);
  assert.deepEqual(buildH3ReferenceSubjects(slots), [
    {
      subject: "<Subject 1>", assetId: 129, assetType: "role", name: "觉醒状态", parentAssetId: 115,
      pictures: [
        { picture: "<Picture 1>", view: "FACE" },
        { picture: "<Picture 2>", view: "FULL_BODY_FRONT" },
        { picture: "<Picture 3>", view: "FULL_BODY_SIDE" },
        { picture: "<Picture 4>", view: "FULL_BODY_BACK" },
      ],
    },
    { subject: "<Subject 2>", assetId: 118, assetType: "scene", name: "末世海洋", pictures: [{ picture: "<Picture 5>" }] },
  ]);
  assert.deepEqual(slots, before, "grouping must not reorder or rewrite uploaded slots");
});

test("mixed assets group in first-upload order and retain nonconsecutive Picture sources without sorting", () => {
  const slots: H3SlotItem[] = [
    { assetId: 300, assetType: "environment", label: "Room" },
    { assetId: 129, assetType: "character", label: "Awakened Ava正面全身参考", referenceKind: "FULL_BODY_FRONT", parentAssetId: 115 },
    { assetId: 401, assetType: "prop", label: "Phone" },
    { assetId: 129, assetType: "character", label: "Awakened Ava脸部身份参考", referenceKind: "FACE", parentAssetId: 115 },
    role(117, "FACE", { _assetName: "Cole", name: "generated crop suffix" }),
    role(117, "FULL_BODY_FRONT", { _assetName: "Cole" }),
    { assetId: 402, assetType: "creature", name: "Shark" },
  ];
  const subjects = buildH3ReferenceSubjects(slots);
  assert.deepEqual(subjects.map(subject => [subject.subject, subject.assetId, subject.assetType, subject.name]), [
    ["<Subject 1>", 300, "scene", "Room"],
    ["<Subject 2>", 129, "role", "Awakened Ava"],
    ["<Subject 3>", 401, "tool", "Phone"],
    ["<Subject 4>", 117, "role", "Cole"],
    ["<Subject 5>", 402, "tool", "Shark"],
  ]);
  assert.deepEqual(subjects[1].pictures, [
    { picture: "<Picture 2>", view: "FULL_BODY_FRONT" },
    { picture: "<Picture 4>", view: "FACE" },
  ]);
  assert.equal(subjects[1].parentAssetId, 115);
  assert.deepEqual(subjects[3].pictures, [
    { picture: "<Picture 5>", view: "FACE" },
    { picture: "<Picture 6>", view: "FULL_BODY_FRONT" },
  ]);
  const input = buildH3PromptInput(slots, [], 12);
  assert.deepEqual([...input.matchAll(/<reference slot="(\d+)" sources="assets" id="(\d+)" \/>/g)].map(match => [Number(match[1]), Number(match[2])]), [
    [1, 300], [2, 129], [3, 401], [4, 129], [5, 117], [6, 117], [7, 402],
  ]);
  assert.deepEqual(jsonBlock(input, "referenceSubjects"), subjects);
});

test("prompt input carries each storyboard once with exact dialogue and causal order but excludes asset design prose and unuploaded files", () => {
  const slots = [role(115, "FULL_BODY_FRONT", {
    name: "Ava正面全身参考",
    prompt: "PRIVATE_ASSET_PROMPT: extensive wardrobe and four-panel directions",
    assetPrompt: "PRIVATE_ASSET_PROMPT_FIELD",
    describe: "PRIVATE_ASSET_DESCRIPTION: future transformations",
    filePath: "/original-four-view-sheet.png",
    faceReferencePath: "/not-uploaded-face.png",
    sideReferencePath: "/not-uploaded-side.png",
    backReferencePath: "/not-uploaded-back.png",
    fullBodyReferencePath: "/actual-front.png",
  })];
  const storyboards = [
    {
      id: 23, duration: 6,
      videoDesc: "麦迪逊故意双手推艾娃肩头。\n麦迪逊说：『姐姐，下去喂鱼吧。』\n艾娃失去平衡，向后翻出船舷。",
      prompt: "PRIVATE_STORYBOARD_IMAGE_PROMPT",
      describe: "PRIVATE_STORYBOARD_DESCRIPTION",
      filePath: "/storyboard-preview.png",
    },
    {
      id: 24, duration: "6",
      videoDesc: "手机系统女声说：『重生倒计时，三，二，一。』\n艾娃说：『我选重生。』\n艾娃主动点下“重生”按钮。",
    },
  ];
  const others = [{ label: "<Audio 1>", type: "audio", name: "System voice" }];
  const input = buildH3PromptInput(slots, storyboards, 12, others);
  assert.deepEqual(jsonBlock(input, "storyboardFacts"), storyboards.map(({ id, duration, videoDesc }) => ({ id, duration, videoDesc })));
  assert.equal((input.match(/"videoDesc":/g) || []).length, 2);
  for (const sentence of ["麦迪逊故意双手推艾娃肩头。", "姐姐，下去喂鱼吧。", "重生倒计时，三，二，一。", "我选重生。", "艾娃主动点下“重生”按钮。"]) {
    assert.equal(input.split(sentence).length - 1, 1, sentence + " must appear exactly once");
  }
  const dialogueOrder = ["姐姐，下去喂鱼吧。", "重生倒计时，三，二，一。", "我选重生。"].map(line => input.indexOf(line));
  assert.ok(dialogueOrder[0] < dialogueOrder[1] && dialogueOrder[1] < dialogueOrder[2]);
  assert.match(input, /Do not replace an intentional action with an accident/);
  assert.match(input, /target_duration: 12s/);
  assert.doesNotMatch(input, /PRIVATE_|original-four-view-sheet|not-uploaded-|actual-front\.png|storyboard-preview|assetPrompt|faceReferencePath|sideReferencePath|backReferencePath/);
  assert.doesNotMatch(input, /FULL_BODY_SIDE|FULL_BODY_BACK|"view":"FACE"|<Picture 2>/);
  assert.deepEqual(jsonBlock(input, "referenceSubjects")[0].pictures, [{ picture: "<Picture 1>", view: "FULL_BODY_FRONT" }]);
  assert.deepEqual(jsonBlock(input, "otherReferences"), others);
  assert.equal((input.match(/<otherReferences>/g) || []).length, 1);
  assert.doesNotMatch(buildH3PromptInput(slots, [], 5), /<otherReferences>/);
});

test("binding slots feed the real validator without allowing two crops to become different Subjects", () => {
  const slots: H3SlotItem[] = [
    { assetId: 115, assetType: "character", referenceKind: "FULL_BODY_FRONT" },
    { id: 119, type: "scene", name: "Room" },
    role(115, "FACE"),
  ];
  const bindings = h3BindingSlots(slots);
  const expectedBindings: H3ReferenceBindingSlot[] = [
    { assetId: 115, assetType: "role", kind: "FULL_BODY_FRONT" },
    { assetId: 119, assetType: "scene", kind: undefined },
    { assetId: 115, assetType: "role", kind: "FACE" },
  ];
  assert.deepEqual(bindings, expectedBindings);
  const correct = [
    "subject_definitions:",
    "<Subject 1> is Ava in <Picture 1> (front) and <Picture 3> (face).",
    "<Subject 2> is the room in <Picture 2>.",
    "summary:",
    "[reference generation] <Subject 1> walks across <Subject 2>.",
  ].join("\n");
  assert.doesNotThrow(() => assertH3ReferenceBindings(correct, bindings));
  const split = correct.replace("<Subject 1> is Ava in <Picture 1> (front) and <Picture 3> (face).",
    "<Subject 1> is Ava in <Picture 1>.\n<Subject 3> is the portrait person in <Picture 3>.");
  assert.throws(() => assertH3ReferenceBindings(split, bindings), /同一资产 115.*拆成多个 Subject/);
  const mixed = correct.replace("<Picture 3> (face)", "<Picture 2> (face)").replace("room in <Picture 2>", "room in <Picture 3>");
  // The putative room steals Ava's other crop; a contextual scene mention cannot hide that split.
  assert.throws(() => assertH3ReferenceBindings(mixed, bindings), /混用了不同资产|同一资产 115.*拆成多个 Subject/);
});

test("word counts distinguish detailed_description from the whole prompt without imposing a length gate", () => {
  const prompt = [
    "subject_definitions:", "<Subject 1> uses <Picture 1>.",
    "summary:", "[reference generation] <Subject 1> walks.",
    "retention_analysis:", "<Subject 1>: fully_preserved - identity.",
    "detailed_description:", "Soft light.", "[Shot 1] <Subject 1> steps forward.",
    "overall_soundscape:", "Wind.",
    "non_diegetic_music:", "N/A",
  ].join("\n");
  const counts = h3PromptWordCounts(prompt);
  assert.deepEqual(counts, {
    total: 32,
    sections: { subject_definitions: 3, summary: 4, retention_analysis: 4, detailed_description: 6, overall_soundscape: 1, non_diegetic_music: 2 },
  });
  assert.doesNotThrow(() => assertH3PromptContract(prompt, 5, 1), "a complete short description is valid");
  const expanded = prompt.replace("Soft light.", "Soft light. " + "steady ".repeat(700));
  const expandedCounts = h3PromptWordCounts(expanded);
  assert.equal(expandedCounts.total, counts.total + 700);
  assert.equal(expandedCounts.sections.detailed_description, counts.sections.detailed_description + 700);
  assert.equal(expandedCounts.sections.subject_definitions, counts.sections.subject_definitions);
  assert.doesNotThrow(() => assertH3PromptContract(expanded, 5, 1), "word count is diagnostic, not a hard rejection threshold");
});

