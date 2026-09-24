import sharp from "sharp";
import oss from "@/utils/oss";
import crypto from "node:crypto";
import { H3RoleView } from "@/utils/h3ReferenceSlots";

export type AssetReferenceMedia = {
  path: string;
  label: string;
  sourceType: "assets";
  assetType: "role";
  fileType: "image";
  referenceType?: "imageReference";
  prompt?: string;
};

const viewIndex: Record<Exclude<H3RoleView, "BOARD">, number> = { FACE: 0, FRONT: 1, SIDE: 2, BACK: 3 };
const viewName: Record<H3RoleView, string> = {
  BOARD: "完整四视图（同一人物）", FACE: "脸部身份", FRONT: "正面全身", SIDE: "90度侧面全身", BACK: "背面全身",
};

/**
 * The four-panel asset is manually approved by the user. Its canonical order is
 * FACE / FRONT / SIDE / BACK. BOARD keeps the original complete image as one
 * Picture; independent view extraction is available for angle-specific shots.
 */
export async function ensureRoleReferenceMedia(
  sourcePath: string,
  name: string,
  views: H3RoleView[] = ["BOARD"],
): Promise<AssetReferenceMedia[]> {
  if (!views.length || new Set(views).size !== views.length || views.some(v => !(v in viewName)) || views.includes("BOARD") && views.length > 1) {
    throw new Error("H3 参考视图设置无效");
  }
  const media = (path: string, view: H3RoleView): AssetReferenceMedia => ({
    path, label: `${name}·${viewName[view]}`, sourceType: "assets", assetType: "role", fileType: "image",
  });
  if (views[0] === "BOARD") return [media(sourcePath, "BOARD")];
  const source = await oss.getFile(sourcePath);
  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 4 || height < 4) throw new Error(`角色四视图尺寸无效：${name}`);
  const panelWidth = Math.floor(width / 4);
  const base = sourcePath.replace(/^[/\\]+/, "").replace(/\.[^.]+$/u, "");
  const fingerprint = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
  const output: AssetReferenceMedia[] = [];
  for (const view of views) {
    if (view === "BOARD") throw new Error("不能将完整四视图与独立视图混在同一次角色展开中");
    const destination = `${base}.h3-${fingerprint}-${view.toLowerCase()}.png`;
    const panel = await sharp(source)
      .extract({ left: viewIndex[view] * panelWidth, top: 0, width: panelWidth, height })
      .png().toBuffer();
    await oss.writeFile(destination, panel);
    output.push(media(destination, view));
  }
  return output;
}

export async function roleReferenceFingerprint(sourcePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await oss.getFile(sourcePath)).digest("hex");
}
