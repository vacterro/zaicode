import { useSyncExternalStore } from "react";
import type { ProtrailConfig } from "./protrailModel.js";

/**
 * A game-local ProTrail override (SAIASUI, T-105). While a game runs it forces
 * the in-window ProTrail canvas on with a live config, WITHOUT touching the
 * user's saved ProTrail preference: the store's `enabled`/`everywhere` are left
 * exactly as they were, so exit restores the previous runtime state for free.
 *
 * It is never persisted and holds no listeners of its own; the single overlay
 * that reads it simply switches source while a value is present. Setting null
 * (game exit, unmount) reverts the overlay to the saved config.
 */

let forced: ProtrailConfig | null = null;
const listeners = new Set<() => void>();

export function setZaicodeProtrailForced(config: ProtrailConfig | null): void {
  forced = config;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ProtrailConfig | null {
  return forced;
}

/** The forced game-local config, or null when no game is overriding ProTrail. */
export function useZaicodeProtrailForced(): ProtrailConfig | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
