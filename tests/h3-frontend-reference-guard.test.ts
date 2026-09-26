import test from "node:test";
import assert from "node:assert/strict";
import { getH3ReferenceGuardError, type H3SubmissionEntry } from "../Toonflow-web-master/src/utils/h3ReferenceGuard";

const model = "comfyui_local:MiniMax-H3-local";
const mode = '["imageReference:9"]';
const images = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1, sources: "assets", fileType: "image" }));
const prompt = (...numbers: number[]) => numbers.map(number => `<Subject ${number}> from <Picture ${number}>`).join("\n");
const entry = (text = prompt(1, 2, 3, 4), count = 4): H3SubmissionEntry => ({ label: "视频段 #1（英语）", prompt: text, uploadData: images(count) });

test("four whole asset images reject a historical six-Picture prompt", () => {
  const error = getH3ReferenceGuardError(model, mode, [entry(prompt(1, 2, 3, 4, 5, 6))]);
  assert.match(error!, /实际上传 4 张独立图片.*引用 6 张/);
  assert.match(error!, /重新生成提示词/);
  assert.match(error!, /任务结束后重启后端/);
});

test("valid whole-sheet references allow repeated labels and ignore dialogue Picture tokens", () => {
  assert.equal(getH3ReferenceGuardError(model, mode, [entry(prompt(1, 2, 3, 4, 1) + '\n<d>[English] Say <Picture 9>.\nThen <Picture 12>.</d>')]), null);
});

test("repeated image assets are rejected without silently changing the selection", () => {
  for (const repeated of images(4)) {
    const value = entry();
    value.uploadData = [...value.uploadData, repeated];
    const before = structuredClone(value);
    const error = getH3ReferenceGuardError(model, mode, [entry(), value]);
    assert.match(error!, new RegExp(`ID ${repeated.id}.*重复选择`));
    assert.match(error!, /请移除重复参考图/);
    assert.deepEqual(value, before);
  }
});

test("storyboard, audio, video and disabled references do not count as repeated images", () => {
  const value = entry();
  value.uploadData = [...value.uploadData,
    { id: 1, sources: "storyboard", fileType: "image" },
    { id: 1, sources: "assets", fileType: "audio" },
    { id: 1, sources: "assets", fileType: "audio" },
    { id: 2, sources: "assets", fileType: "video" },
    { id: 3, sources: "assets", type: "audioReference" },
    { id: 4, sources: "assets", slotType: "videoReference" },
    { id: 1, sources: "assets", fileType: "image", reference: false }];
  const before = structuredClone(value);
  assert.equal(getH3ReferenceGuardError(model, mode, [value]), null);
  assert.deepEqual(value, before);
});

test("equal counts still reject gaps or zero-based Picture numbering", () => {
  assert.match(getH3ReferenceGuardError(model, mode, [entry(prompt(1, 2, 3, 5))])!, /编号应连续为 1–4/);
  assert.match(getH3ReferenceGuardError(model, mode, [entry(prompt(0, 1, 2, 3))])!, /编号应连续为 1–4/);
});

test("every selected language and track is checked before a whole batch is allowed", () => {
  const valid = entry();
  const invalid = { ...entry(prompt(1, 2, 3, 4, 5, 6)), label: "视频段 #2（法语）" };
  assert.match(getH3ReferenceGuardError(model, mode, [valid, invalid])!, /^视频段 #2（法语）/);
});

test("only MiniMax H3 multi-reference modes are checked", () => {
  const invalid = entry(prompt(1, 2, 3, 4, 5, 6));
  for (const otherMode of ["text", "singleImage", "startEndRequired", '["videoReference"]', "not-json"]) {
    assert.equal(getH3ReferenceGuardError(model, otherMode, [invalid]), null);
  }
  assert.equal(getH3ReferenceGuardError("other:video", mode, [invalid]), null);
  assert.equal(getH3ReferenceGuardError("comfyui:Other-H3", mode, [invalid]), null);
  assert.match(getH3ReferenceGuardError(model, ["imageReference:9", "audioReference"], [invalid])!, /引用 6 张/);
});

test("empty selections and more than nine distinct image assets fail", () => {
  assert.match(getH3ReferenceGuardError(model, mode, [entry("", 0)])!, /至少需要 1 张图片资产/);
  assert.match(getH3ReferenceGuardError(model, mode, [entry(prompt(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), 10)])!, /最多支持 9 张/);
  assert.equal(getH3ReferenceGuardError(model, mode, [entry(prompt(1, 2, 3, 4, 5, 6, 7, 8, 9), 9)]), null);
});
