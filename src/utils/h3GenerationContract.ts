import crypto from "node:crypto";
import u from "@/utils";
import { ensureRoleReferenceMedia, roleReferenceFingerprint } from "@/utils/assetReferenceMedia";
import { selectedH3Views, type H3RoleView, type H3ReferenceMode } from "@/utils/h3ReferenceSlots";
import { assertH3ActiveStates, assertH3PictureSlots } from "@/utils/h3VisualStateGuard";

export interface H3SourceItem {
  id: number;
  sources: string;
  reference?: boolean;
  fileType?: string;
  type?: string;
  h3ReferenceMode?: H3ReferenceMode;
  h3Views?: H3RoleView[];
  h3ShotView?: "front" | "side" | "back" | "turn" | "closeup";
}
export interface H3PlanOptions {
  h3ReferenceMode?: H3ReferenceMode;
  h3Views?: H3RoleView[];
  h3ShotView?: H3SourceItem["h3ShotView"];
}
export interface H3Picture {
  id: number;
  assetType: string;
  parentAssetId?: number | null;
  name: string;
  description: string;
  assetPrompt: string;
  path: string;
  view: H3RoleView | "ASSET";
  fingerprint: string;
  picture: number;
}
export interface H3ReferencePlan { pictures: H3Picture[]; digest: string; }

const isRole = (type: string) => type.toLowerCase() === "role" || type.toLowerCase() === "character";
const assetRank = (type: string) => isRole(type) ? 0 : /^(scene|environment)$/i.test(type) ? 1 : /^(tool|prop|creature)$/i.test(type) ? 2 : 3;

/**
 * This is the ONLY H3 reference resolver. Prompt and runtime MUST use the same
 * ordered sources and view settings; asset bytes are fingerprinted on both calls.
 * Storyboard images are text-only guidance and do not consume Picture positions.
 */
export async function prepareH3ReferencePlan(projectId: number, sourceItems: H3SourceItem[], options: H3PlanOptions = {}): Promise<H3ReferencePlan> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("H3 项目 ID 无效");
  const candidates = sourceItems.filter(item => item.sources === "assets" && item.reference !== false && item.fileType !== "audio" && item.fileType !== "video" && item.type !== "audioReference" && item.type !== "videoReference");
  const sourceAssets = await Promise.all(candidates.map(async item => {
    const asset = await u.db("o_assets")
      .where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_assets.id", "o_assets.assetsId as parentAssetId", "o_assets.type", "o_assets.name", "o_assets.describe", "o_assets.prompt", "o_image.filePath", "o_image.type as imageType")
      .first();
    if (!asset || !asset.filePath) throw new Error(`H3 素材 ${item.id} 缺失或不是当前项目有效图片；请重新生成提示词`);
    if (item.fileType === "audio" || item.fileType === "video" || asset.imageType === "audio" || asset.imageType === "video") {
      throw new Error(`H3 素材 ${item.id} 不是图片，不能占用 Picture 槽位`);
    }
    return { item, asset };
  }));
  assertH3ActiveStates(sourceAssets.map(({ asset }) => ({
    assetId: Number(asset.id), parentAssetId: asset.parentAssetId,
    assetType: String(asset.type || ""), name: asset.name, filePath: asset.filePath,
  })));
  sourceAssets.sort((left, right) => assetRank(left.asset.type || "") - assetRank(right.asset.type || ""));
  const pictures: H3Picture[] = [];
  for (const { item, asset } of sourceAssets) {
    const type = String(asset.type || "asset");
    const selected = isRole(type)
      ? selectedH3Views({
          h3ReferenceMode: item.h3ReferenceMode ?? options.h3ReferenceMode ?? "board",
          h3Views: item.h3Views ?? options.h3Views,
          h3ShotView: item.h3ShotView ?? options.h3ShotView,
        })
      : ["ASSET" as const];
    const media = isRole(type)
      ? await ensureRoleReferenceMedia(asset.filePath, asset.name || `角色${asset.id}`, selected as H3RoleView[])
      : [{ path: asset.filePath, label: asset.name || `资产${asset.id}` }];
    for (let index = 0; index < media.length; index++) {
      const reference = media[index];
      pictures.push({
        id: Number(asset.id), parentAssetId: asset.parentAssetId,
        assetType: type, name: reference.label, description: String(asset.describe || ""),
        assetPrompt: String(asset.prompt || ""), path: reference.path,
        view: selected[index], fingerprint: await roleReferenceFingerprint(reference.path), picture: pictures.length + 1,
      });
      if (pictures.length > 9) throw new Error(`H3 最多九张参考图；当前镜头需要 ${pictures.length} 张，请减少视图或主体`);
    }
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify(pictures.map(item => ({
    id: item.id, parentAssetId: item.parentAssetId, type: item.assetType,
    path: item.path, view: item.view, fingerprint: item.fingerprint, picture: item.picture,
  })))).digest("hex");
  return { pictures, digest };
}

const TOKEN = /^\[TOONFLOW-H3-REFERENCE-V1:([a-f0-9]{64})\]\s*\n/;
export function bindH3Prompt(prompt: string, plan: H3ReferencePlan): string {
  if (TOKEN.test(prompt)) throw new Error("H3 提示词已携带参考绑定，不能重复写入");
  return `[TOONFLOW-H3-REFERENCE-V1:${plan.digest}]\n${prompt}`;
}
export function verifyAndStripH3Prompt(prompt: string, plan: H3ReferencePlan): string {
  const match = prompt.match(TOKEN);
  if (!match) throw new Error("缺少 H3 参考图版本绑定；请重新生成视频提示词");
  if (match[1] !== plan.digest) throw new Error("H3 参考图、当前状态或视图选择已改变；请重新生成视频提示词，不能使用旧 Picture 编号");
  const clean = prompt.slice(match[0].length);
  assertH3PictureSlots(clean, plan.pictures.length);
  return clean;
}
