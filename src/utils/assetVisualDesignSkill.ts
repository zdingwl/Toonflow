import fs from "fs";
import getPath from "@/utils/getPath";

const skillPath = getPath(["skills", "asset_visual_design.md"]);

/** Default entity-discovery instructions are not repeated in the final design task. */
export function buildAssetExtractionTemplateContext(template?: { data?: string | null; useData?: string | null } | null) {
  return {
    discoverySystem: template?.useData || template?.data || "",
    designSystem: template?.useData || "",
  };
}

export function getAssetVisualDesignSkill(): string {
  if (!fs.existsSync(skillPath)) return "";
  return fs.readFileSync(skillPath, "utf-8").replace(/^---[\s\S]*?---\s*/u, "").trim();
}

/** Asset extraction needs design rules, while image layout/reference/output rules belong to drawing. */
export function buildAssetExtractionVisualDesignSkill(skill: string): string {
  const downstream = new Set(["先筛选资产，再补全设计", "已确认成年角色的绘制原型", "资产绘制与视频引用分工", "全局表现约束先于外观继承", "参考来源与目标状态", "输出验收与可追踪性"]);
  return skill.replace(/^---[\s\S]*?---\s*/u, "").split(/(?=^##[ \t]+\S)/m)
    .filter(section => !downstream.has(section.match(/^##[ \t]+([^\r\n]+)/u)?.[1].trim() || ""))
    .join("\n").trim();
}

export function getAssetExtractionVisualDesignSkill(): string {
  return buildAssetExtractionVisualDesignSkill(getAssetVisualDesignSkill());
}
