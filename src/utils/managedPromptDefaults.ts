import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

export const managedPromptTypes = ["eventExtraction", "scriptAssetExtraction", "videoPromptGeneration", "audioBindPrompt"] as const;
export type ManagedPromptType = typeof managedPromptTypes[number];
const names: Record<ManagedPromptType, string> = {
  eventExtraction: "事件提取", scriptAssetExtraction: "剧本资产提取", videoPromptGeneration: "视频提示词生成", audioBindPrompt: "音色绑定",
};

function defaultDirectory(): string {
  // Defaults are shipped with the application. User customization lives in
  // o_prompt.useData, so an old userData copy must never shadow a new release.
  if (typeof process.versions.electron !== "undefined") {
    const { app } = require("electron");
    if (app?.isPackaged) {
      const resources = (process as NodeJS.Process & { resourcesPath: string }).resourcesPath;
      return path.join(resources, "data", "modelPrompt", "system");
    }
  }
  return path.join(process.cwd(), "data", "modelPrompt", "system");
}

export function readManagedPrompt(type: ManagedPromptType, directory = defaultDirectory()): string {
  const data = fs.readFileSync(path.join(directory, `${type}.md`), "utf8").trim();
  if (!data) throw new Error(`${names[type]}默认提示词为空`);
  return data;
}

export function loadManagedPromptDefaults(directory?: string) {
  return managedPromptTypes.map(type => ({ name: names[type], type, data: readManagedPrompt(type, directory) }));
}

/** Defaults can evolve without overwriting edits made in prompt management. */
export async function syncManagedPromptDefaults(db: Knex, directory?: string): Promise<void> {
  const defaults = loadManagedPromptDefaults(directory);
  await db.transaction(async trx => {
    for (const value of defaults) {
      const existing = await trx("o_prompt").where({ type: value.type }).first();
      if (existing) await trx("o_prompt").where({ type: value.type }).update({ data: value.data });
      else await trx("o_prompt").insert(value);
    }
  });
}
