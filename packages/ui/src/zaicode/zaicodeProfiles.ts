import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { ZAICODE_PROFILE_ICON_SLOTS, type ZaicodeIconSlot } from "./zaicodeIconSlots.js";
import {
  applyZaicodeProfileBundle,
  captureZaicodeProfileBundle,
  parseZaicodeProfileBundle,
  zaicodeProfileBundleKey,
} from "./zaicodeProfileBundles.js";
import {
  addToZaicodeAvatarUploads,
  normalizeZaicodeAvatarUploads,
  type ZaicodeAvatarUpload,
} from "./zaicodeAvatarUploads.js";

export type { ZaicodeAvatarUpload } from "./zaicodeAvatarUploads.js";
export { ZAICODE_PROFILE_KEYS } from "./zaicodeProfileBundles.js";

/**
 * ZAICODE local operator profiles: a display name + a generic icon, kept on
 * this machine. They replace the upstream account "Connect" badge; they are
 * not accounts and carry no credentials.
 */
export interface ZaicodeProfile {
  id: string;
  name: string;
  icon: ZaicodeIconSlot;
  /**
   * Picture shown instead of the icon: `builtin:<file>` for a bundled default
   * avatar, or a `data:image/...` URI of the operator's own photo (downscaled
   * to 128x128 on upload). null/absent = use the icon.
   */
  avatar?: string | null;
}

const avatarFiles = import.meta.glob("../assets/zaicode-avatars/*.{png,jpg,jpeg,gif,webp}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Bundled default avatars (operator-supplied set), sorted by file name. */
export const ZAICODE_DEFAULT_AVATARS: readonly { id: string; label: string; url: string }[] =
  Object.entries(avatarFiles)
    .map(([path, url]) => {
      const file = path.split("/").at(-1) ?? path;
      return { id: `builtin:${file}`, label: file.replace(/\.[a-z]+$/i, ""), url };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

/** Resolves a stored avatar value to an image URL (or null when unusable). */
export function resolveZaicodeAvatarUrl(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  if (avatar.startsWith("builtin:")) {
    return ZAICODE_DEFAULT_AVATARS.find((entry) => entry.id === avatar)?.url ?? null;
  }
  return /^data:image\//i.test(avatar) ? avatar : null;
}

function isAvatar(value: unknown): value is string {
  return typeof value === "string" && resolveZaicodeAvatarUrl(value) !== null;
}

/** Max edge of an uploaded photo; keeps the data URI small enough for localStorage. */
const AVATAR_UPLOAD_EDGE = 128;

/**
 * Reads an image file, centre-crops it to a square and scales it to 128x128.
 * Returns a PNG data URI suitable for the profile `avatar` field.
 */
export async function readZaicodeAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file (PNG, JPG, GIF, WEBP).");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("This image could not be read."));
      element.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error("This image is empty.");
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_UPLOAD_EDGE;
    canvas.height = AVATAR_UPLOAD_EDGE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_UPLOAD_EDGE,
      AVATAR_UPLOAD_EDGE,
    );
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ZaicodeProfileState {
  profiles: ZaicodeProfile[];
  activeId: string;
}

const STORAGE_KEY = "zaicode-profiles";
const CHANGE_EVENT = "zaicode-profiles-changed";

const DEFAULT_STATE: ZaicodeProfileState = {
  profiles: [{ id: "default", name: "Operator", icon: "profile.user" }],
  activeId: "default",
};

function isProfileIcon(value: unknown): value is ZaicodeIconSlot {
  return typeof value === "string" && (ZAICODE_PROFILE_ICON_SLOTS as string[]).includes(value);
}

/** Drops malformed rows; an empty or broken store falls back to the default profile. */
export function normalizeZaicodeProfileState(raw: unknown): ZaicodeProfileState {
  if (!raw || typeof raw !== "object") return DEFAULT_STATE;
  const candidate = raw as { profiles?: unknown; activeId?: unknown };
  const profiles = Array.isArray(candidate.profiles)
    ? candidate.profiles.flatMap((row): ZaicodeProfile[] => {
        if (!row || typeof row !== "object") return [];
        const { id, name, icon, avatar } = row as Record<string, unknown>;
        if (typeof id !== "string" || !id || typeof name !== "string") return [];
        return [
          {
            id,
            name: name.trim() || "Profile",
            icon: isProfileIcon(icon) ? icon : "profile.user",
            avatar: isAvatar(avatar) ? avatar : null,
          },
        ];
      })
    : [];
  if (profiles.length === 0) return DEFAULT_STATE;
  const activeId =
    typeof candidate.activeId === "string" && profiles.some((p) => p.id === candidate.activeId)
      ? candidate.activeId
      : profiles[0]!.id;
  return { profiles, activeId };
}

let cached: ZaicodeProfileState | null = null;

function read(): ZaicodeProfileState {
  if (cached) return cached;
  try {
    const raw = readZaicodeSetting(STORAGE_KEY);
    cached = normalizeZaicodeProfileState(raw ? JSON.parse(raw) : null);
  } catch {
    cached = DEFAULT_STATE;
  }
  return cached;
}

function write(next: ZaicodeProfileState): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: keep in memory for this session
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function useZaicodeProfiles(): ZaicodeProfileState & { active: ZaicodeProfile } {
  const state = useSyncExternalStore(subscribe, read, read);
  const active = state.profiles.find((p) => p.id === state.activeId) ?? state.profiles[0]!;
  return { ...state, active };
}

function saveActiveBundle(state: ZaicodeProfileState): void {
  try {
    localStorage.setItem(zaicodeProfileBundleKey(state.activeId), JSON.stringify(captureZaicodeProfileBundle(localStorage)));
  } catch {
    // storage full: the profile keeps its previous bundle
  }
}

function reloadForProfile(): void {
  // Every settings store reads localStorage once at start: a reload is the one way all of
  // them (and upstream's theme / language) take the other profile's values together.
  if (typeof window !== "undefined") window.location.reload();
}

/**
 * Switches to profile `id` with all of its settings (SRC-043): the current
 * profile's settings are saved into its bundle, the other profile's bundle is
 * put in place and the window reloads. A profile that has no bundle yet (made
 * before SRC-043) starts from the current settings.
 */
export function selectZaicodeProfile(id: string): void {
  const state = read();
  if (id === state.activeId || !state.profiles.some((p) => p.id === id)) return;
  saveActiveBundle(state);
  const bundle = parseZaicodeProfileBundle(localStorage.getItem(zaicodeProfileBundleKey(id)));
  if (bundle) applyZaicodeProfileBundle(localStorage, bundle);
  write({ ...state, activeId: id });
  reloadForProfile();
}

/** A new profile starts as a copy of the current settings; nothing reloads. */
export function addZaicodeProfile(): void {
  const state = read();
  saveActiveBundle(state);
  const index = state.profiles.length;
  const id = `profile-${Date.now().toString(36)}`;
  const icon = ZAICODE_PROFILE_ICON_SLOTS[index % ZAICODE_PROFILE_ICON_SLOTS.length]!;
  write({
    profiles: [...state.profiles, { id, name: `Profile ${index + 1}`, icon }],
    activeId: id,
  });
}

export function updateZaicodeProfile(id: string, patch: Partial<Omit<ZaicodeProfile, "id">>): void {
  const state = read();
  write({
    ...state,
    profiles: state.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  });
}

/** The file kind an exported profile carries, so an import can tell it from other JSON. */
export const ZAICODE_PROFILE_FILE_KIND = "zaicode-profile";

/**
 * The profile in use as a file (SRC-048): its name, icon, picture and every
 * setting it keeps (ZAICODE_PROFILE_KEYS). No credentials: profiles hold none.
 */
export function exportZaicodeProfile(): { fileStem: string; json: string } {
  const state = read();
  const active = state.profiles.find((profile) => profile.id === state.activeId) ?? state.profiles[0]!;
  const bundle = captureZaicodeProfileBundle(localStorage);
  return {
    fileStem: active.name,
    json: JSON.stringify(
      { kind: ZAICODE_PROFILE_FILE_KIND, version: 1, name: active.name, icon: active.icon, avatar: active.avatar ?? null, bundle },
      null,
      2,
    ),
  };
}

/**
 * Adds the profile of an exported file and switches to it (the window
 * reloads). Only the known preference keys are ever written; anything else in
 * the file is ignored.
 */
export function importZaicodeProfile(json: string): { ok: boolean; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: "This file is not JSON." };
  }
  const value = (parsed ?? {}) as { kind?: unknown; name?: unknown; icon?: unknown; avatar?: unknown; bundle?: unknown };
  const bundle = value.kind === ZAICODE_PROFILE_FILE_KIND ? parseZaicodeProfileBundle(JSON.stringify(value.bundle ?? null)) : null;
  if (!bundle) return { ok: false, message: "No ZAICODE profile in this file (expected an export from Profiles → Export)." };
  const state = read();
  saveActiveBundle(state);
  const id = `profile-${Date.now().toString(36)}`;
  try {
    localStorage.setItem(zaicodeProfileBundleKey(id), JSON.stringify(bundle));
  } catch {
    return { ok: false, message: "Storage is full: the profile could not be saved." };
  }
  const taken = new Set(state.profiles.map((profile) => profile.name));
  const base = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 40) : "Imported";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
  write({
    ...state,
    profiles: [
      ...state.profiles,
      { id, name, icon: isProfileIcon(value.icon) ? value.icon : "profile.user", avatar: isAvatar(value.avatar) ? value.avatar : null },
    ],
  });
  selectZaicodeProfile(id);
  return { ok: true, message: `Imported profile “${name}”.` };
}

export function removeZaicodeProfile(id: string): void {
  const state = read();
  if (state.profiles.length <= 1) return;
  const profiles = state.profiles.filter((p) => p.id !== id);
  try {
    localStorage.removeItem(zaicodeProfileBundleKey(id));
  } catch {
    // nothing stored
  }
  if (state.activeId !== id) {
    write({ ...state, profiles });
    return;
  }
  // Removing the profile in use: the first remaining one takes over with its own settings.
  const next = profiles[0]!;
  const bundle = parseZaicodeProfileBundle(localStorage.getItem(zaicodeProfileBundleKey(next.id)));
  if (bundle) applyZaicodeProfileBundle(localStorage, bundle);
  write({ profiles, activeId: next.id });
  if (bundle) reloadForProfile();
}

/**
 * Uploaded photos list (SRC-035), pure parts in zaicodeAvatarUploads.ts.
 * Deleting one also clears it from every profile that shows it.
 */
const UPLOADS_KEY = "zaicode-avatar-uploads";
const UPLOADS_EVENT = "zaicode-avatar-uploads-changed";

let uploadsCached: ZaicodeAvatarUpload[] | null = null;

function readUploads(): ZaicodeAvatarUpload[] {
  if (uploadsCached) return uploadsCached;
  try {
    const raw = readZaicodeSetting(UPLOADS_KEY);
    uploadsCached = normalizeZaicodeAvatarUploads(raw ? JSON.parse(raw) : null);
  } catch {
    uploadsCached = [];
  }
  // Photos uploaded before the list existed are still in use: keep them in the list.
  const inUse = read().profiles.flatMap((profile) =>
    profile.avatar?.startsWith("data:image/") && !uploadsCached!.some((upload) => upload.dataUri === profile.avatar)
      ? [{ id: `upload-${profile.id}`, dataUri: profile.avatar, addedAt: 0 }]
      : [],
  );
  if (inUse.length > 0) uploadsCached = normalizeZaicodeAvatarUploads([...uploadsCached, ...inUse]);
  return uploadsCached;
}

function writeUploads(next: ZaicodeAvatarUpload[]): void {
  uploadsCached = next;
  try {
    localStorage.setItem(UPLOADS_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable or full: keep in memory for this session
  }
  window.dispatchEvent(new Event(UPLOADS_EVENT));
}

function subscribeUploads(listener: () => void): () => void {
  window.addEventListener(UPLOADS_EVENT, listener);
  return () => window.removeEventListener(UPLOADS_EVENT, listener);
}

export function useZaicodeAvatarUploads(): ZaicodeAvatarUpload[] {
  return useSyncExternalStore(subscribeUploads, readUploads, readUploads);
}

export function addZaicodeAvatarUpload(dataUri: string): void {
  writeUploads(addToZaicodeAvatarUploads(readUploads(), dataUri, Date.now()));
}

export function removeZaicodeAvatarUpload(id: string): void {
  const list = readUploads();
  const gone = list.find((upload) => upload.id === id);
  if (!gone) return;
  writeUploads(list.filter((upload) => upload.id !== id));
  const state = read();
  if (state.profiles.some((profile) => profile.avatar === gone.dataUri)) {
    write({
      ...state,
      profiles: state.profiles.map((profile) => (profile.avatar === gone.dataUri ? { ...profile, avatar: null } : profile)),
    });
  }
}
