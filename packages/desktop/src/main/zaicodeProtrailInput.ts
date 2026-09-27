import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app, screen } from "electron";
import {
  ZAICODE_PROTRAIL_INPUT_MOVE,
  parseZaicodeProtrailInputLine,
  type ZaicodeProtrailInputEvent,
} from "@zcode/shared";
import { ZAICODE_PROTRAIL_INPUT_CS } from "./zaicodeProtrailInputSource.js";

/**
 * Where the desktop-wide ProTrail reads the mouse (SRC-062).
 *
 * - raw-input (Windows): ProTrail's own source, a Raw Input sink in a tiny
 *   helper process. Sees every move and every left/right/middle transition
 *   anywhere on the desktop and never hooks or delays input. Positions are
 *   physical pixels.
 * - cursor-poll (fallback): Electron's cursor position, read while the mode
 *   is on. Moves only, so the trail works but clicks, holds and the wake do
 *   not. Positions are DIP.
 */

export interface ZaicodeProtrailInput {
  kind: "raw-input" | "cursor-poll";
  stop(): void;
}

export interface ZaicodeProtrailInputCallbacks {
  onEvent(event: ZaicodeProtrailInputEvent): void;
  /** raw-input: the helper registered its sink and is delivering. */
  onReady?(): void;
  /** raw-input: the helper could not start or died; called once per helper. */
  onFailure?(reason: string): void;
}

const HELPER_PREFIX = "zaicode-protrail-input-";
const CURSOR_POLL_MS = 8;

function cscPath(): string | null {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = join(root, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let building: Promise<string> | null = null;

/** The helper's exe: compiled once per source version with Windows' own csc.exe, cached in the user data folder. */
export function ensureZaicodeProtrailInputHelper(): Promise<string> {
  building ??= buildHelper().catch((error: unknown) => {
    building = null;
    throw error;
  });
  return building;
}

async function buildHelper(): Promise<string> {
  const hash = createHash("sha256").update(ZAICODE_PROTRAIL_INPUT_CS).digest("hex").slice(0, 12);
  const dir = join(app.getPath("userData"), "zaicode-protrail");
  const exe = join(dir, `${HELPER_PREFIX}${hash}.exe`);
  if (existsSync(exe)) return exe;
  const csc = cscPath();
  if (!csc) throw new Error("the Windows C# compiler (.NET Framework 4 csc.exe) was not found");
  mkdirSync(dir, { recursive: true });
  // An older helper (an earlier source version) is dead weight now.
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(HELPER_PREFIX) || name.includes(hash)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Still running somewhere; the next start cleans it.
    }
  }
  const source = join(dir, `${HELPER_PREFIX}${hash}.cs`);
  const staged = join(dir, `build-${process.pid}-${hash}.exe`);
  writeFileSync(source, ZAICODE_PROTRAIL_INPUT_CS, "utf8");
  await new Promise<void>((resolve, reject) => {
    execFile(
      csc,
      ["/nologo", "/target:winexe", "/optimize+", "/platform:anycpu", "/r:System.Windows.Forms.dll", `/out:${staged}`, source],
      { timeout: 60_000, windowsHide: true },
      (error, stdout) => {
        if (error) reject(new Error(`csc.exe failed: ${String(stdout || error.message).trim().slice(0, 400)}`));
        else resolve();
      },
    );
  });
  renameSync(staged, exe);
  return exe;
}

export function startZaicodeProtrailRawInput(exe: string, callbacks: ZaicodeProtrailInputCallbacks): ZaicodeProtrailInput {
  const child = spawn(exe, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  let stopped = false;
  let failed = false;
  const fail = (reason: string) => {
    if (stopped || failed) return;
    failed = true;
    callbacks.onFailure?.(reason);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line === "ready") {
      callbacks.onReady?.();
      return;
    }
    if (line.startsWith("error")) {
      fail(`the input helper could not register for mouse input (${line})`);
      return;
    }
    const event = parseZaicodeProtrailInputLine(line);
    if (event) callbacks.onEvent(event);
  });
  child.stdin.on("error", () => undefined);
  child.on("error", (error) => fail(`the input helper did not start (${error.message})`));
  child.on("exit", (code) => fail(`the input helper exited (code ${String(code)})`));
  return {
    kind: "raw-input",
    stop() {
      stopped = true;
      lines.close();
      // Closing stdin is the helper's exit signal; kill covers a stuck one.
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    },
  };
}

export function startZaicodeProtrailCursorPoll(callbacks: ZaicodeProtrailInputCallbacks): ZaicodeProtrailInput {
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  const timer = setInterval(() => {
    const point = screen.getCursorScreenPoint();
    if (point.x === lastX && point.y === lastY) return;
    lastX = point.x;
    lastY = point.y;
    callbacks.onEvent({ kind: ZAICODE_PROTRAIL_INPUT_MOVE, button: -1, x: point.x, y: point.y, t: performance.now() });
  }, CURSOR_POLL_MS);
  return {
    kind: "cursor-poll",
    stop() {
      clearInterval(timer);
    },
  };
}
