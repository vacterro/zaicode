import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

const STORAGE_KEY = "zaicode-auto-session-title";
const CHANGE_EVENT = "zaicode-auto-session-title-changed";

function read(): boolean {
  try {
    return readZaicodeSetting(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useZaicodeAutoSessionTitle(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}

export function setZaicodeAutoSessionTitle(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // The preference stays at its default when local storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
