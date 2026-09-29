import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  ZAICODE_CUSTOM_PRESET_MAX_BYTES,
  ZAICODE_CUSTOM_PRESET_MAX_FILES,
  ZAICODE_CUSTOM_SOUND_MAX_BYTES,
  ZAICODE_CUSTOM_SOUND_MAX_DEPTH,
  ZAICODE_CUSTOM_SOUND_MAX_FILES,
  isZaicodeCustomPresetName,
  isZaicodeCustomSoundPath,
  type ZaicodeCustomizationChange,
  type ZaicodeCustomizationInfo,
  type ZaicodeCustomizationKind,
  type ZaicodeCustomizationRootSource,
  type ZaicodeCustomPresetEntry,
  type ZaicodeCustomPresetReadResult,
  type ZaicodeCustomPresetWriteRequest,
  type ZaicodeCustomSoundEntry,
  type ZaicodeCustomSoundList,
  type ZaicodeCustomSoundReadResult,
  type ZaicodeCustomSoundWriteRequest,
  type ZaicodeCustomWriteResult,
} from "@zcode/shared";
import { ZAICODE_SOUND_HEADER_WINDOW, parseZaicodeSoundLength, sniffZaicodeSoundFormat, zaicodeMp3TagLength } from "./zaicodeSoundHeader.js";

/**
 * The customization folder (T-126, SRC-089): one place the operator can find, next to `zcode\`, with `sounds\`
 * (dropped WAV/MP3/OGG files, listed live) and `presets\` (exported preset files). Kept free of `electron` so it
 * is tested on a temporary folder; zaicodeCustomizationHost.ts is the electron half.
 *
 * Two rules run through it. The renderer names a file only by its path INSIDE one of the two folders, and every
 * path is re-checked here (no `..`, no drive, real path still inside the folder, no symbolic link followed), so a
 * hostile preset can never make main read or write outside. And nothing is ever overwritten: a write of other
 * bytes under a taken name lands beside it as `name (2).wav`, identical bytes are recognised and not written twice.
 */

// ---------------------------------------------------------------- root

export interface ZaicodeCustomizationRootInput {
  env: Readonly<Record<string, string | undefined>>;
  /** The running executable: the packaged app lives under the workspace, so walking up finds it. */
  execPath: string;
  /** The per-user application data folder, the last resort when there is no workspace. */
  appData?: string;
  exists?: (path: string) => boolean;
}

const WALK_UP_LIMIT = 14;

/**
 * Where `customization\` is. In order: `ZAICODE_CUSTOMIZATION_DIR` (the folder itself), `ZAICODE_ROOT` + `\customization`,
 * the first folder above the executable that holds `zcode\packages\desktop` (the workspace), then
 * `<app data>\ZAICODE\customization` for an installed copy that sits in no workspace.
 */
export function resolveZaicodeCustomizationRoot(input: ZaicodeCustomizationRootInput): { root: string; source: ZaicodeCustomizationRootSource } {
  const exists = input.exists ?? existsSync;
  const dir = input.env["ZAICODE_CUSTOMIZATION_DIR"]?.trim();
  if (dir && isAbsolute(dir)) return { root: dir, source: "env-dir" };
  const workspace = input.env["ZAICODE_ROOT"]?.trim();
  if (workspace && isAbsolute(workspace)) return { root: join(workspace, "customization"), source: "env-root" };
  let at = dirname(input.execPath);
  for (let step = 0; step < WALK_UP_LIMIT; step += 1) {
    if (exists(join(at, "zcode", "packages", "desktop"))) return { root: join(at, "customization"), source: "workspace" };
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  const base = input.appData?.trim() || join(homedir(), "AppData", "Roaming");
  return { root: join(base, "ZAICODE", "customization"), source: "appdata" };
}

export function zaicodeCustomizationInfo(root: string, source: ZaicodeCustomizationRootSource): ZaicodeCustomizationInfo {
  return { root, soundsDir: join(root, "sounds"), presetsDir: join(root, "presets"), source };
}

const README = `ZAICODE customization folder
============================

sounds\\    Drop WAV, MP3 or OGG files here (sub-folders are fine). They show up in the sound
           picker's "Mine" tab within a second, no restart. The name of the file is the name
           of the sound; the folder it sits in is shown next to it.

presets\\   Export in a Settings page's Presets menu saves one .json file per preset here (its own
           sounds travel inside it). A preset from a friend goes in here too: it is listed under
           "In the presets folder" in the same menu.

Nothing in this folder is ever overwritten by the app: a different file that would take an
existing name is saved as "name (2)". You can move, rename and delete files freely.
`;

/** Creates the two folders and a README the first time; harmless every other time. */
export async function ensureZaicodeCustomizationFolders(info: ZaicodeCustomizationInfo): Promise<void> {
  await mkdir(info.soundsDir, { recursive: true });
  await mkdir(info.presetsDir, { recursive: true });
  await writeFile(join(info.root, "README.txt"), README, { encoding: "utf8", flag: "wx" }).catch(() => undefined);
}

// ---------------------------------------------------------------- paths

/** `target` is `base` or inside it (after the real paths were resolved). */
function inside(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function realInside(baseDir: string, target: string): Promise<boolean> {
  try {
    return inside(await realpath(baseDir), await realpath(target));
  } catch {
    return false;
  }
}

const absoluteOf = (baseDir: string, path: string): string => join(baseDir, ...path.split("/"));

/** A regular file (not a link) with a size, or null. */
async function fileFacts(path: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  const facts = await lstat(path).catch(() => null);
  return facts?.isFile() ? { bytes: facts.size, mtimeMs: facts.mtimeMs } : null;
}

// ---------------------------------------------------------------- sounds

const lengthCache = new Map<string, number>();

async function soundSeconds(path: string, bytes: number, mtimeMs: number): Promise<number> {
  const key = `${path}|${mtimeMs}|${bytes}`;
  const known = lengthCache.get(key);
  if (known !== undefined) return known;
  let seconds = -1;
  try {
    const handle = await open(path, "r");
    try {
      const window = Math.min(bytes, ZAICODE_SOUND_HEADER_WINDOW);
      const head = new Uint8Array(window);
      await handle.read(head, 0, window, 0);
      const tail = new Uint8Array(window);
      await handle.read(tail, 0, window, Math.max(0, bytes - window));
      const format = sniffZaicodeSoundFormat(head);
      const tag = format === "mp3" ? zaicodeMp3TagLength(head) : 0;
      if (tag > 0 && tag > window - 4096 && tag < bytes) {
        // Cover art can make the ID3 tag bigger than the window: read the frames where the tag ends.
        const after = new Uint8Array(Math.min(window, bytes - tag));
        await handle.read(after, 0, after.length, tag);
        seconds = parseZaicodeSoundLength("mp3", after, tail, bytes, tag);
      } else {
        seconds = format ? parseZaicodeSoundLength(format, head, tail, bytes) : -1;
      }
    } finally {
      await handle.close();
    }
  } catch {
    seconds = -1;
  }
  if (lengthCache.size > 20_000) lengthCache.clear();
  lengthCache.set(key, seconds);
  return seconds;
}

/** Every sound under `sounds\` with its length; links are not followed, a huge folder is cut and says so. */
export async function listZaicodeCustomSounds(info: ZaicodeCustomizationInfo): Promise<ZaicodeCustomSoundList> {
  const found: { path: string; bytes: number; mtimeMs: number }[] = [];
  let truncated = false;
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= ZAICODE_CUSTOM_SOUND_MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const here = [...segments, entry.name];
      if (entry.isDirectory()) {
        if (here.length + 1 > ZAICODE_CUSTOM_SOUND_MAX_DEPTH) {
          // Too deep to look into: only worth a warning when something is in there.
          if ((await readdir(join(dir, entry.name)).catch(() => [])).length > 0) truncated = true;
        } else {
          await walk(join(dir, entry.name), here);
        }
        continue;
      }
      const path = here.join("/");
      if (!entry.isFile() || !isZaicodeCustomSoundPath(path)) continue;
      const facts = await fileFacts(join(dir, entry.name));
      // Empty (still being copied) and over-size files are not sounds yet / any more.
      if (!facts || facts.bytes === 0 || facts.bytes > ZAICODE_CUSTOM_SOUND_MAX_BYTES) continue;
      found.push({ path, ...facts });
    }
  };
  await walk(info.soundsDir, []);
  found.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
  const sounds: ZaicodeCustomSoundEntry[] = [];
  for (let at = 0; at < found.length; at += 16) {
    const batch = await Promise.all(
      found.slice(at, at + 16).map(async (file) => ({ ...file, seconds: await soundSeconds(absoluteOf(info.soundsDir, file.path), file.bytes, file.mtimeMs) })),
    );
    sounds.push(...batch);
  }
  return { info, sounds, truncated };
}

export async function readZaicodeCustomSound(info: ZaicodeCustomizationInfo, path: string): Promise<ZaicodeCustomSoundReadResult> {
  if (!isZaicodeCustomSoundPath(path)) return { ok: false, reason: "not a sound path" };
  const target = absoluteOf(info.soundsDir, path);
  const facts = await fileFacts(target);
  if (!facts) return { ok: false, reason: "no such file" };
  if (facts.bytes === 0 || facts.bytes > ZAICODE_CUSTOM_SOUND_MAX_BYTES) return { ok: false, reason: "empty or too large" };
  if (!(await realInside(info.soundsDir, target))) return { ok: false, reason: "outside the sounds folder" };
  const bytes = new Uint8Array(await readFile(target));
  if (!sniffZaicodeSoundFormat(bytes)) return { ok: false, reason: "not a WAV, MP3 or OGG file" };
  return { ok: true, bytes, mtimeMs: facts.mtimeMs };
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && Buffer.compare(Buffer.from(left.buffer, left.byteOffset, left.length), Buffer.from(right.buffer, right.byteOffset, right.length)) === 0;

/** `name.ext`, `name (2).ext`, `name (3).ext` ... */
function numbered(path: string, index: number): string {
  if (index === 1) return path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? `${path.slice(0, dot)} (${index})${path.slice(dot)}` : `${path} (${index})`;
}

const MAX_SUFFIX = 99;

/**
 * Writes `bytes` under `wanted` inside `baseDir` without ever replacing a file: an identical file is recognised
 * (nothing written, `created: false`), another file with that name pushes the write to the next free numbered name.
 */
async function writeBeside(
  baseDir: string,
  wanted: string,
  content: Uint8Array | string,
  same: (existing: Buffer) => boolean,
): Promise<ZaicodeCustomWriteResult> {
  for (let index = 1; index <= MAX_SUFFIX; index += 1) {
    const path = numbered(wanted, index);
    const target = absoluteOf(baseDir, path);
    const facts = await fileFacts(target);
    if (facts) {
      if (same(await readFile(target))) return { ok: true, path, created: false, absolute: target };
      continue;
    }
    // A link or folder in the way is not ours to write through.
    if (await lstat(target).then(() => true, () => false)) continue;
    await mkdir(dirname(target), { recursive: true });
    if (!(await realInside(baseDir, dirname(target)))) return { ok: false, reason: "outside the folder" };
    try {
      await writeFile(target, content, { flag: "wx" });
      return { ok: true, path, created: true, absolute: target };
    } catch (error) {
      // Somebody took the name between the check and the write: try the next one.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, reason: "too many files with that name" };
}

export async function writeZaicodeCustomSound(info: ZaicodeCustomizationInfo, request: ZaicodeCustomSoundWriteRequest): Promise<ZaicodeCustomWriteResult> {
  const { path, bytes } = request;
  if (!isZaicodeCustomSoundPath(path)) return { ok: false, reason: "not a sound path" };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > ZAICODE_CUSTOM_SOUND_MAX_BYTES) return { ok: false, reason: "empty or too large" };
  if (!sniffZaicodeSoundFormat(bytes)) return { ok: false, reason: "not a WAV, MP3 or OGG file" };
  await mkdir(info.soundsDir, { recursive: true });
  return writeBeside(info.soundsDir, path, bytes, (existing) => sameBytes(new Uint8Array(existing), bytes));
}

// ---------------------------------------------------------------- presets

export async function listZaicodeCustomPresets(info: ZaicodeCustomizationInfo): Promise<ZaicodeCustomPresetEntry[]> {
  const entries = await readdir(info.presetsDir, { withFileTypes: true }).catch(() => []);
  const presets: ZaicodeCustomPresetEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isZaicodeCustomPresetName(entry.name)) continue;
    const facts = await fileFacts(join(info.presetsDir, entry.name));
    if (facts && facts.bytes > 0 && facts.bytes <= ZAICODE_CUSTOM_PRESET_MAX_BYTES) presets.push({ name: entry.name, ...facts });
  }
  return presets.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, ZAICODE_CUSTOM_PRESET_MAX_FILES);
}

export async function readZaicodeCustomPreset(info: ZaicodeCustomizationInfo, name: string): Promise<ZaicodeCustomPresetReadResult> {
  if (!isZaicodeCustomPresetName(name)) return { ok: false, reason: "not a preset file name" };
  const target = join(info.presetsDir, name);
  const facts = await fileFacts(target);
  if (!facts) return { ok: false, reason: "no such file" };
  if (facts.bytes === 0 || facts.bytes > ZAICODE_CUSTOM_PRESET_MAX_BYTES) return { ok: false, reason: "empty or too large" };
  if (!(await realInside(info.presetsDir, target))) return { ok: false, reason: "outside the presets folder" };
  return { ok: true, text: await readFile(target, "utf8") };
}

export async function writeZaicodeCustomPreset(info: ZaicodeCustomizationInfo, request: ZaicodeCustomPresetWriteRequest): Promise<ZaicodeCustomWriteResult> {
  const { name, text } = request;
  if (!isZaicodeCustomPresetName(name)) return { ok: false, reason: "not a preset file name" };
  if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text, "utf8") > ZAICODE_CUSTOM_PRESET_MAX_BYTES) return { ok: false, reason: "empty or too large" };
  await mkdir(info.presetsDir, { recursive: true });
  return writeBeside(info.presetsDir, name, text, (existing) => existing.toString("utf8") === text);
}

// ---------------------------------------------------------------- open in the file manager

export interface ZaicodeCustomizationShell {
  /** Electron's shell.openPath: "" on success, else the error text. */
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

export async function openZaicodeCustomization(
  info: ZaicodeCustomizationInfo,
  request: { kind: ZaicodeCustomizationKind; file?: string },
  shell: ZaicodeCustomizationShell,
): Promise<{ ok: boolean; message: string }> {
  await ensureZaicodeCustomizationFolders(info).catch(() => undefined);
  const folder = request.kind === "sounds" ? info.soundsDir : request.kind === "presets" ? info.presetsDir : info.root;
  if (request.file !== undefined) {
    const valid = request.kind === "sounds" ? isZaicodeCustomSoundPath(request.file) : request.kind === "presets" ? isZaicodeCustomPresetName(request.file) : false;
    const target = valid ? absoluteOf(folder, request.file) : null;
    if (!target || !inside(folder, target)) return { ok: false, message: "not a file of the customization folder" };
    if (existsSync(target)) {
      shell.showItemInFolder(target);
      return { ok: true, message: target };
    }
  }
  const failure = await shell.openPath(folder);
  return failure ? { ok: false, message: failure } : { ok: true, message: folder };
}

// ---------------------------------------------------------------- live changes

export interface ZaicodeChangeNotifierTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: ZaicodeChangeNotifierTimers = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };

/**
 * Turns the burst of file system events one copy makes (create, several writes, rename) into ONE notice per kind,
 * `delayMs` after the last event, so the list is scanned once a file has settled, not once per chunk.
 */
export function createZaicodeChangeNotifier(
  emit: (change: ZaicodeCustomizationChange) => void,
  delayMs = 300,
  timers: ZaicodeChangeNotifierTimers = REAL_TIMERS,
): { note(change: ZaicodeCustomizationChange): void; close(): void } {
  const pending = new Map<ZaicodeCustomizationChange, unknown>();
  return {
    note(change) {
      const running = pending.get(change);
      if (running !== undefined) timers.clear(running);
      pending.set(
        change,
        timers.set(() => {
          pending.delete(change);
          emit(change);
        }, delayMs),
      );
    },
    close() {
      for (const handle of pending.values()) timers.clear(handle);
      pending.clear();
    },
  };
}

/** Watches both folders and calls `emit` (debounced) when anything in them changes. Never throws. */
export function watchZaicodeCustomization(info: ZaicodeCustomizationInfo, emit: (change: ZaicodeCustomizationChange) => void, delayMs = 300): { close(): void } {
  const notifier = createZaicodeChangeNotifier(emit, delayMs);
  const watchers: FSWatcher[] = [];
  const attach = (dir: string, change: ZaicodeCustomizationChange, recursive: boolean): void => {
    const start = (deep: boolean): FSWatcher => watch(dir, { recursive: deep, persistent: false }, () => notifier.note(change));
    try {
      let watcher: FSWatcher;
      try {
        watcher = start(recursive);
      } catch {
        // Recursive watching is not available everywhere; the window's re-scan on focus covers sub-folders then.
        watcher = start(false);
      }
      // A folder deleted while watched raises an error event; the re-scan on focus is the safety net.
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // No watcher for this folder: the window's re-scan on focus still finds new files.
    }
  };
  attach(info.soundsDir, "sounds", true);
  attach(info.presetsDir, "presets", false);
  return {
    close() {
      notifier.close();
      for (const watcher of watchers) watcher.close();
    },
  };
}
