const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

// 编译器来自显式安装路径；所有被测组件、夹具和本地依赖来自 SAIPEN 的隔离快照。
assert.ok(process.argv[2], "the installed tool root must be explicit");
const toolRoot = path.resolve(process.argv[2]);
const esbuild = require(path.join(toolRoot, "node_modules/esbuild"));
assert.equal(esbuild.version, "0.27.7", "the oracle compiler is pinned");
const testPath = path.resolve("zcode/packages/ui/test/zaicodeT334TerminalColors.test.ts");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-t334-oracle-"));
const bundle = path.join(output, "terminal-color-oracle.cjs");
esbuild.buildSync({
  entryPoints: [testPath], outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node24",
  define: { "import.meta.url": JSON.stringify(pathToFileURL(testPath).href) },
  alias: {
    "@/lib/memoryDiagnostics.js": path.resolve("zcode/packages/ui/src/lib/memoryDiagnostics.ts"),
    "@zcode/shared": path.resolve("zcode/packages/shared/src/index.ts"),
    "@zcode/model-option-map": path.resolve("zcode/packages/model-option-map/src/index.ts"),
  },
  nodePaths: [path.join(toolRoot, "node_modules")],
  tsconfigRaw: { compilerOptions: { target: "ES2023", module: "ESNext" } }, logLevel: "silent",
});
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", bundle], {
  cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 90000,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
