/**
 * Operator-requested cleanup epoch and dispatch fence (PART 3 & 4).
 *
 * When the operator clicks CLEAR ALL SESSIONS, an epoch is established.
 * All automatic dispatches (auto retry, queue auto resume, crash resume,
 * goal continuations, autostart schedules) are fenced off so that cleared
 * or dying sessions cannot be resurrected while cleanup is reconciling.
 * Once cleanup reconciliation is durable, the fence is released for explicitly
 * new work.
 */

const EPOCH_STORAGE_KEY = "zaicode:cleanup_epoch";
const RETIRED_SESSIONS_STORAGE_KEY = "zaicode:retired_sessions:v1";
const MAX_RETIRED_SESSIONS = 5000;

function readStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function loadInitialEpoch(): number {
  const storage = readStorage();
  if (!storage) return 0;
  try {
    const raw = storage.getItem(EPOCH_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = Number(raw);
    // Cleanup epoch expires after 5 minutes if left orphaned by a hard crash
    if (Number.isFinite(parsed) && Date.now() - parsed < 5 * 60 * 1000) {
      return parsed;
    }
    storage.removeItem(EPOCH_STORAGE_KEY);
    return 0;
  } catch {
    return 0;
  }
}

function loadRetiredSessions(): Set<string> {
  const set = new Set<string>();
  const storage = readStorage();
  if (!storage) return set;
  try {
    const raw = storage.getItem(RETIRED_SESSIONS_STORAGE_KEY);
    if (!raw) return set;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === "string" && id) set.add(id);
      }
    }
  } catch {
    // Ignore parse errors
  }
  return set;
}

function saveRetiredSessions(set: Set<string>): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    const arr = [...set].slice(-MAX_RETIRED_SESSIONS);
    storage.setItem(RETIRED_SESSIONS_STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // Ignore storage write errors (e.g. quota exceeded)
  }
}

import { useSyncExternalStore } from "react";

export class RetiredSessionError extends Error {
  readonly code = "RETIRED_SESSION";
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Cannot acquire retired session: ${sessionId}`);
    this.name = "RetiredSessionError";
    this.sessionId = sessionId;
  }
}

export function isRetiredSessionError(error: unknown): error is RetiredSessionError {
  if (error instanceof RetiredSessionError) return true;
  if (typeof error === "object" && error !== null) {
    const err = error as { code?: string; name?: string; message?: string };
    if (err.code === "RETIRED_SESSION" || err.name === "RetiredSessionError") return true;
    if (typeof err.message === "string" && err.message.startsWith("Cannot acquire retired session:")) {
      return true;
    }
  }
  return false;
}

export type SessionRetirementListener = (retiredSessionIds: readonly string[]) => void;
const retirementListeners = new Set<SessionRetirementListener>();

export function subscribeSessionRetirement(listener: SessionRetirementListener): () => void {
  retirementListeners.add(listener);
  return () => {
    retirementListeners.delete(listener);
  };
}

export function notifySessionRetirement(retiredSessionIds: readonly string[]): void {
  if (retiredSessionIds.length === 0) return;
  for (const id of retiredSessionIds) {
    retiredSessions.add(id);
  }
  for (const listener of retirementListeners) {
    try {
      listener(retiredSessionIds);
    } catch {
      // Ignore listener error
    }
  }
}

export function useIsSessionRetired(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribeSessionRetirement,
    () => isSessionRetired(sessionId),
    () => isSessionRetired(sessionId),
  );
}

let activeCleanupEpoch = loadInitialEpoch();
const retiredSessions = loadRetiredSessions();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  try {
    window.addEventListener("storage", (e) => {
      if (e.key === EPOCH_STORAGE_KEY) {
        activeCleanupEpoch = loadInitialEpoch();
      } else if (e.key === RETIRED_SESSIONS_STORAGE_KEY) {
        const updated = loadRetiredSessions();
        const newlyRetired: string[] = [];
        for (const id of updated) {
          if (!retiredSessions.has(id)) {
            retiredSessions.add(id);
            newlyRetired.push(id);
          }
        }
        if (newlyRetired.length > 0) {
          notifySessionRetirement(newlyRetired);
        }
      }
    });
  } catch {
    // Ignore in non-browser context
  }
}

export function startZaicodeCleanupEpoch(): number {
  activeCleanupEpoch = Date.now();
  const storage = readStorage();
  if (storage) {
    try {
      storage.setItem(EPOCH_STORAGE_KEY, String(activeCleanupEpoch));
    } catch {
      // Ignore storage error
    }
  }
  return activeCleanupEpoch;
}

export function releaseZaicodeCleanupEpoch(epoch?: number): void {
  if (epoch === undefined || activeCleanupEpoch === epoch) {
    activeCleanupEpoch = 0;
    const storage = readStorage();
    if (storage) {
      try {
        storage.removeItem(EPOCH_STORAGE_KEY);
      } catch {
        // Ignore storage error
      }
    }
  }
}

export function isZaicodeCleanupInProgress(): boolean {
  return activeCleanupEpoch > 0;
}

export function currentZaicodeCleanupEpoch(): number {
  return activeCleanupEpoch;
}

export function retireSessions(sessionIds: readonly string[]): void {
  let changed = false;
  const newlyRetired: string[] = [];
  for (const id of sessionIds) {
    if (id && !retiredSessions.has(id)) {
      retiredSessions.add(id);
      newlyRetired.push(id);
      changed = true;
    }
  }
  if (changed) {
    saveRetiredSessions(retiredSessions);
    notifySessionRetirement(newlyRetired);
  }
}

export function isSessionRetired(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return retiredSessions.has(sessionId);
}

export function resetZaicodeCleanupFenceForTest(): void {
  activeCleanupEpoch = 0;
  retiredSessions.clear();
  retirementListeners.clear();
  const storage = readStorage();
  if (storage) {
    try {
      storage.removeItem(EPOCH_STORAGE_KEY);
      storage.removeItem(RETIRED_SESSIONS_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}
