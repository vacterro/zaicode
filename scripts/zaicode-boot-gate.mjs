import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Boot gate for a freshly bundled ZAICODE.
 *
 * A build that cannot start must never sit where the launcher will swap it in:
 * Wave 3 staged a window that opened on "Cannot access 'Pr' before
 * initialization" while 765 unit tests and tsc were green. The packaged app is
 * started on a throw-away profile (verify-zaicode-boot.cjs) and has to reach a
 * mounted workspace shell. A staged build that fails is moved aside so the
 * launcher keeps the last good one; a live build that fails is reported loudly
 * (it cannot be un-applied) and the bundle exits non-zero either way.
 *
 * ZAICODE_SKIP_BOOT_SMOKE=1 skips the gate and says so.
 *
 * @returns {{ ok: boolean, action: "skipped" | "no-build" | "passed" | "rejected" | "failed-live" | "stuck", rejectedTo?: string }}
 */
export function runBootGate({
  repoRoot,
  distName,
  isWin,
  env,
  smoke = defaultSmoke,
  log = console,
  now = () => new Date(),
}) {
  if (!isWin) return { ok: true, action: "skipped" };
  if (env.ZAICODE_SKIP_BOOT_SMOKE === "1") {
    log.warn("[bundle:zaicode] ZAICODE_SKIP_BOOT_SMOKE=1: the boot gate did NOT run for this build.");
    return { ok: true, action: "skipped" };
  }
  const builtDir = resolve(repoRoot, "packages/desktop", distName, "win-unpacked");
  const builtExe = resolve(builtDir, "ZAICODE.exe");
  const parent = dirname(builtDir);
  // A crashed earlier gate can leave its hiding place behind; it is never applied, only in the way.
  rmSync(`${builtDir}.verifying`, { recursive: true, force: true, maxRetries: 3 });
  if (!existsSync(builtExe)) return { ok: true, action: "no-build" };

  // The launcher applies whatever sits at dist-next\win-unpacked once the installer's blockmap is
  // newer than the package, and the bundle has just written that blockmap. While the smoke runs the
  // build is hidden under another name, so a restart in this minute cannot pick up an untested build.
  const staged = distName !== "dist";
  const verifying = `${builtDir}.verifying`;
  let hidden = false;
  if (staged) {
    try {
      renameSync(builtDir, verifying);
      hidden = true;
    } catch (error) {
      log.warn(`[bundle:zaicode] could not hide the staged build while it is tested (${error.message}); testing it in place.`);
    }
  }
  const executable = hidden ? resolve(verifying, "ZAICODE.exe") : builtExe;
  // Windows still holds the folder for a moment after Electron quits (scanners, handles): retry the move.
  const move = (from, to) => {
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(from, to);
        return;
      } catch (error) {
        if (attempt >= 10) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      }
    }
  };

  const outDir = resolve(repoRoot, "..", ".zaicode", "smoke", "boot");
  mkdirSync(outDir, { recursive: true });
  log.log(`[bundle:zaicode] boot gate: starting ${executable} on a throw-away profile`);
  let result;
  try {
    result = smoke({ repoRoot, executable, outDir, env });
  } catch (error) {
    result = { status: null, error };
  }
  if (result.status === 0) {
    if (hidden) {
      try {
        move(verifying, builtDir);
      } catch (error) {
        log.error(
          `[bundle:zaicode] boot gate passed but the build could not be put back (${error.message}): rename ${verifying} to win-unpacked by hand.`,
        );
        return { ok: false, action: "stuck" };
      }
    }
    return { ok: true, action: "passed" };
  }

  if (!staged) {
    log.error(
      "[bundle:zaicode] boot gate FAILED on the live build: do not start it; screenshots are in .zaicode/smoke/boot.",
    );
    return { ok: false, action: "failed-live" };
  }
  for (const name of readdirSync(parent)) {
    if (name.startsWith("win-unpacked.rejected-")) {
      rmSync(resolve(parent, name), { recursive: true, force: true, maxRetries: 3 });
    }
  }
  const rejectedTo = `${builtDir}.rejected-${now().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  try {
    move(hidden ? verifying : builtDir, rejectedTo);
    log.error(
      `[bundle:zaicode] boot gate FAILED: the staged build was moved to ${rejectedTo}; the launcher keeps the last good build.`,
    );
    return { ok: false, action: "rejected", rejectedTo };
  } catch (error) {
    log.error(
      `[bundle:zaicode] boot gate FAILED and the staged build could not be moved aside (${error.message}): delete ${hidden ? verifying : builtDir} before the next start.`,
    );
    return { ok: false, action: "rejected" };
  }
}

function defaultSmoke({ repoRoot, executable, outDir, env }) {
  return spawnSync(
    process.execPath,
    [resolve(repoRoot, "packages/desktop/scripts/verify-zaicode-boot.cjs"), executable, "--out", outDir],
    { cwd: repoRoot, stdio: "inherit", timeout: 420_000, env },
  );
}
