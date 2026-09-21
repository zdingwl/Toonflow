import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(path.join(root, "scripts/main.ts"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const vite = readFileSync(path.join(root, "Toonflow-web-master/vite.config.ts"), "utf8");

test("打包版每次启动都刷新 web 和 serve 运行时代码，不能被同版本号缓存", () => {
  assert.match(main, /const RUNTIME_ENTRIES = new Set\(\["serve", "web"\]\)/);
  assert.match(main, /if \(shouldForceReplace \|\| RUNTIME_ENTRIES\.has\(dir\)\)/);
  assert.match(main, /fs\.rmSync\(targetDir, \{ recursive: true, force: true \}\)/);
  assert.match(main, /copyDir\(path\.join\(srcDir, dir\), targetDir\)/);
});


test("根目录 yarn build 必须同时重建前端到 data/web，不能只重建后端 bundle", () => {
  assert.equal(pkg.scripts["build"], "yarn build:web && yarn build:backend");
  assert.match(pkg.scripts["build:web"], /--cwd Toonflow-web-master install --frozen-lockfile/);
  assert.match(pkg.scripts["build:web"], /--cwd Toonflow-web-master build-only/);
  assert.match(vite, /outDir:\s*"\.\.\/data\/web"/);
  assert.match(vite, /emptyOutDir:\s*true/);
});
