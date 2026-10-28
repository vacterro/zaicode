import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withZaicodeEnv, assertZaicodeEnv } from "./zaicode-env.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { spawn } from "node:child_process";
import { quoteArgsForWindowsShell } from "./spawn-command.mjs";

const env2 = withPinnedNodePath(withZaicodeEnv(process.env), process.execPath);
assertZaicodeEnv(env2);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = ["--filter", "@zcode/desktop", "dev:runtime"];
const spawnArgs = process.platform === "win32" ? quoteArgsForWindowsShell(args) : args;

await new Promise((resolve2, reject) => {
  const child = spawn(pnpmCmd, spawnArgs, {
    cwd: repoRoot,
    env: env2,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("error", reject);
  child.on("exit", (code) => (code === 0 ? resolve2() : reject(new Error(`dev:zaicode exit ${code}`))));
});
