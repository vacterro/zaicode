import { closeSync, existsSync, openSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withZaicodeEnv, assertZaicodeEnv } from "./zaicode-env.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zaicodeEnv = withPinnedNodePath(withZaicodeEnv(process.env), process.execPath);
assertZaicodeEnv(zaicodeEnv);

const extra = process.argv.slice(2);
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

// 上游 bundle 默认 mac/arm64；ZAICODE 是本机产物，未显式指定时按当前主机打包。
const hostOs = { win32: "win", darwin: "mac", linux: "linux" }[process.platform] ?? "linux";
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const hasTarget = (flags) =>
  extra.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
const targetArgs = [
  ...(hasTarget(["--os", "-o"]) || zaicodeEnv.ZCODE_TARGET_OS ? [] : ["--os", hostOs]),
  ...(hasTarget(["--arch", "-a"]) || zaicodeEnv.ZCODE_TARGET_ARCH ? [] : ["--arch", hostArch]),
];

// 运行中的 ZAICODE.exe 会锁住 dist/win-unpacked；此时改为打包到 dist-next（staged），
// 由根目录 ZAICODE.exe 启动器在下次启动、应用未运行时原子替换。不需要为打包关掉应用。
function isLockedByRunningApp(exePath) {
  if (!isWin || !existsSync(exePath)) return false;
  try {
    closeSync(openSync(exePath, "r+"));
    return false;
  } catch (error) {
    return error?.code === "EBUSY" || error?.code === "EPERM";
  }
}
const liveExe = resolve(repoRoot, "packages/desktop/dist/win-unpacked/ZAICODE.exe");
const bundleEnv = { ...zaicodeEnv };
if (!bundleEnv.ZCODE_DESKTOP_DIST_DIR && isLockedByRunningApp(liveExe)) {
  bundleEnv.ZCODE_DESKTOP_DIST_DIR = "dist-next";
  console.log(
    "[bundle:zaicode] ZAICODE is running -> staging into packages/desktop/dist-next; " +
      "the root ZAICODE.exe launcher swaps it in on the next start.",
  );
}

await run(
  pnpmExec,
  ["--filter", "@zcode/desktop", "run", "bundle", "--", ...targetArgs, ...extra],
  bundleEnv,
);
