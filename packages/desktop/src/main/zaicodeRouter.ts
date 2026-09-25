import { shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { zaicodeRouterBaseUrl, zaicodeRouterCliToken, zaicodeRouterDataDir } from "./zaicodeRouterTransport.js";

export { callZaicodeRouter } from "./zaicodeRouterTransport.js";

/** 9router_extra's upgrade script; ZAICODE_ROUTER_EXTRA_UPDATE overrides the operator's default location. */
const EXTRA_UPDATE_SCRIPT =
  process.env.ZAICODE_ROUTER_EXTRA_UPDATE || String.raw`V:\___VAC\__K\__CODE\_PY\_9router_extra\apply-update.ps1`;

/**
 * ZAICODE Router, main-process half: talks to the operator's local 9router
 * with 9router's own CLI credential (sha256 of the machine id, the CLI salt
 * and the per-install secret, the value 9router's CLI sends as
 * `x-9r-cli-token`), only for the allow-listed calls in @zcode/shared. The
 * token is computed here and never crosses into the renderer.
 */

export interface ZaicodeRouterInfo {
  url: string;
  dataDir: string;
  installed: boolean;
  credential: boolean;
  extraUpdateScript: string | null;
}

export function getZaicodeRouterInfo(): ZaicodeRouterInfo {
  const dataDir = zaicodeRouterDataDir();
  return {
    url: zaicodeRouterBaseUrl(),
    dataDir,
    installed: existsSync(dataDir),
    credential: zaicodeRouterCliToken() !== null,
    extraUpdateScript: existsSync(EXTRA_UPDATE_SCRIPT) ? EXTRA_UPDATE_SCRIPT : null,
  };
}

/** Starts 9router in tray mode (`9router -t --skip-update`), the way 9router_extra's update does. */
export function startZaicodeRouter(): { ok: boolean; message: string } {
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "9router -t --skip-update"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true, message: "Starting 9router (tray)…" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function openZaicodeRouterDashboard(page: string): Promise<{ ok: boolean; message: string }> {
  const safe = /^[a-z0-9/-]{0,60}$/.test(page) ? page : "";
  await shell.openExternal(`${zaicodeRouterBaseUrl()}/dashboard${safe ? `/${safe}` : ""}`);
  return { ok: true, message: "Opened the 9router dashboard" };
}

/**
 * 9router_extra's own upgrade (stop, safety backup, install the patched
 * package, restore state, relaunch) in a visible console, so the operator
 * sees every step and its verdict. ZAICODE adds nothing to it.
 */
export function runZaicodeRouterExtraUpdate(): { ok: boolean; message: string } {
  if (!existsSync(EXTRA_UPDATE_SCRIPT)) return { ok: false, message: `Not found: ${EXTRA_UPDATE_SCRIPT}` };
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", EXTRA_UPDATE_SCRIPT],
      { detached: true, stdio: "ignore", windowsHide: false },
    );
    child.unref();
    return { ok: true, message: "9router_extra update started in its own window" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
