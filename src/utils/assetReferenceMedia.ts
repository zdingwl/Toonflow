import sharp from "sharp";
import oss from "@/utils/oss";
import crypto from "node:crypto";

export type RoleReferenceKind = "FACE" | "FULL_BODY_FRONT" | "FULL_BODY_SIDE" | "FULL_BODY_BACK";
export type RoleReferenceLayout = "auto" | "front_back" | "four_view";

export type AssetReferenceMedia = {
  path: string;
  label: string;
  sourceType: "assets";
  assetType: "role";
  fileType: "image";
  referenceKind: RoleReferenceKind;
  referenceType?: "imageReference";
  prompt?: string;
};

export interface PersistedRoleReferences {
  name?: string | null;
  faceReferencePath?: string | null;
  fullBodyReferencePath?: string | null;
  sideReferencePath?: string | null;
  backReferencePath?: string | null;
  referenceLayout?: string | null;
}

function referenceItem(path: string, name: string, kind: RoleReferenceKind, suffix: string): AssetReferenceMedia {
  return { path, label: `${name}${suffix}`, sourceType: "assets", assetType: "role", fileType: "image", referenceKind: kind };
}

/** Build single-view references from PORTRAIT/FRONT/SIDE/BACK or legacy FRONT/BACK boards. */
export async function ensureRoleReferenceMedia(
  sourcePath: string,
  name: string,
  requestedLayout: RoleReferenceLayout = "auto",
): Promise<AssetReferenceMedia[]> {
  const source = await oss.getFile(sourcePath);
  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 4 || height < 4) return [];

  const layout: Exclude<RoleReferenceLayout, "auto"> = requestedLayout === "auto"
    ? width / height >= 2.2 ? "four_view" : "front_back"
    : requestedLayout;
  const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "role";
  const base = sourcePath.replace(/^[/\\]+/, "").replace(/\.[^.]+$/u, "");
  const paths = {
    face: `${base}.reference-${safeName}-face.png`,
    front: `${base}.reference-${safeName}-full-body-front.png`,
    side: `${base}.reference-${safeName}-full-body-side.png`,
    back: `${base}.reference-${safeName}-full-body-back.png`,
  };

  if (layout === "four_view") {
    const panelWidth = Math.floor(width / 4);
    const lastWidth = width - panelWidth * 3;
    const [face, front, side, back] = await Promise.all([
      sharp(source).extract({ left: 0, top: 0, width: panelWidth, height }).png().toBuffer(),
      sharp(source).extract({ left: panelWidth, top: 0, width: panelWidth, height }).png().toBuffer(),
      sharp(source).extract({ left: panelWidth * 2, top: 0, width: panelWidth, height }).png().toBuffer(),
      sharp(source).extract({ left: panelWidth * 3, top: 0, width: lastWidth, height }).png().toBuffer(),
    ]);
    await Promise.all([
      oss.writeFile(paths.face, face), oss.writeFile(paths.front, front),
      oss.writeFile(paths.side, side), oss.writeFile(paths.back, back),
    ]);
    return [
      referenceItem(paths.face, name, "FACE", "脸部身份参考"),
      referenceItem(paths.front, name, "FULL_BODY_FRONT", "正面全身参考"),
      referenceItem(paths.side, name, "FULL_BODY_SIDE", "侧面全身参考"),
      referenceItem(paths.back, name, "FULL_BODY_BACK", "背面全身参考"),
    ];
  }

  const panelWidth = Math.floor(width / 2);
  const faceHeight = Math.max(1, Math.floor(height * 0.46));
  const [face, front, back] = await Promise.all([
    sharp(source).extract({ left: 0, top: 0, width: panelWidth, height: faceHeight }).png().toBuffer(),
    sharp(source).extract({ left: 0, top: 0, width: panelWidth, height }).png().toBuffer(),
    sharp(source).extract({ left: panelWidth, top: 0, width: width - panelWidth, height }).png().toBuffer(),
  ]);
  await Promise.all([
    oss.writeFile(paths.face, face), oss.writeFile(paths.front, front), oss.writeFile(paths.back, back),
  ]);
  return [
    referenceItem(paths.face, name, "FACE", "脸部身份参考"),
    referenceItem(paths.front, name, "FULL_BODY_FRONT", "正面全身参考"),
    referenceItem(paths.back, name, "FULL_BODY_BACK", "背面全身参考"),
  ];
}

export function roleReferenceDatabaseFields(references: AssetReferenceMedia[], layout: string): Record<string, string | null> {
  const byKind = new Map(references.map(item => [item.referenceKind, item.path]));
  return {
    faceReferencePath: byKind.get("FACE") ?? null,
    fullBodyReferencePath: byKind.get("FULL_BODY_FRONT") ?? null,
    sideReferencePath: byKind.get("FULL_BODY_SIDE") ?? null,
    backReferencePath: byKind.get("FULL_BODY_BACK") ?? null,
    referenceLayout: layout,
  };
}

export function requestedRoleReferenceKinds(prompt: string): RoleReferenceKind[] {
  const value = String(prompt || "").toLowerCase();
  const kinds: RoleReferenceKind[] = ["FACE", "FULL_BODY_FRONT"];
  if (/(侧面|侧身|侧脸|profile|side view|from the side)/i.test(value)) kinds.push("FULL_BODY_SIDE");
  if (/(背面|背影|背对|后背|back view|rear view|from behind)/i.test(value)) kinds.push("FULL_BODY_BACK");
  return kinds;
}

export function persistedRoleReferencesForVideo(asset: PersistedRoleReferences, prompt: string): AssetReferenceMedia[] {
  const name = asset.name || "角色";
  const paths: Record<RoleReferenceKind, string | null | undefined> = {
    FACE: asset.faceReferencePath,
    FULL_BODY_FRONT: asset.fullBodyReferencePath,
    FULL_BODY_SIDE: asset.sideReferencePath,
    FULL_BODY_BACK: asset.backReferencePath,
  };
  const suffix: Record<RoleReferenceKind, string> = {
    FACE: "脸部身份参考", FULL_BODY_FRONT: "正面全身参考",
    FULL_BODY_SIDE: "侧面全身参考", FULL_BODY_BACK: "背面全身参考",
  };
  return requestedRoleReferenceKinds(prompt).map(kind => {
    const path = paths[kind];
    if (!path) throw new Error(`${name}缺少${suffix[kind]}，请先在资产页重建四视图身份参考`);
    return referenceItem(path, name, kind, suffix[kind]);
  });
}

export async function roleReferenceFingerprint(sourcePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await oss.getFile(sourcePath)).digest("hex");
}
