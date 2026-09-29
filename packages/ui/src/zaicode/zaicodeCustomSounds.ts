import { useSyncExternalStore } from "react";
import {
  isZaicodeCustomSoundPath,
  zaicodeCustomSoundId,
  zaicodeCustomSoundPathOf,
  type ZaicodeCustomizationChange,
  type ZaicodeCustomizationInfo,
  type ZaicodeCustomizationKind,
  type ZaicodeCustomPresetEntry,
  type ZaicodeCustomPresetReadResult,
  type ZaicodeCustomPresetWriteRequest,
  type ZaicodeCustomSoundList,
  type ZaicodeCustomSoundReadResult,
  type ZaicodeCustomSoundWriteRequest,
  type ZaicodeCustomWriteResult,
} from "@zcode/shared";
import {
  categorizeZaicodeSound,
  listZaicodeSoundCatalog,
  setZaicodeExtraSoundEntries,
  type ZaicodeSoundEntry,
} from "./zaicodeSoundCatalog.js";
import { soundMime, toArrayBuffer, type OwnSound, type PresetSoundSource } from "./zaicodePresetAssets.js";

/**
 * The customization folder as the window sees it (T-126): a live list of the sounds the operator dropped into
 * `customization\sounds`, merged into the picker's catalog, and the way to play them.
 *
 * The desktop main process watches the folder and says "sounds changed"; the window also re-scans when it gets
 * focus, so a file moved in while the watcher was blind (a network drive, a full event queue) still shows up.
 * A file is read through main by its path inside the folder and played from a blob URL cached by modification
 * time, so replacing a file plays the new one. The window never sees or sends an absolute path.
 */

interface CustomizationBridge {
  getZaicodeCustomizationInfo?(): Promise<ZaicodeCustomizationInfo>;
  listZaicodeCustomSounds?(): Promise<ZaicodeCustomSoundList>;
  readZaicodeCustomSound?(path: string): Promise<ZaicodeCustomSoundReadResult>;
  writeZaicodeCustomSound?(request: ZaicodeCustomSoundWriteRequest): Promise<ZaicodeCustomWriteResult>;
  listZaicodeCustomPresets?(): Promise<ZaicodeCustomPresetEntry[]>;
  readZaicodeCustomPreset?(name: string): Promise<ZaicodeCustomPresetReadResult>;
  writeZaicodeCustomPreset?(request: ZaicodeCustomPresetWriteRequest): Promise<ZaicodeCustomWriteResult>;
  openZaicodeCustomization?(request: { kind: ZaicodeCustomizationKind; file?: string }): Promise<{ ok: boolean; message: string }>;
  onZaicodeCustomizationChanged?(callback: (change: ZaicodeCustomizationChange) => void): () => void;
}

export function getZaicodeCustomizationBridge(): CustomizationBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as unknown as { zcode?: CustomizationBridge }).zcode;
  return bridge?.listZaicodeCustomSounds ? bridge : undefined;
}

export interface ZaicodeCustomSoundsState {
  /** The first answer (or the certainty that there is none) is in. */
  loaded: boolean;
  /** A desktop with a customization folder answered. */
  available: boolean;
  info: ZaicodeCustomizationInfo | null;
  /** The customization sounds alone, in the catalog's entry shape. */
  mine: readonly ZaicodeSoundEntry[];
  /** The bundled library and the customization sounds together, sorted by name. */
  catalog: readonly ZaicodeSoundEntry[];
  /** More files than the scan reads. */
  truncated: boolean;
  /** Changes when the list does; a failed read is not retried until it changes. */
  version: number;
}

let state: ZaicodeCustomSoundsState = {
  loaded: false,
  available: false,
  info: null,
  mine: [],
  catalog: listZaicodeSoundCatalog(),
  truncated: false,
  version: 0,
};
let signature = "";
const mtimes = new Map<string, number>();
const listeners = new Set<() => void>();

export function getZaicodeCustomSounds(): ZaicodeCustomSoundsState {
  return state;
}

export function subscribeZaicodeCustomSounds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useZaicodeCustomSounds(): ZaicodeCustomSoundsState {
  return useSyncExternalStore(subscribeZaicodeCustomSounds, getZaicodeCustomSounds, getZaicodeCustomSounds);
}

/** The picker's catalog: the bundled library plus what is in the customization folder right now. */
export function useZaicodeSoundCatalog(): readonly ZaicodeSoundEntry[] {
  return useZaicodeCustomSounds().catalog;
}

function entryOf(path: string, seconds: number): ZaicodeSoundEntry {
  const slash = path.lastIndexOf("/");
  return {
    id: zaicodeCustomSoundId(path),
    name: path.slice(slash + 1).replace(/\.(wav|mp3|ogg)$/i, ""),
    folder: slash < 0 ? "" : path.slice(0, slash),
    seconds,
    kind: categorizeZaicodeSound(path, seconds),
  };
}

const byName = (left: ZaicodeSoundEntry, right: ZaicodeSoundEntry) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

function publish(next: Omit<ZaicodeCustomSoundsState, "catalog" | "version">, listSignature: string): void {
  const changed = listSignature !== signature || next.available !== state.available || next.loaded !== state.loaded || next.info?.root !== state.info?.root;
  signature = listSignature;
  if (!changed) return;
  setZaicodeExtraSoundEntries(next.mine);
  state = { ...next, catalog: [...listZaicodeSoundCatalog(), ...next.mine].sort(byName), version: state.version + 1 };
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------- playing

interface CachedUrl {
  url: string;
  mtimeMs: number;
}

const urlCache = new Map<string, CachedUrl>();
const reads = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();
const revokeListeners = new Set<(url: string) => void>();

/** Called when a blob URL of a customization sound is dropped (a decoded copy of it can go too). */
export function onZaicodeCustomSoundUrlRevoked(listener: (url: string) => void): () => void {
  revokeListeners.add(listener);
  return () => revokeListeners.delete(listener);
}

function dropUrl(id: string): void {
  const cached = urlCache.get(id);
  if (!cached) return;
  urlCache.delete(id);
  URL.revokeObjectURL(cached.url);
  for (const listener of revokeListeners) listener(cached.url);
}

/** The blob URL of a customization sound that is ready to play, or null (not read yet, or the file changed). */
export function cachedZaicodeCustomSoundUrl(id: string): string | null {
  const cached = urlCache.get(id);
  if (!cached) return null;
  const path = zaicodeCustomSoundPathOf(id);
  const listed = path === null ? undefined : mtimes.get(path);
  return listed === undefined || listed === cached.mtimeMs ? cached.url : null;
}

/** Reads a customization sound through main and answers a URL to play it from; null = no such file. */
export function resolveZaicodeCustomSoundUrl(id: string): Promise<string | null> {
  const path = zaicodeCustomSoundPathOf(id);
  const bridge = getZaicodeCustomizationBridge();
  if (!path || !isZaicodeCustomSoundPath(path) || !bridge?.readZaicodeCustomSound) return Promise.resolve(null);
  const fresh = cachedZaicodeCustomSoundUrl(id);
  if (fresh) return Promise.resolve(fresh);
  const running = reads.get(id);
  if (running) return running;
  dropUrl(id);
  const read = bridge
    .readZaicodeCustomSound(path)
    .then((result) => {
      if (!result.ok) return null;
      dropUrl(id);
      const url = URL.createObjectURL(new Blob([toArrayBuffer(result.bytes)], { type: soundMime(path) }));
      urlCache.set(id, { url, mtimeMs: result.mtimeMs });
      failedAt.delete(id);
      return url;
    })
    .catch(() => null)
    .finally(() => reads.delete(id));
  reads.set(id, read);
  return read;
}

/**
 * The synchronous half for code that cannot wait (the ambience layer asks for a URL while it reconciles): answers
 * the URL if it is ready, otherwise starts the read and calls `ready` when it lands. A read that failed is not
 * started again until the list changes, so a missing file cannot spin the caller.
 */
export function requestZaicodeCustomSoundUrl(id: string, ready: () => void): string | null {
  const cached = cachedZaicodeCustomSoundUrl(id);
  if (cached) return cached;
  if (reads.has(id) || failedAt.get(id) === state.version) return null;
  void resolveZaicodeCustomSoundUrl(id).then((url) => {
    if (url) ready();
    else failedAt.set(id, state.version);
  });
  return null;
}

// ---------------------------------------------------------------- the live list

let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

/**
 * Scans the folder again. Calls that arrive during a scan share ONE more scan after it, and their promise resolves
 * when that scan is done (a file written a moment ago is in the list by then).
 */
export function refreshZaicodeCustomSounds(): Promise<void> {
  if (running) {
    queued ??= running.then(() => {
      queued = null;
      return refreshZaicodeCustomSounds();
    });
    return queued;
  }
  const bridge = getZaicodeCustomizationBridge();
  if (!bridge?.listZaicodeCustomSounds) {
    publish({ loaded: true, available: false, info: null, mine: [], truncated: false }, "none");
    return Promise.resolve();
  }
  running = bridge
    .listZaicodeCustomSounds()
    .then((list) => {
      const valid = list.sounds.filter((sound) => isZaicodeCustomSoundPath(sound.path));
      mtimes.clear();
      for (const sound of valid) mtimes.set(sound.path, sound.mtimeMs);
      // A file that was replaced or removed must not keep playing from its old bytes.
      for (const id of [...urlCache.keys()]) {
        const path = zaicodeCustomSoundPathOf(id);
        if (path === null || !mtimes.has(path) || cachedZaicodeCustomSoundUrl(id) === null) dropUrl(id);
      }
      const mine = valid.map((sound) => entryOf(sound.path, sound.seconds));
      publish(
        { loaded: true, available: true, info: list.info, mine, truncated: list.truncated },
        valid.map((sound) => `${sound.path}|${sound.mtimeMs}|${sound.bytes}|${sound.seconds}`).join("\n") + (list.truncated ? "\n…" : ""),
      );
    })
    .catch(() => {
      // Main did not answer: keep what is shown; the next change or focus tries again.
      publish({ loaded: true, available: state.available, info: state.info, mine: state.mine, truncated: state.truncated }, signature);
    })
    .finally(() => {
      running = null;
    });
  return running;
}

let started = false;

/** Starts the live list once: first scan, main's change notices, and a re-scan whenever the window gets focus. */
export function startZaicodeCustomSounds(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const bridge = getZaicodeCustomizationBridge();
  bridge?.onZaicodeCustomizationChanged?.((change) => {
    if (change === "sounds") void refreshZaicodeCustomSounds();
  });
  window.addEventListener("focus", () => void refreshZaicodeCustomSounds());
  void refreshZaicodeCustomSounds();
}

startZaicodeCustomSounds();

// ---------------------------------------------------------------- the folder, for the settings pages

export async function getZaicodeCustomizationInfo(): Promise<ZaicodeCustomizationInfo | null> {
  return (await getZaicodeCustomizationBridge()?.getZaicodeCustomizationInfo?.().catch(() => null)) ?? null;
}

export async function openZaicodeCustomizationFolder(request: { kind: ZaicodeCustomizationKind; file?: string }): Promise<{ ok: boolean; message: string }> {
  const bridge = getZaicodeCustomizationBridge();
  if (!bridge?.openZaicodeCustomization) return { ok: false, message: "Only the desktop app has a customization folder." };
  return bridge.openZaicodeCustomization(request).catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
}

// ---------------------------------------------------------------- presets: the source of `customization:<path>` sounds

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Where a preset's `customization:<path>` sounds come from and go to. Reading answers the file's bytes; writing puts
 * the file in the folder without replacing a different file of that name, and answers the id it ended up under (the
 * preset's settings follow it). No desktop, or a path the folder refuses: null, and the preset says the sound is missing.
 */
export const zaicodeCustomizationSoundSource: PresetSoundSource = {
  handles: (id) => id.startsWith("customization:"),
  read: async (id): Promise<OwnSound | null> => {
    const path = zaicodeCustomSoundPathOf(id);
    const bridge = getZaicodeCustomizationBridge();
    if (!path || !bridge?.readZaicodeCustomSound) return null;
    const result = await bridge.readZaicodeCustomSound(path).catch(() => null);
    return result?.ok ? { bytes: result.bytes, name: baseName(path), mime: soundMime(path) } : null;
  },
  write: async (id, sound) => {
    const path = zaicodeCustomSoundPathOf(id);
    const bridge = getZaicodeCustomizationBridge();
    if (!path || !bridge?.writeZaicodeCustomSound) return null;
    const result = await bridge.writeZaicodeCustomSound({ path, bytes: sound.bytes }).catch(() => null);
    if (!result?.ok) return null;
    // The watcher will say so too; asking now makes the new file playable by the time the settings name it.
    await refreshZaicodeCustomSounds();
    return zaicodeCustomSoundId(result.path);
  },
};
