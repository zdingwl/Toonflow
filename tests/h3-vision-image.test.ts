import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prepareH3VisionImage } from "../src/utils/h3VisionImage";

test("oversized complete reference sheets keep their dimensions and all panels for the vision writer", async () => {
  const width = 2400, height = 1200;
  const sheet = Buffer.alloc(width * height * 3);
  const colors = [[230, 25, 30], [30, 210, 40], [35, 55, 220], [230, 205, 25]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3, color = colors[Math.floor(x / (width / 4))];
    for (let c = 0; c < 3; c++) sheet[offset + c] = color[c];
  }
  const original = await sharp(sheet, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(original.length > 7 * 1024 * 1024);
  const prepared = await prepareH3VisionImage("data:image/png;base64," + original.toString("base64"));
  assert.equal(prepared.mediaType, "image/jpeg");
  assert.ok(prepared.image.length < 7 * 1024 * 1024);
  const meta = await sharp(prepared.image).metadata();
  assert.equal(meta.width, width); assert.equal(meta.height, height);
  for (let i = 0; i < 4; i++) {
    const pixel = await sharp(prepared.image).extract({ left: i * 600 + 300, top: 600, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(colors[i].every((value, c) => Math.abs(value - pixel[c]) < 5), "panel " + i + " must remain in place");
  }
});

test("small supported references stay byte-identical and invalid image encodings fail", async () => {
  const original = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  assert.deepEqual((await prepareH3VisionImage("data:image/png;base64," + original.toString("base64"))).image, original);
  await assert.rejects(prepareH3VisionImage("not an image"), /编码无效/);
});
