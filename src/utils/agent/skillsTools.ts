import { z } from "zod";
import { tool, jsonSchema } from "ai";
import path from "path";
import isPathInside from "is-path-inside";
import getPath from "@/utils/getPath";
import * as fs from "fs";
import fg from "fast-glob";

type SkillAttribution =
  //剧本Agent
  | "script_agent_decision" //决策
  | "script_execution_skeleton" //故事骨架
  | "script_execution_adaptation" //改变策略
  | "script_execution_script" //剧本生成
  | "script_agent_supervision" //审核
  //生产Agent
  | "production_agent_decision"
  | "production_agent_execution"
  | "production_agent_supervision";

interface SkillInput {
  mainSkill: SkillAttribution[];
  workspace?: string[];
  attachedSkills?: string[];
}

interface SkillPaths {
  mainSkill: { path: string; name: string; description: string }[];
  secondarySkills: string[];
  tertiarySkills: string[];
}

// A limit prevents an accidentally huge resource from exhausting the model context.
// Existing skills are much smaller; oversized files return an explicit error, never partial content.
const MAX_SKILL_FILE_BYTES = 256 * 1024;

function toUnixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function ensureNonEmptyBody(body: string, fallback: string): string {
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

// ==================== 解析 SKILL.md ====================

export function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match?.[1]) {
    throw new Error(`技能文件缺少有效的 frontmatter，确保以 --- 包裹并包含 name 和 description 字段。${content}`);
  }

  const result: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1].trim();
    const rawValue = (keyMatch[2] ?? "").trim();
    i++;

    if (!key) continue;

    if (/^[>|][+-]?[0-9]*$/.test(rawValue)) {
      const isFolded = rawValue.startsWith(">");
      const blockLines: string[] = [];
      let blockIndent: number | null = null;

      while (i < lines.length) {
        const current = lines[i];
        const currentTrimmed = current.trim();

        if (currentTrimmed === "") {
          if (blockIndent !== null) blockLines.push("");
          i++;
          continue;
        }

        const currentIndent = current.match(/^\s*/)?.[0].length ?? 0;
        if (blockIndent === null) {
          blockIndent = currentIndent;
        }

        if (currentIndent < blockIndent) break;

        blockLines.push(current.slice(blockIndent));
        i++;
      }

      result[key] = isFolded
        ? blockLines
            .join("\n")
            .replace(/\n{2,}/g, "\n\n")
            .replace(/([^\n])\n([^\n])/g, "$1 $2")
            .trim()
        : blockLines.join("\n").trim();
      continue;
    }

    const unquoted = rawValue.replace(/^(['"])([\s\S]*)\1$/, "$2");
    result[key] = unquoted;
  }

  if (!result.name || !result.description) {
    throw new Error(`技能文件缺少必要字段: name 或 description，确保 frontmatter 包含这两个字段。${content}`);
  }

  return { name: result.name, description: result.description };
}

export async function useSkill(input: SkillInput) {
  const { mainSkill, workspace = [], attachedSkills = [] } = input;
  const rootDir = getPath("skills");
  const normalizedRootDir = path.resolve(rootDir);

  const mainSkills: { path: string; name: string; description: string }[] = [];
  for (const skill of mainSkill) {
    const skillPath = path.join(rootDir, skill + ".md");
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    if (!isPathInside(skillPath, normalizedRootDir)) throw new Error(`技能名称无效：检测到路径穿越。${skillPath}`);
    const content = await fs.promises.readFile(skillPath, "utf-8");
    const parsed = parseFrontmatter(content);
    mainSkills.push({ path: skillPath, ...parsed });
  }

  const resolveSafeSkillDir = (dir: string): string | null => {
    const resolvedDir = path.resolve(normalizedRootDir, dir);
    const isSafeDir = resolvedDir === normalizedRootDir || isPathInside(resolvedDir, normalizedRootDir);
    return isSafeDir ? resolvedDir : null;
  };

  const getMdFiles = (dir: string, recursive = false): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) return [fullPath];
      return entry.isDirectory() && recursive ? getMdFiles(fullPath, true) : [];
    });
  };
  const collectMdFiles = (dirs: string[], recursive: boolean) =>
    dirs.flatMap((dir) => {
      const safeDir = resolveSafeSkillDir(dir);
      if (!safeDir) return [];
      return getMdFiles(safeDir, recursive).map((file) => toUnixPath(path.relative(normalizedRootDir, file)));
    });

  const skillPaths: SkillPaths = {
    mainSkill: mainSkills,
    secondarySkills: collectMdFiles(workspace, false),
    tertiarySkills: collectMdFiles(attachedSkills, true),
  };

  return { prompt: buildSkillPrompt(mainSkills), tools: createSkillTools(mainSkills, skillPaths), skillPaths };
}

export function buildSkillPrompt(skills: { name: string; description: string }[]): string {
  const skillEntries = skills
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
    .join("\n");
  return `## Skills
以下技能提供了专业任务的专用指令。
当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。
加载后遵循技能指令执行任务，需要时调用 read_skill_file 读取资源文件内容。

<available_skills>
${skillEntries}
</available_skills>`;
}

/**
 * 仅根据本次 Agent 已选中的画风/题材导演技能发现参考文件。
 * 列出路径而不提前读取正文，避免把其他画风的大量提示词注入模型上下文。
 * 保留仓库既有的 driector_skills 拼写，避免改动现有文件目录。
 */
function discoverSelectedStyleResources(mainSkills: SkillPaths["mainSkill"], skillsRootDir: string): string[] {
  const resources = new Set<string>();
  const addFile = (filePath: string) => {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      resources.add(toUnixPath(path.relative(skillsRootDir, filePath)));
    }
  };
  for (const skill of mainSkills) {
    const relativeSkill = toUnixPath(path.relative(skillsRootDir, path.resolve(skill.path)));
    const match = relativeSkill.match(/^(art_skills|story_skills)\/([^/]+)\/driector_skills\/[^/]+\.md$/);
    if (!match) continue;
    const [, category, selectedName] = match;
    const selectedDir = path.join(skillsRootDir, category, selectedName);
    addFile(path.join(selectedDir, "README.md"));
    if (category !== "art_skills") continue;
    addFile(path.join(selectedDir, "prefix.md"));
    const artPromptDir = path.join(selectedDir, "art_prompt");
    if (!fs.existsSync(artPromptDir) || !fs.statSync(artPromptDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(artPromptDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) addFile(path.join(artPromptDir, entry.name));
    }
  }
  return [...resources].sort();
}

export function createSkillTools(skills: { name: string; description: string }[], skillPaths: SkillPaths, rootDir: string = getPath("skills")) {
  const activated = new Set<string>(); // 仅记录成功加载的技能
  const skillsRootDir = path.resolve(rootDir);
  const skillNames = skills.map((s) => s.name);
  const skillMap = new Map(skillPaths.mainSkill.map((s) => [s.name, s]));
  const selectedStyleResources = discoverSelectedStyleResources(skillPaths.mainSkill, skillsRootDir);
  let selectedStyleResourcesAnnounced = false;
  let tertiaryResourcesAnnounced = false;
  return {
    activate_skill: tool({
      description: `激活一个技能，加载其完整指令和捆绑资源列表到上下文。可用技能：${skillNames.join(", ")}`,
      inputSchema: jsonSchema<{ name: string }>(
        z
          .object({
            name: (skillNames.length ? z.enum(skillNames as [string, ...string[]]) : z.string()).describe("要激活的技能名称"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ name }) => {
        if (activated.has(name)) {
          console.log(`⚡[主技能] ℹ️ 技能 "${name}" 已激活，跳过重复注入`);
          return { alreadyActive: true, message: `技能 "${name}" 已激活，无需重复加载` };
        }
        const matched = skillMap.get(name);
        if (!matched) return { error: `未找到技能 "${name}"` };
        let raw: string;
        try {
          const stat = await fs.promises.stat(matched.path);
          if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) {
            return { error: `技能文件无效或超过大小限制: ${matched.path}` };
          }
          raw = await fs.promises.readFile(matched.path, "utf-8");
          console.log(`⚡[主技能] ✓ 已读取主技能文件： ${matched.path}（${raw.length} 字符）`);
        } catch (error) {
          console.error(`⚡[主技能] ✗ 技能读取失败：${matched.path}`, error);
          return { error: `技能文件读取失败，请检查文件是否存在: ${matched.path}` };
        }
        const body = raw.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
        if (!body) return { error: `技能文件没有正文: ${matched.path}` };

        let content = `<skill_content name="${name}">\n`;
        content += body + "\n\n";
        content += "使用 read_skill_file 工具读取资源文件。\n";
        const resourcePaths = [
          ...skillPaths.secondarySkills,
          ...(selectedStyleResourcesAnnounced ? [] : selectedStyleResources),
        ];
        if (resourcePaths.length > 0) {
          content += "\n<skill_resources>\n";
          for (const resourcePath of new Set(resourcePaths)) {
            content += `  <file>${resourcePath}</file>\n`;
          }
          content += "</skill_resources>\n";
        }
        content += "</skill_content>";
        selectedStyleResourcesAnnounced = true;
        activated.add(name);
        console.log(`⚡[主技能] ✓ 技能 "${name}" 已激活`);
        return { content };
      },
    }),
    read_skill_file: tool({
      description: "读取技能目录下的资源文件。优先传入 activate_skill 返回的 skill_resources 中的相对路径。",
      inputSchema: jsonSchema<{ filePath: string }>(
        z
          .object({
            filePath: z.string().describe("资源文件相对于 skills 根目录的路径"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ filePath }) => {
        const normalizedInputPath = toUnixPath(filePath).trim();
        if (!normalizedInputPath) return { error: "filePath 不能为空" };
        if (path.isAbsolute(normalizedInputPath) || !normalizedInputPath.toLowerCase().endsWith(".md")) {
          return { error: "只允许读取技能目录下的 Markdown 相对路径" };
        }

        const fullPath = path.resolve(skillsRootDir, normalizedInputPath);
        if (!isPathInside(fullPath, skillsRootDir)) {
          console.log(`📖[技法文件] ✗ 路径越界已拦截："${filePath}" 超出技能目录范围`);
          return { error: "Access denied: path is outside skill directory" };
        }
        let body: string;
        try {
          // Resolve symbolic links before reading: a lexical prefix check alone is insufficient.
          const [realRoot, realFile] = await Promise.all([fs.promises.realpath(skillsRootDir), fs.promises.realpath(fullPath)]);
          if (!isPathInside(realFile, realRoot)) return { error: "Access denied: resource is outside skill directory" };
          const stat = await fs.promises.stat(realFile);
          if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) {
            return { error: `技能资源无效或超过大小限制: ${filePath}` };
          }
          body = await fs.promises.readFile(realFile, "utf-8");
          console.log(`📖[技法文件] ✓ 已读取文件： ${filePath}（${body.length} 字符）`);
        } catch (error) {
          console.error(`📖[技法文件] ✗ 读取失败：${filePath}`, error);
          return { error: `File not found or unreadable: ${filePath}` };
        }
        const safeBody = ensureNonEmptyBody(body, "该资源文件为空。");
        let content = "<skill_content>\n";
        content += safeBody + "\n\n";
        content += "可以使用 read_skill_file 工具读取资源文件。\n";
        // The old implementation repeated the entire resource index after every read.
        if (!tertiaryResourcesAnnounced && skillPaths.tertiarySkills.length > 0) {
          content += "\n<skill_resources>\n";
          for (const resourcePath of skillPaths.tertiarySkills) {
            content += `  <file>${resourcePath}</file>\n`;
          }
          content += "</skill_resources>\n";
          tertiaryResourcesAnnounced = true;
        }
        content += "</skill_content>";
        return { content };
      },
    }),
  };
}

export async function scanSkills(folderPath: string) {
  const unixPath = toUnixPath(folderPath);
  const entries = await fg(unixPath, {
    onlyFiles: true,
    absolute: true,
  });
  return entries;
}
