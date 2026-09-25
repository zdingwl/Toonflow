import u from "@/utils";

export type QualifiedAssetModel = `${string}:${string}`;
export const ROLE_FOUR_VIEW_MODEL: QualifiedAssetModel = "comfyui_qwen21_fourview:qwen-image-2.1-fourview-local";

export async function resolveAssetImageModel(requestedModel: string, type: string): Promise<QualifiedAssetModel> {
  if (type !== "role") {
    if (!requestedModel.includes(":")) throw new Error("图片模型标识无效");
    return requestedModel as QualifiedAssetModel;
  }
  const provider = await u.db("o_vendorConfig").where({ id: "comfyui_qwen21_fourview", enable: 1 }).select("models").first();
  if (!provider) throw new Error("人物四视图模型尚未启用，请重启服务完成模型配置迁移");
  const models = JSON.parse(provider.models || "[]");
  if (!models.some((item: any) => item.modelName === "qwen-image-2.1-fourview-local")) {
    throw new Error("人物四视图模型配置缺失，请在模型设置中检查 Qwen-Image-2.1 四视图供应商");
  }
  return ROLE_FOUR_VIEW_MODEL;
}

export function isRoleFourViewModel(model: string): boolean {
  return model === ROLE_FOUR_VIEW_MODEL;
}
