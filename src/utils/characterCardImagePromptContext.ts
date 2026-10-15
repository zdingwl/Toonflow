import type { AssetPromptContext } from "./assetPromptGeneration";
import { characterVisualFields, type CharacterCard } from "./characterCards";

export function buildCharacterCardImagePromptContext(card: CharacterCard): AssetPromptContext {
  const describe = characterVisualFields.map(field => `${field}: ${card.visualDesign[field]}`).join("\n");
  return {
    input: { projectId: card.sourceProjectId || 0, assetsId: card.id, type: "role", name: card.name, describe },
    asset: { id: card.id, name: card.name, describe, descriptionVersion: card.version, imageId: card.imageId,
      imageDescriptionVersion: card.imageNeedsRegeneration ? card.version - 1 : card.version,
      descriptionMeta: JSON.stringify({ visualDesign: card.visualDesign, changedFields: [...characterVisualFields],
        userConstraints: `人物定义：${card.roleDefinition}；性别：${card.gender}；年龄段：${card.ageBand}；明确年龄范围：${card.ageMin ?? "未指定"}至${card.ageMax ?? "未指定"}。未知年龄不能编造精确数字或默认成年。六项外观设计为完整目标。` }) },
    parent: null, derivativeStates: [],
    references: card.imagePath ? [{ path: card.imagePath, role: "actualReference", label: `${card.name} 的原完整四视图；以当前六项设计为目标` }] : [],
  };
}
