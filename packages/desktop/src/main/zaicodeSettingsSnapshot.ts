import { app } from "electron";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * ZAICODE dev "Save all settings": the renderer sends a snapshot of every
 * ZAICODE UI preference (palette, fonts, sidebar slots, audio, profiles, ...).
 * It is written
 *  1. into the source tree as `packages/ui/src/zaicode/zaicodeSettingsDefaults.json`,
 *     which the renderer bundles and seeds into empty storage, so the operator's
 *     choices become the defaults of every later build ("until release");
 *  2. into userData as `zaicode-settings-snapshot.json`, a restorable backup.
 */
const DEFAULTS_RELATIVE = join("packages", "ui", "src", "zaicode", "zaicodeSettingsDefaults.json");
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** Walks up from the app / executable to the zcode checkout that owns packages/ui. */
export function findZaicodeSourceRoot(): string | null {
  const starts = [dirname(process.execPath), app.getAppPath(), process.cwd()];
  for (const start of starts) {
    let current = resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(current, "packages", "ui", "src", "zaicode"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function writeAtomic(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, target);
}

export function saveZaicodeSettingsSnapshot(json: string): {
  ok: boolean;
  message: string;
  sourcePath: string | null;
  backupPath: string | null;
} {
  if (Buffer.byteLength(json, "utf8") > MAX_SNAPSHOT_BYTES) {
    return { ok: false, message: "Snapshot is larger than 4 MB.", sourcePath: null, backupPath: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: "Snapshot is not valid JSON.", sourcePath: null, backupPath: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, message: "Snapshot must be an object.", sourcePath: null, backupPath: null };
  }
  const content = `${JSON.stringify(parsed, null, 2)}\n`;
  let backupPath: string | null = join(app.getPath("userData"), "zaicode-settings-snapshot.json");
  try {
    writeAtomic(backupPath, content);
  } catch {
    backupPath = null;
  }
  const root = findZaicodeSourceRoot();
  let sourcePath: string | null = null;
  if (root) {
    sourcePath = join(root, DEFAULTS_RELATIVE);
    try {
      writeAtomic(sourcePath, content);
    } catch (error) {
      return {
        ok: false,
        message: `Could not write ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        sourcePath: null,
        backupPath,
      };
    }
  }
  return {
    ok: Boolean(sourcePath || backupPath),
    message: sourcePath
      ? backupPath
        ? "Saved as the built-in defaults (next build ships them) and backed up."
        : "Saved as the built-in defaults (next build ships them); backup could not be written."
      : "Source tree not found: saved the backup only.",
    sourcePath,
    backupPath,
  };
}
