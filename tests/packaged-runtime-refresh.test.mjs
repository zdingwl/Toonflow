import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(path.join(root, "scripts/main.ts"), "utf8");

test("打包版每次启动都刷新 web 和 serve 运行时代码，不能被同版本号缓存", () => {
  assert.match(main, /const RUNTIME_ENTRIES = new Set\(\["serve", "web"\]\)/);
  assert.match(main, /if \(shouldForceReplace \|\| RUNTIME_ENTRIES\.has\(dir\)\)/);
  assert.match(main, /fs\.rmSync\(targetDir, \{ recursive: true, force: true \}\)/);
  assert.match(main, /copyDir\(path\.join\(srcDir, dir\), targetDir\)/);
});
