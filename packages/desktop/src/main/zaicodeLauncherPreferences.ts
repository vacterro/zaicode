import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initZaicodeSaimailWorkspace } from "./zaicodeSaimailInit.js";
import { runZaicodeSaimailPostAction } from "./zaicodeSaimailPost.js";
import {
  ZAICODE_SAIMAIL_DESK_ENV,
  DEFAULT_ZAICODE_SPLASH_OPTIONS,
  normalizeZaicodeSplashOptions,
  type ZaicodeSplashFit,
  type ZaicodeSplashOptions,
  type ZaicodeSplashScale,
  normalizeZaicodeScreenMode,
  type ZaicodeScreenMode,
} from "@zcode/shared";

const FILE_NAME = "zaicode-launcher.json";
const SAIMAIL_WORKSPACE_ENV = "SAIMAIL_WORKSPACE";

export interface ZaicodeLauncherPreferences {
  autoRestartOnCrash: boolean;
  /** SAIMAIL mailbox root for this machine's operator seat; null = not configured. */
  saimailWorkspace: string | null;
  /** Legacy on/off of pixel-exact rendering; kept in step with `screen` for older readers. */
  pixelExact: boolean;
  /**
   * SRC-062: auto (pixel-exact below 150 % Windows scaling, smooth from 150 % up),
   * pixel, or smooth. Pixel-exact = 100% device scale + bitmap fonts.
   */
  screen: ZaicodeScreenMode;
  /** Start-up splash picture (SRC-049): off = nothing shows until the interface is ready. */
  splashEnabled: boolean;
  /** A custom splash picture is installed in userData (`zaicode-splash/`). */
  splashCustom: boolean;
  /**
   * SRC-060 splash options. Flat keys, because the root launcher reads this
   * file with a regex (tools/launcher/ZaicodeLauncher.cs).
   */
  splashFit: ZaicodeSplashFit;
  splashScale: ZaicodeSplashScale;
  splashStatus: boolean;
  splashHoldUntilReady: boolean;
  splashMaxWaitSec: number;
}

const DEFAULT_PREFERENCES: ZaicodeLauncherPreferences = {
  autoRestartOnCrash: true,
  saimailWorkspace: null,
  pixelExact: true,
  screen: "auto",
  splashEnabled: true,
  splashCustom: false,
  splashFit: DEFAULT_ZAICODE_SPLASH_OPTIONS.fit,
  splashScale: DEFAULT_ZAICODE_SPLASH_OPTIONS.scale,
  splashStatus: DEFAULT_ZAICODE_SPLASH_OPTIONS.status,
  splashHoldUntilReady: DEFAULT_ZAICODE_SPLASH_OPTIONS.holdUntilReady,
  splashMaxWaitSec: DEFAULT_ZAICODE_SPLASH_OPTIONS.maxWaitSec,
};

/** The splash options inside the flat preference record. */
export function zaicodeSplashOptionsOf(preferences: ZaicodeLauncherPreferences): ZaicodeSplashOptions {
  return {
    fit: preferences.splashFit,
    scale: preferences.splashScale,
    status: preferences.splashStatus,
    holdUntilReady: preferences.splashHoldUntilReady,
    maxWaitSec: preferences.splashMaxWaitSec,
  };
}

function splashPreferencesOf(options: ZaicodeSplashOptions): Pick<
  ZaicodeLauncherPreferences,
  "splashFit" | "splashScale" | "splashStatus" | "splashHoldUntilReady" | "splashMaxWaitSec"
> {
  return {
    splashFit: options.fit,
    splashScale: options.scale,
    splashStatus: options.status,
    splashHoldUntilReady: options.holdUntilReady,
    splashMaxWaitSec: options.maxWaitSec,
  };
}

/** SAIMAIL_WORKSPACE that came from outside ZAICODE (shell, launcher); it wins over the file. */
const externalSaimailWorkspace = process.env[SAIMAIL_WORKSPACE_ENV]?.trim() || null;

function preferencesPath(): string {
  return join(app.getPath("userData"), FILE_NAME);
}

function normalizeWorkspace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1024) : null;
}

export function readZaicodeLauncherPreferences(): ZaicodeLauncherPreferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(preferencesPath(), "utf8"));
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return {
        autoRestartOnCrash:
          typeof record.autoRestartOnCrash === "boolean"
            ? record.autoRestartOnCrash
            : DEFAULT_PREFERENCES.autoRestartOnCrash,
        saimailWorkspace: normalizeWorkspace(record.saimailWorkspace),
        pixelExact:
          typeof record.pixelExact === "boolean" ? record.pixelExact : DEFAULT_PREFERENCES.pixelExact,
        screen: normalizeZaicodeScreenMode(record.screen, record.pixelExact),
        splashEnabled:
          typeof record.splashEnabled === "boolean" ? record.splashEnabled : DEFAULT_PREFERENCES.splashEnabled,
        splashCustom:
          typeof record.splashCustom === "boolean" ? record.splashCustom : DEFAULT_PREFERENCES.splashCustom,
        ...splashPreferencesOf(
          normalizeZaicodeSplashOptions({
            fit: record.splashFit,
            scale: record.splashScale,
            status: record.splashStatus,
            holdUntilReady: record.splashHoldUntilReady,
            maxWaitSec: record.splashMaxWaitSec,
          }),
        ),
      };
    }
  } catch {
    // A missing or unreadable preference leaves crash recovery enabled and SAIMAIL off.
  }
  return { ...DEFAULT_PREFERENCES };
}

export function writeZaicodeLauncherPreferences(
  patch: Partial<ZaicodeLauncherPreferences>,
): ZaicodeLauncherPreferences {
  const next = { ...readZaicodeLauncherPreferences(), ...patch };
  const target = preferencesPath();
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return next;
}

export function setZaicodeAutoRestartOnCrash(enabled: boolean): ZaicodeLauncherPreferences {
  return writeZaicodeLauncherPreferences({ autoRestartOnCrash: enabled });
}

/** A screen mode, or the older on/off (true = pixel, false = smooth). Applies on the next start. */
export function setZaicodePixelExact(mode: boolean | ZaicodeScreenMode): ZaicodeLauncherPreferences {
  const screen: ZaicodeScreenMode = typeof mode === "boolean" ? (mode ? "pixel" : "smooth") : mode;
  return writeZaicodeLauncherPreferences({ screen, pixelExact: screen !== "smooth" });
}

export function setZaicodeSplashEnabled(enabled: boolean): ZaicodeLauncherPreferences {
  return writeZaicodeLauncherPreferences({ splashEnabled: enabled });
}

/** Merges `patch` into the stored splash options; bad values fall back, never throw. */
export function setZaicodeSplashOptions(patch: Partial<ZaicodeSplashOptions>): ZaicodeLauncherPreferences {
  const current = zaicodeSplashOptionsOf(readZaicodeLauncherPreferences());
  return writeZaicodeLauncherPreferences(splashPreferencesOf(normalizeZaicodeSplashOptions({ ...current, ...patch })));
}

export function setZaicodeSaimailWorkspace(workspace: string | null): ZaicodeLauncherPreferences {
  const next = writeZaicodeLauncherPreferences({ saimailWorkspace: normalizeWorkspace(workspace) });
  applyZaicodeSaimailEnvironment();
  return next;
}

/**
 * Exposes the configured mailbox as SAIMAIL_WORKSPACE so agent processes and
 * SAIPEN's turn-entry telegram read see it. Host processes inherit env at
 * spawn, so a changed path reaches agents after the next ZAICODE start.
 * An externally provided SAIMAIL_WORKSPACE is never overridden.
 */
export function applyZaicodeSaimailEnvironment(): void {
  // The desk path is a fixed place under userData, so agents can be told about it
  // at spawn even before the desk exists: pairing later needs no restart, and an
  // agent only sees guidance once the desk is really there (identity.ts checks).
  if (!process.env[ZAICODE_SAIMAIL_DESK_ENV]?.trim()) process.env[ZAICODE_SAIMAIL_DESK_ENV] = zaicodeSaimailDeskPath();
  if (externalSaimailWorkspace) return;
  const workspace = readZaicodeLauncherPreferences().saimailWorkspace;
  if (workspace) process.env[SAIMAIL_WORKSPACE_ENV] = workspace;
  else delete process.env[SAIMAIL_WORKSPACE_ENV];
}

/** The agents' own SAIMAIL workspace: app data, not the operator's folder, so agent keys never sit in the operator's mailbox. */
export function zaicodeSaimailDeskPath(): string {
  return join(app.getPath("userData"), "saimail", "agent");
}

export function effectiveZaicodeSaimailWorkspace(): string | null {
  return externalSaimailWorkspace ?? readZaicodeLauncherPreferences().saimailWorkspace;
}

/** Fresh suite installs get their own mailbox; an explicit setting, including null, wins. */
export async function initializeZaicodeSaimailForFreshSuite(): Promise<{ ok: boolean; message: string }> {
  if (externalSaimailWorkspace) return { ok: true, message: "Using the configured SAIMAIL workspace." };
  try {
    const stored: unknown = JSON.parse(readFileSync(preferencesPath(), "utf8"));
    if (stored && typeof stored === "object" && Object.hasOwn(stored, "saimailWorkspace")) {
      return { ok: true, message: "Keeping the existing SAIMAIL setting." };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, message: "The launcher preferences could not be read; SAIMAIL settings were kept." };
  }
  const workspace = join(app.getPath("userData"), "saimail", "operator");
  const result = await initZaicodeSaimailWorkspace(workspace);
  if (!result.ok) return result;
  const pairing = await runZaicodeSaimailPostAction({ action: "pair", operatorPath: workspace, deskPath: zaicodeSaimailDeskPath() });
  if (pairing.ok) setZaicodeSaimailWorkspace(workspace);
  return { ok: pairing.ok, message: pairing.message };
}
