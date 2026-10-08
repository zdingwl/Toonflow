import fs from "node:fs/promises";
import path from "node:path";

export type VideoTemplateFamily = "minimax-h3-ref2va" | "seedance2" | "wan2.6" | "first-last" | "multi-reference" | "generic";
export interface VideoPromptTemplate {
  path: string;
  name: string;
  type: "video";
  data: string;
  family: VideoTemplateFamily;
  builtin: boolean;
  deletable: boolean;
}
export interface VideoPromptBinding { path?: string | null; fileName?: string | null }
const builtins: Record<string, VideoTemplateFamily> = {
  "minimaxH3Multi-referenceMode": "minimax-h3-ref2va",
  "seedance2Multi-parameterMode": "seedance2",
  "wan2.6Single-imageFirstFrameMode": "wan2.6",
  "universalFirstAndLastFrameMode": "first-last",
  "universalMulti-parameterMode": "multi-reference",
};
const h3Sections = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
function safeName(name: string): string {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === "." || name === ".." || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    invalid("提示词名称只能是文件名，不能包含路径或特殊字符");
  }
  return name;
}
function relativeName(relativePath: string): string {
  if (typeof relativePath !== "string") invalid("请选择视频提示词文件");
  const match = /^video\/([^/]+)\.md$/.exec(relativePath.replace(/\\/g, "/"));
  if (!match) invalid("只能操作 video 目录下的视频提示词文件");
  return safeName(match[1]);
}
async function videoDirectory(root: string, create = false): Promise<string> {
  const directory = path.resolve(root, "video");
  if (create) await fs.mkdir(directory, { recursive: true });
  const [rootReal, directoryReal, stat] = await Promise.all([fs.realpath(root), fs.realpath(directory), fs.lstat(directory)]);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.relative(rootReal, directoryReal) !== "video") invalid("视频提示词目录无效");
  return directoryReal;
}
async function existingFile(root: string, name: string): Promise<string> {
  const directory = await videoDirectory(root);
  const file = path.join(directory, `${safeName(name)}.md`);
  try {
    const [stat, real] = await Promise.all([fs.lstat(file), fs.realpath(file)]);
    if (stat.isSymbolicLink() || !stat.isFile() || path.dirname(real) !== directory) invalid("视频提示词文件无效");
    return real;
  } catch (cause: any) {
    if (cause.code === "ENOENT") invalid("视频提示词文件不存在，请重新选择");
    throw cause;
  }
}
function templateRecord(name: string, data: string): VideoPromptTemplate {
  if (!data.trim()) invalid("提示词内容不能为空");
  const marker = /<!--\s*toonflow-video-template:\s*([\w.-]+)\s*-->/i.exec(data)?.[1] as VideoTemplateFamily | undefined;
  if (marker && !["minimax-h3-ref2va", "seedance2", "wan2.6", "first-last", "multi-reference", "generic"].includes(marker)) invalid("提示词的模型标记无效");
  // Windows filenames are case-insensitive; a case alias must retain the same
  // built-in protections and family instead of becoming a deletable custom file.
  const builtinName = Object.keys(builtins).find(key => key.toLowerCase() === name.toLowerCase());
  const builtinFamily = builtinName ? builtins[builtinName] : undefined;
  if (marker && builtinFamily && marker !== builtinFamily) invalid("内置提示词不能改成其他模型的规则，请另存为新提示词");
  const hasH3Sections = h3Sections.every(section => data.includes(`${section}:`));
  const family = marker || builtinFamily || (hasH3Sections ? "minimax-h3-ref2va" : "generic");
  if (family === "minimax-h3-ref2va" && (!hasH3Sections || !/<Subject\s+(?:N|\d+)>/.test(data) || !/<Picture\s+(?:N|\d+)>/.test(data))) {
    invalid("H3 多参考规则必须保留六个章节以及 Subject、Picture 引用格式");
  }
  return { path: `video/${name}.md`, name, type: "video", data, family, builtin: Boolean(builtinFamily), deletable: !builtinFamily };
}
export function parseVideoPromptTemplate(name: string, data: string): VideoPromptTemplate { return templateRecord(safeName(name), data); }
export async function readVideoPromptTemplate(root: string, relativePath: string): Promise<VideoPromptTemplate> {
  const name = relativeName(relativePath);
  return templateRecord(name, await fs.readFile(await existingFile(root, name), "utf8"));
}
export async function listVideoPromptTemplates(root: string): Promise<VideoPromptTemplate[]> {
  const directory = await videoDirectory(root);
  const files = await fs.readdir(directory, { withFileTypes: true });
  return Promise.all(files.filter(file => file.isFile() && file.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name)).map(file => readVideoPromptTemplate(root, `video/${file.name}`)));
}
export async function writeVideoPromptTemplate(root: string, input: { name: string; data: string; type: string }, create: boolean): Promise<VideoPromptTemplate> {
  if (input.type !== "video") invalid("这里只能管理视频模型提示词");
  const name = safeName(input.name);
  const record = templateRecord(name, input.data);
  const directory = await videoDirectory(root, create);
  const file = create ? path.join(directory, `${name}.md`) : await existingFile(root, name);
  try {
    if (create) await fs.writeFile(file, input.data, { encoding: "utf8", flag: "wx" });
    else await fs.writeFile(file, input.data, "utf8");
  } catch (cause: any) {
    if (cause.code === "EEXIST") invalid("同名提示词已存在，请换一个名称");
    throw cause;
  }
  return record;
}
export async function deleteVideoPromptTemplate(root: string, relativePath: string): Promise<void> {
  const record = await readVideoPromptTemplate(root, relativePath);
  if (!record.deletable) invalid("内置默认规则需要保留，可以编辑或另存为新提示词");
  await fs.unlink(await existingFile(root, record.name));
}
export function getVideoTemplateFamily(modelName: string): VideoTemplateFamily {
  const model = String(modelName || "").toLowerCase();
  if (model.includes("minimax") && model.includes("h3")) return "minimax-h3-ref2va";
  if (/seedance.*2[.\-]0/i.test(model)) return "seedance2";
  if (model.includes("wan") && model.includes("2.6")) return "wan2.6";
  return "generic";
}
export function assertVideoTemplateCompatible(template: VideoPromptTemplate, modelName: string, modes?: unknown[]): void {
  const family = getVideoTemplateFamily(modelName);
  if (family === "minimax-h3-ref2va" && template.family !== family) invalid("H3 多参考模型需要使用 H3 专用提示词规则");
  if (family !== "generic" && template.family !== family && template.family !== "generic") invalid("该提示词适用于其他模型，请选择当前模型的规则");
  if (family === "generic" && ["minimax-h3-ref2va", "seedance2", "wan2.6"].includes(template.family)) invalid("该提示词适用于其他模型，请选择通用规则");
  if (modes?.length && template.family === "first-last" && !modes.some(mode => ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(mode)))) invalid("该模型不支持首尾帧规则，请选择多参考或通用规则");
  if (modes?.length && template.family === "multi-reference" && !modes.some(mode => Array.isArray(mode) || /^\s*\[/.test(String(mode)))) invalid("该模型不支持多参考规则，请选择首尾帧或通用规则");
}
export function getDefaultVideoPromptPath(modelName: string, mode: string): string | null {
  const family = getVideoTemplateFamily(modelName);
  if (family === "minimax-h3-ref2va" && /^\s*\[/.test(mode)) return "video/minimaxH3Multi-referenceMode.md";
  if (family === "seedance2") return "video/seedance2Multi-parameterMode.md";
  if (family === "wan2.6") return "video/wan2.6Single-imageFirstFrameMode.md";
  if (["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) return "video/universalFirstAndLastFrameMode.md";
  if (/^\s*\[/.test(mode)) return "video/universalMulti-parameterMode.md";
  return null;
}
export async function resolveVideoPromptTemplate(root: string, modelName: string, mode: string, binding?: VideoPromptBinding | null): Promise<VideoPromptTemplate | null> {
  const selected = binding?.path || getDefaultVideoPromptPath(modelName, mode);
  if (!selected) return null;
  const record = await readVideoPromptTemplate(root, selected);
  if (binding?.fileName && binding.fileName !== record.name) invalid("已绑定的提示词名称与文件不一致，请重新选择");
  assertVideoTemplateCompatible(record, modelName);
  return record;
}
export async function evaluateVideoPromptBinding(root: string, modelName: string, binding?: VideoPromptBinding | null, mode = "") {
  try {
    const record = await resolveVideoPromptTemplate(root, modelName, mode, binding);
    return { effectivePath: record?.path || "", effectiveName: record?.name || "通用视频规则", bindingStatus: binding?.path ? "bound" : record ? "default" : "common" } as const;
  } catch (cause: any) {
    return { effectivePath: "", effectiveName: "需要重新选择", bindingStatus: "invalid", bindingError: cause.message } as const;
  }
}
