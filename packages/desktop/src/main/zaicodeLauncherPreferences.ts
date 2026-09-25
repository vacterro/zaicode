import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = "zaicode-launcher.json";
const SAIMAIL_WORKSPACE_ENV = "SAIMAIL_WORKSPACE";

export interface ZaicodeLauncherPreferences {
  autoRestartOnCrash: boolean;
  /** SAIMAIL mailbox root for this machine's operator seat; null = not configured. */
  saimailWorkspace: string | null;
  /** Pixel-exact rendering: 100% device scale + bitmap fonts, no subpixel glyph positions. */
  pixelExact: boolean;
}

const DEFAULT_PREFERENCES: ZaicodeLauncherPreferences = {
  autoRestartOnCrash: true,
  saimailWorkspace: null,
  pixelExact: true,
};

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
      };
    }
  } catch {
    // A missing or unreadable preference leaves crash recovery enabled and SAIMAIL off.
  }
  return { ...DEFAULT_PREFERENCES };
}

function writeZaicodeLauncherPreferences(
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

export function setZaicodePixelExact(enabled: boolean): ZaicodeLauncherPreferences {
  return writeZaicodeLauncherPreferences({ pixelExact: enabled });
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
  if (externalSaimailWorkspace) return;
  const workspace = readZaicodeLauncherPreferences().saimailWorkspace;
  if (workspace) process.env[SAIMAIL_WORKSPACE_ENV] = workspace;
  else delete process.env[SAIMAIL_WORKSPACE_ENV];
}

export function effectiveZaicodeSaimailWorkspace(): string | null {
  return externalSaimailWorkspace ?? readZaicodeLauncherPreferences().saimailWorkspace;
}
