import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import { isTaskNotificationSoundEnabled } from "@/lib/taskNotificationPreferences.js";
import { isZaicodeProductMode } from "@zcode/shared";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { eager: true; query: string; import: string },
    ): Record<string, string>;
  }
}

const SELECTION_KEY = "zaicode-notification-sound";
const CUSTOM_NAME_KEY = "zaicode-notification-custom-sound-name";
const CUSTOM_ID = "custom";
const DEFAULT_ID = "default";
const DB_NAME = "zaicode-notification-audio";
const STORE_NAME = "sounds";

const fastPrompterFiles = import.meta.glob(
  "../assets/fastprompter-sounds/**/*.{wav,mp3,ogg}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const fastPrompterSounds = Object.entries(fastPrompterFiles)
  .map(([path, url]) => ({
    id: `fastprompter:${path.split("/fastprompter-sounds/")[1]}`,
    label: path.split("/fastprompter-sounds/")[1] ?? path,
    url,
  }))
  .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

const fastPrompterUrls = new Map(fastPrompterSounds.map(({ id, url }) => [id, url]));
let audio: HTMLAudioElement | null = null;
let audioUrl = "";
let customObjectUrl: string | null = null;

export function listTaskNotificationSounds(): readonly { id: string; label: string }[] {
  return fastPrompterSounds;
}

/** URL of a bundled FastPrompter sound id (`fastprompter:<file>`), or null. */
export function getTaskNotificationSoundUrl(id: string): string | null {
  return fastPrompterUrls.get(id) ?? null;
}

export function getTaskNotificationSoundSelection(): string {
  try {
    return localStorage.getItem(SELECTION_KEY) || DEFAULT_ID;
  } catch {
    return DEFAULT_ID;
  }
}

export function getCustomTaskNotificationSoundName(): string | null {
  try {
    return localStorage.getItem(CUSTOM_NAME_KEY);
  } catch {
    return null;
  }
}

export function setTaskNotificationSoundSelection(id: string): void {
  if (id !== DEFAULT_ID && id !== CUSTOM_ID && !fastPrompterUrls.has(id)) return;
  try {
    localStorage.setItem(SELECTION_KEY, id);
  } catch {
    // The current page can still preview the selection when storage is unavailable.
  }
}

function openSoundDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCustomSound(): Promise<Blob | null> {
  const db = await openSoundDatabase();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(CUSTOM_ID);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function importCustomTaskNotificationSound(file: File): Promise<void> {
  if (!/\.(wav|mp3|ogg)$/i.test(file.name)) throw new Error("Choose a WAV, MP3, or OGG file.");
  const db = await openSoundDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(file, CUSTOM_ID);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
  if (customObjectUrl) URL.revokeObjectURL(customObjectUrl);
  customObjectUrl = null;
  try {
    localStorage.setItem(CUSTOM_NAME_KEY, file.name);
  } catch {
    // Audio itself remains stored in IndexedDB.
  }
  setTaskNotificationSoundSelection(CUSTOM_ID);
}

async function selectedSoundUrl(): Promise<string | null> {
  const selection = getTaskNotificationSoundSelection();
  if (selection === DEFAULT_ID) return taskNotificationPopUrl;
  if (selection === CUSTOM_ID) {
    if (!customObjectUrl) {
      const blob = await readCustomSound();
      if (!blob) return null;
      customObjectUrl = URL.createObjectURL(blob);
    }
    return customObjectUrl;
  }
  return fastPrompterUrls.get(selection) ?? taskNotificationPopUrl;
}

async function play(preview: boolean): Promise<boolean> {
  if (!preview && !isTaskNotificationSoundEnabled()) return false;
  if (typeof Audio === "undefined") return false;
  try {
    const url = await selectedSoundUrl();
    if (!url) return false;
    if (!audio || audioUrl !== url) {
      audio?.pause();
      audio = new Audio(url);
      audio.preload = "auto";
      audioUrl = url;
    }
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

export async function playTaskNotificationSound(): Promise<void> {
  // ZAICODE：每类事件有自己的提示音（zaicodeCues），渲染层已按事件播放；这里不再叠加通用 pop。
  if (isZaicodeProductMode()) return;
  await play(false);
}

export async function previewTaskNotificationSound(): Promise<boolean> {
  return play(true);
}
