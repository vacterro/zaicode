import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * ZAICODE (SRC-046): a SCHEDULER prompt can be a whole audit, but a CLI worker
 * gets its prompt on a PowerShell command line (about 32 000 characters at
 * most, and line breaks would press Enter halfway). A long prompt is written
 * here as a file; the worker is told to read it. Files older than a week go.
 */

const FOLDER = "zaicode-prompts";
const KEEP_MS = 7 * 24 * 3_600_000;
/** Same order of magnitude as ZAICODE_PROMPT_MAX_CHARS (the renderer's cap). */
const MAX_CHARS = 1_000_000;

async function removeOldPrompts(folder: string, now: number): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > KEEP_MS) await unlink(path).catch(() => undefined);
  }
}

export async function writeZaicodePromptFile(text: string): Promise<{ ok: boolean; path: string; message: string }> {
  if (!text.trim()) return { ok: false, path: "", message: "Empty prompt" };
  const folder = join(app.getPath("userData"), FOLDER);
  try {
    await mkdir(folder, { recursive: true });
    const now = Date.now();
    await removeOldPrompts(folder, now);
    const path = join(folder, `prompt-${new Date(now).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.md`);
    await writeFile(path, text.slice(0, MAX_CHARS), "utf8");
    return { ok: true, path, message: `Prompt written (${text.length} characters)` };
  } catch (error) {
    return { ok: false, path: "", message: error instanceof Error ? error.message : String(error) };
  }
}
