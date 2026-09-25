import { app } from "electron";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ZAICODE pixel-exact text.
 *
 * Chromium on Windows draws text through DirectWrite with the system's
 * anti-aliasing. CSS cannot turn that off. What does turn it off is a font
 * with embedded bitmap strikes (EBLC/EBDT): Skia/DirectWrite renders those
 * aliased, pixel for pixel. Verdana_m1 (UI) and Terminus TTF (code) carry such
 * strikes. They only keep them as INSTALLED fonts: Chromium's web-font
 * sanitizer drops EBLC/EBDT from @font-face files. So ZAICODE installs them
 * for the current user when missing (the root launcher does it before the
 * app starts; this is the fallback for a direct start), and pins the device
 * scale to 1 so a 12 px glyph is a 12 px strike, not a blurred 15 px outline.
 */

interface FontManifestEntry {
  file: string;
  registryName: string;
}

const FONTS_KEY = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
const MACHINE_FONTS_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

function regExe(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
}

function fontSourceDir(): string | null {
  const candidates = [
    join(process.resourcesPath ?? "", "zaicode-fonts"),
    join(app.getAppPath(), "build", "zaicode-fonts"),
    join(app.getAppPath(), "..", "build", "zaicode-fonts"),
    join(app.getAppPath(), "..", "..", "build", "zaicode-fonts"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "zaicode-fonts.json"))) ?? null;
}

function registeredFontNames(key: string): Set<string> {
  const result = spawnSync(regExe(), ["query", key], { encoding: "utf8", windowsHide: true });
  const names = new Set<string>();
  if (result.status !== 0 || typeof result.stdout !== "string") return names;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s{4}(.+?)\s{4}REG_\w+\s{4}/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export interface ZaicodeCrispFontsResult {
  sourceDir: string | null;
  installed: string[];
  present: string[];
  failed: string[];
}

/** Installs missing ZAICODE bitmap fonts for the current user (Windows only, idempotent). */
export function ensureZaicodeCrispFonts(): ZaicodeCrispFontsResult {
  const result: ZaicodeCrispFontsResult = { sourceDir: null, installed: [], present: [], failed: [] };
  if (process.platform !== "win32") return result;
  const sourceDir = fontSourceDir();
  result.sourceDir = sourceDir;
  if (!sourceDir) return result;
  let entries: FontManifestEntry[];
  try {
    const manifest = JSON.parse(readFileSync(join(sourceDir, "zaicode-fonts.json"), "utf8")) as {
      fonts?: FontManifestEntry[];
    };
    entries = (manifest.fonts ?? []).filter(
      (entry) => typeof entry.file === "string" && typeof entry.registryName === "string",
    );
  } catch {
    return result;
  }
  const registered = new Set([
    ...registeredFontNames(FONTS_KEY),
    ...registeredFontNames(MACHINE_FONTS_KEY),
  ]);
  const userFontsDir = join(
    process.env.LOCALAPPDATA ?? join(app.getPath("home"), "AppData", "Local"),
    "Microsoft",
    "Windows",
    "Fonts",
  );
  for (const entry of entries) {
    if (registered.has(entry.registryName)) {
      result.present.push(entry.registryName);
      continue;
    }
    try {
      const source = join(sourceDir, entry.file);
      if (!existsSync(source)) throw new Error("missing font file");
      mkdirSync(userFontsDir, { recursive: true });
      const target = join(userFontsDir, entry.file);
      if (!existsSync(target)) copyFileSync(source, target);
      const add = spawnSync(
        regExe(),
        ["add", FONTS_KEY, "/v", entry.registryName, "/t", "REG_SZ", "/d", target, "/f"],
        { windowsHide: true },
      );
      if (add.status !== 0) throw new Error(`reg add exited ${String(add.status)}`);
      result.installed.push(entry.registryName);
    } catch {
      result.failed.push(entry.registryName);
    }
  }
  return result;
}

/**
 * Chromium switches for pixel-exact rendering; must run before `app.ready`.
 * - force-device-scale-factor=1: 100% everywhere, glyphs hit their bitmap strikes.
 * - disable-font-subpixel-positioning: glyphs on whole pixels, no fractional smear.
 */
export function applyZaicodePixelExactSwitches(): void {
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.commandLine.appendSwitch("disable-font-subpixel-positioning");
}
