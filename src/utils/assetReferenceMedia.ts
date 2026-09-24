import sharp from "sharp";
import oss from "@/utils/oss";
import crypto from "node:crypto";

export type AssetReferenceMedia = {
  path: string;
  label: string;
  sourceType: "assets";
  assetType: "role";
  fileType: "image";
  referenceType?: "imageReference";
  prompt?: string;
};

/** Create stable H3 identity references from the canonical four-panel role board. */
export async function ensureRoleReferenceMedia(
  sourcePath: string,
  name: string,
): Promise<AssetReferenceMedia[]> {
  const source = await oss.getFile(sourcePath);
  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 4 || height < 4) return [];
  const panelWidth = Math.floor(width / 4);
  const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "role";
  const base = sourcePath.replace(/^[/\\]+/, "").replace(/\.[^.]+$/u, "");
  const facePath = `${base}.reference-${safeName}-face.png`;
  const fullBodyPath = `${base}.reference-${safeName}-full-body.png`;
  const face = await sharp(source).extract({ left: 0, top: 0, width: panelWidth, height }).png().toBuffer();
  const fullBody = await sharp(source)
    .extract({ left: panelWidth, top: 0, width: panelWidth, height })
    .png()
    .toBuffer();
  await oss.writeFile(facePath, face);
  await oss.writeFile(fullBodyPath, fullBody);
  return [
    { path: facePath, label: `${name}脸部身份参考`, sourceType: "assets", assetType: "role", fileType: "image" },
    { path: fullBodyPath, label: `${name}正面全身参考`, sourceType: "assets", assetType: "role", fileType: "image" },
  ];
}

export async function roleReferenceFingerprint(sourcePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await oss.getFile(sourcePath)).digest("hex");
}
