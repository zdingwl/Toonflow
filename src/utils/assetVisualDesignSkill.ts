import fs from "fs";
import getPath from "@/utils/getPath";

const skillPath = getPath(["skills", "asset_visual_design.md"]);

export function getAssetVisualDesignSkill(): string {
  if (!fs.existsSync(skillPath)) return "";
  return fs.readFileSync(skillPath, "utf-8").replace(/^---[\s\S]*?---\s*/u, "").trim();
}
