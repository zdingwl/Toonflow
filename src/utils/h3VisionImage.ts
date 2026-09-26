import sharp from "sharp";

// Leave room for base64 expansion under the vision writer's 10 MiB input limit.
const maxVisionBytes = 7 * 1024 * 1024;

/** Encode a complete reference for the prompt writer; never crop panels or change the H3 asset. */
export async function prepareH3VisionImage(dataUrl: string): Promise<{ image: Buffer; mediaType: string }> {
  const encoded = /^data:(image\/[^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!encoded) throw new Error("H3 提示词参考图编码无效");
  const source = Buffer.from(encoded[2], "base64");
  if (source.length <= maxVisionBytes && ["image/jpeg", "image/png", "image/webp"].includes(encoded[1])) {
    return { image: source, mediaType: encoded[1] };
  }
  // Re-encode at the original resolution first to retain small faces and UI details.
  for (const quality of [92, 82, 72]) {
    const image = await sharp(source).rotate().flatten({ background: "#ffffff" }).jpeg({ quality, chromaSubsampling: "4:4:4" }).toBuffer();
    if (image.length <= maxVisionBytes) return { image, mediaType: "image/jpeg" };
  }
  for (const size of [4096, 3072, 2048]) {
    const image = await sharp(source).rotate().resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
    if (image.length <= maxVisionBytes) return { image, mediaType: "image/jpeg" };
  }
  throw new Error("H3 提示词参考图过大，无法在保留完整画面的情况下编码");
}
