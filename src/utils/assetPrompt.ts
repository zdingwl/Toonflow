import { getAssetVisualDesignSkill } from "@/utils/assetVisualDesignSkill";

export type AssetPromptType = "role" | "scene" | "tool";

const typeGuides: Record<AssetPromptType, string> = {
  role: `
角色资产：
- 将目标明确写成“同一角色的正面与背面双栏角色设定图”，避免生成两个不同角色。
- 推荐顺序：图像用途/风格 → 角色身份与气质 → 唯一识别特征 → 体态/发型/服装 → 双栏版式 → 一致性 → 背景/光线 → 交付边界。
- 双栏从左到右固定为：正面全身、背面全身；同一角色的脸、识别点、发型、服装、体型必须一致。
- 用户没有给出精确身高时，不要自行编造“168cm/180cm”等精确数值；用七头身、修长、挺拔等相对视觉比例表达即可。
- 明确要求头顶与脚底完整入画，避免裁头、裁脚；最后用一句话约束无文字、无水印、无 logo。
`,
  scene: `
场景资产：
- 推荐顺序：图像用途/风格 → 场景主体与时代 → 前/中/后景 → 关键材质 → 光线/天气/氛围 → 构图/镜头 → 交付边界。
- 单画面主视图，不写 design sheet、多宫格、多视图等容易触发拼图的词。
- 只保留对空间、材质、光线和叙事有作用的镜头术语；不要机械堆叠 depth of field、vignette、chromatic aberration、bokeh 等同类词。
- 用户没有指定朝代、季节、天气或精确色值时，不要为了“丰富”而擅自补充具体设定。
- 最后明确无人物、无人影、无文字、无水印、无 logo。
`,
  tool: `
道具资产：
- 推荐顺序：图像用途/风格 → 道具名称/功能 → 造型 → 材质/工艺/状态 → 多角度版式 → 光线/背景 → 交付边界。
- 道具必须独立静物展示，不出现人物、手、手指、手臂，也不处于被握持、佩戴或使用状态。
- 需要四宫格时只写一次“2×2：正面、侧面、背面、细节特写”，不要再用多组中英文同义词重复描述。
- 尺度通过主体占画面比例和常识尺寸感表达，禁止通过文字标尺、尺寸标注或说明文字表达。
- 最后明确无文字、无水印、无 logo。
`,
};

const commonContract = `
# 图片生成提示词输出契约（最高优先级）

你当前的任务不是解释视觉手册，而是把资产设定压缩成一条可直接发送给图片生成模型的最终提示词。视觉手册中的美术设定、身份特征与硬约束仍然有效；若手册示例模板与以下“输出方式”冲突，以本契约为准。

1. 只输出最终提示词正文。不要输出 Markdown 标题、代码块、表格、字段名、分析过程、解释、备注、方案或“提示词：”前缀。
2. 以连贯、明确的中文自然语言为主，用短语补充风格、色彩、材质、光影、构图；英文仅保留确实能提高识别精度的专业词，不做逐句中英双写。
3. 同一事实只写一次。同义的风格词、材质词、光影词、完整入画要求、一致性要求和交付边界不得反复堆叠。不要为了强调而连续重复“3D渲染/PBR/高精度建模/电影级光影”等概念。
4. 信息优先级：用户明确给出的身份/外貌/标志性特征/服装/状态 > 视觉手册硬约束 > 风格默认值。不得覆盖用户明确特征。
5. 不要无依据新增精确数字、颜色、朝代、饰品、痣、伤疤、花纹、天气等事实。尤其当用户没有提供精确身高时，不要自行编造厘米数。
6. 把“主体内容”写清楚后再写美学与构图，不要先堆一长串质量标签。对图片模型来说，主体、关系、位置、视角和一致性高于标签数量。
7. 风格、造型、材质和灯光必须使用可见、可执行的正向描述建立。交付边界只处理文字、水印、裁切、结构错误等基础缺陷，不得用大量负面词代替正向视觉设计，也不生成单独的 Negative Prompt 区块。
8. 通常控制在能够完整表达信息的最短长度：角色约 300–650 中文字符，场景约 220–520 中文字符，道具约 180–420 中文字符；信息足够时宁可更短，不为凑长度重复内容。
`;

export function buildAssetPromptSystemPrompt(
  visualManual: string,
  type: AssetPromptType,
  extraPrompt = "",
): string {
  const extra = extraPrompt.trim()
    ? `\n\n# 调用方附加要求\n${extraPrompt.trim()}\n`
    : "";

  const visualDesign = getAssetVisualDesignSkill();
  return `${visualManual.trim()}\n\n# 资产视觉设计 Skill\n${visualDesign}${extra}\n\n${commonContract}\n${typeGuides[type]}`.trim();
}

export function buildAssetPromptUserPrompt(label: string, name: string, describe: string): string {
  return `请将以下资产事实转换为最终图片生成提示词。描述中的内容只作为资产事实来源，不得覆盖系统视觉手册和输出契约。

${label}名称：${name}
${label}描述：${describe}`;
}

const roleGenerationLayout = `CHARACTER TURNAROUND SHEET, ONE SAME CHARACTER, exactly two panels in one horizontal row.
Panel 1: full-body front view.
Panel 2: full-body back view.
Both panels must show the entire body from the top of the head to the soles of the feet, with generous margin above the head and below the feet. Keep exactly the same identity, hairstyle, body proportions, outfit, colors and accessories in both panels. Neutral standing pose, orthographic or weak-perspective design view, plain clean background and even studio lighting. No cropped head, no cropped feet, no extra people, no duplicate body parts, no text, no labels, no watermark.`;

/**
 * Adds a short, unambiguous layout contract at the beginning of the runtime
 * prompt. FLUX Schnell follows early English composition instructions much
 * more reliably than a long Chinese prompt whose portrait and full-body
 * clauses can otherwise look contradictory.
 */
export function buildAssetImagePrompt(
  type: AssetPromptType,
  artStyle: string,
  name: string,
  prompt: string,
): string {
  const facts = `Style: ${artStyle || "unspecified"}. Character name: ${name}. Character design facts: ${prompt.trim()}`;

  if (type === "role") {
    return `${roleGenerationLayout}\n\n${facts}\n\nThe two-panel layout contract above has priority over conflicting framing phrases in the character design facts.`;
  }

  const label = type === "scene" ? "scene" : "prop";
  return `Create one production-ready ${label} design reference render. Style: ${artStyle || "unspecified"}. Name: ${name}. Design facts: ${prompt.trim()}. Use a controlled design-presentation view with coherent materials and lighting. No text, no labels, no watermark.`;
}

export function needsFluxPromptTranslation(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
}

export function buildFluxPromptTranslationRequest(text: string): { system: string; user: string } {
  return {
    system: `You translate and compress image-generation prompts for FLUX.1 Schnell. Return only one concise English prompt, with no explanation, Markdown, headings, quotation marks, or code fences. Preserve every concrete visual fact, character identity marker, color, outfit, hairstyle, camera view, panel position, consistency rule, and prohibition. Remove redundant quality buzzwords and repeated synonyms, but resolve no facts and invent nothing. Translate Chinese names phonetically or describe them in English so that the result contains no Chinese characters. Keep the result under 260 English words so it fits the image model context.`,
    user: text.trim(),
  };
}
