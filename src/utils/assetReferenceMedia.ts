import oss from "@/utils/oss";
import crypto from "node:crypto";
import sharp from "sharp";

// Historical H3 plans retain these labels so they can be identified and rejected safely.
export type RoleReferenceKind = "FACE" | "FULL_BODY_FRONT" | "FULL_BODY_SIDE" | "FULL_BODY_BACK";

/** Validate and fingerprint the complete image without creating any derived files. */
export async function roleReferenceFingerprint(sourcePath: string): Promise<string> {
  const source = await oss.getFile(sourcePath);
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) throw new Error("完整人物图片不可读取");
  return crypto.createHash("sha256").update(source).digest("hex");
}
