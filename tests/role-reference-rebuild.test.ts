import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import express from "express";
import sharp from "sharp";
import { createHash } from "node:crypto";

test("complete board fingerprint validates the image and never writes derived files", async () => {
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  const localRequire = createRequire(process.cwd() + "/package.json"), mod = { exports: {} as any };
  const reads: string[] = [];
  const oss = {
    getFile: async (path: string) => { reads.push(path); return path === "board.png" ? png : Buffer.from("corrupt image"); },
    writeFile: async () => { throw new Error("Unexpected derived file write"); },
  };
  new Function("require", "module", "exports", transform(readFileSync("src/utils/assetReferenceMedia.ts", "utf8"), { transforms: ["typescript", "imports"] }).code)
    ((id: string) => id === "@/utils/oss" ? oss : localRequire(id), mod, mod.exports);
  assert.equal(await mod.exports.roleReferenceFingerprint("board.png"), createHash("sha256").update(png).digest("hex"));
  await assert.rejects(mod.exports.roleReferenceFingerprint("corrupt.png"));
  assert.deepEqual(reads, ["board.png", "corrupt.png"]);
});

test("retired reference rebuild endpoint returns 410 without accessing database or files", async () => {
  const localRequire = createRequire(process.cwd() + "/package.json");
  const mod = { exports: {} as any };
  const code = transform(readFileSync("src/routes/assetsGenerate/buildRoleReferences.ts", "utf8"), { transforms: ["typescript", "imports"] }).code;
  new Function("require", "module", "exports", code)((id: string) => {
    if (id === "@/lib/responseFormat") return { error: (message: string) => ({ message }) };
    if (id.startsWith("@/")) throw new Error("Retired endpoint must not load database or media utilities: " + id);
    return localRequire(id);
  }, mod, mod.exports);
  const app = express(); app.use(express.json()); app.use("/", mod.exports.default);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  try {
    for (const body of [{ projectId: 1, assetsId: 10, referenceLayout: "four_view" }, {}]) {
      const response = await fetch("http://127.0.0.1:" + (server.address() as any).port, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 410);
      assert.match((await response.json()).message, /已改用完整人物参考图/);
    }
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
