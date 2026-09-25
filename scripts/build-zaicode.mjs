import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withZaicodeEnv, assertZaicodeEnv } from "./zaicode-env.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const zaicodeEnv = withPinnedNodePath(withZaicodeEnv(process.env), process.execPath);
assertZaicodeEnv(zaicodeEnv);

const args = process.argv.slice(2);
const isWin = process.platform === "win32";
const pnpmExec = isWin ? "pnpm.cmd" : "pnpm";

async function run(cmd, cmdArgs, env2) {
  const { spawn } = await import("node:child_process");
  const { quoteArgsForWindowsShell } = await import("./spawn-command.mjs");
  const spawnArgs = isWin ? quoteArgsForWindowsShell(cmdArgs) : cmdArgs;
  await new Promise((resolve2, reject) => {
    const child = spawn(cmd, spawnArgs, {
      cwd: repoRoot,
      env: env2,
      stdio: "inherit",
      shell: isWin,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve2() : reject(new Error(`${cmd} exit ${code ?? signal}`)),
    );
  });
}

await run(pnpmExec, ["--filter", "@zcode/desktop", "build:no-runtime-assets", ...args], zaicodeEnv);
console.log("[build:zaicode] renderer+host build ok, flavor=zaicode identity=dev.zaicode.app");
