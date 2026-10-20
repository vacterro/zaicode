import { useSyncExternalStore } from "react";
import type { ZaicodeProjectContinueHandle } from "./zaicodeContinue.js";

const handles = new Map<string, ZaicodeProjectContinueHandle>();
let version = 0;
const listeners = new Set<() => void>();
function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** A restored goal waits for its connection without spending its opportunity. */
export function useZaicodeContinueHandlesVersion(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => version, () => version);
}

export function registerZaicodeProjectContinue(projectKey: string, handle: ZaicodeProjectContinueHandle): () => void {
  handles.set(projectKey, handle);
  publish();
  return () => {
    if (handles.get(projectKey) === handle) { handles.delete(projectKey); publish(); }
  };
}

export function zaicodeProjectContinueHandle(projectKey: string): ZaicodeProjectContinueHandle | null {
  return handles.get(projectKey) ?? null;
}
