const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// 隔离快照没有 node_modules；只从调用方的已安装工具读取编译器，所有被测源码仍来自快照 cwd。
const toolRoot = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "the installed tool root must be explicit");
const esbuild = require(path.join(toolRoot, "node_modules/esbuild"));
assert.equal(esbuild.version, "0.27.7", "the oracle compiler version is pinned");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-t332-oracle-"));
const bundle = path.join(output, "native-oracle.cjs");
esbuild.buildSync({
  entryPoints: [path.resolve("zcode/apps/zcode-cli/packages/bootstrap/test/zaicodeT332ContinueHook.test.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  nodePaths: [path.join(toolRoot, "node_modules"), path.join(toolRoot, "apps/zcode-cli/packages/bootstrap/node_modules")],
  tsconfigRaw: { compilerOptions: { target: "ES2023", module: "ESNext" } },
  logLevel: "silent",
});
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", bundle], {
  cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 90000,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

