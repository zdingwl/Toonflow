/** 分镜表按场合并。只接受单场、完整的 Markdown；不按文案相似度去重。 */
export interface StoryboardTableProgress {
  taskId: string;
  total: number;
  revision: number;
  scenes: Record<string, string>;
  complete: boolean;
}

export function renderStoryboardScenes(scenes: Record<string, string>): string {
  return Object.keys(scenes)
    .map(Number)
    .sort((a, b) => a - b)
    .map((number) => scenes[String(number)])
    .join("\n\n");
}

export function mergeStoryboardScene(
  previousTable: string,
  previous: StoryboardTableProgress | undefined,
  taskId: string,
  sceneIndex: number,
  total: number,
  markdown: string,
): { storyboardTable: string; storyboardTableProgress: StoryboardTableProgress; savedScenes: number[]; missingScenes: number[] } {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(taskId)) throw new Error("分镜任务标识无效");
  if (!Number.isSafeInteger(sceneIndex) || !Number.isSafeInteger(total) || sceneIndex < 1 || total < sceneIndex || total > 1000) {
    throw new Error("场次或总场次数无效");
  }
  const scene = markdown.trim();
  if (!scene || scene.length > 60000 || /<\/?storyboardTable\b/i.test(scene)) throw new Error("单场内容为空、过长或包含嵌套 XML 标签");
  const headings = [...scene.matchAll(/^##\s*场\s*(\d+)\s*[：:]/gm)];
  if (headings.length !== 1 || Number(headings[0][1]) !== sceneIndex || headings[0].index !== 0) {
    throw new Error(`单场分镜必须以“## 场${sceneIndex}：”开头，且不能包含其他场次`);
  }
  if (previous) {
    if (previous.taskId !== taskId || previous.total !== total) throw new Error("任务标识或总场次数与已保存的分镜表不一致");
    if (previousTable !== renderStoryboardScenes(previous.scenes)) throw new Error("分镜表已被人工修改，停止自动合并以保护现有内容");
  } else if (previousTable.trim()) {
    throw new Error("工作区已有分镜表；请先确认或清空旧版内容，不能自动覆盖");
  }
  const scenes = { ...(previous?.scenes ?? {}) };
  if (scenes[String(sceneIndex)] && scenes[String(sceneIndex)] !== scene) {
    throw new Error(`场${sceneIndex}已保存且内容不同，不能自动覆盖；请人工核对后再处理`);
  }
  const changed = !scenes[String(sceneIndex)];
  scenes[String(sceneIndex)] = scene;
  const savedScenes = Object.keys(scenes).map(Number).sort((a, b) => a - b);
  const missingScenes = Array.from({ length: total }, (_, i) => i + 1).filter((number) => !scenes[String(number)]);
  return {
    storyboardTable: renderStoryboardScenes(scenes),
    storyboardTableProgress: { taskId, total, scenes, revision: (previous?.revision ?? 0) + (changed ? 1 : 0), complete: missingScenes.length === 0 },
    savedScenes,
    missingScenes,
  };
}
