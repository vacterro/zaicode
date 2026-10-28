import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * Every font family installed on this Windows machine, per-user fonts included, as GDI+
 * names them (the names CSS font-family resolves). The renderer has no font list of its
 * own: queryLocalFonts needs a secure origin and a permission the app does not ask for.
 * Windows PowerShell 5.1 ships with every Windows 10/11, so nothing extra is needed.
 */
const SCRIPT =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; " +
  "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";

let pending: Promise<string[]> | null = null;

/** Unique family names, sorted for a picker; vertical "@" variants are not choices. */
export function parseZaicodeFontFamilies(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const name = line.trim();
    if (name && !name.startsWith("@")) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Cached for the session; a failed probe is retried on the next request. */
export function listZaicodeSystemFonts(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  pending ??= new Promise<string[]>((resolve) => {
    const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFile(
      shell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        const fonts = error ? [] : parseZaicodeFontFamilies(stdout);
        if (fonts.length === 0) pending = null;
        resolve(fonts);
      },
    );
  });
  return pending;
}
