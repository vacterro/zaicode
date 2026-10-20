import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";
import { logger } from "@/logger.js";
import { matchZaicodeHotkey } from "./zaicodeHotkeys.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * ZAICODE one-click archive with Ctrl+Z restore.
 *
 * Archiving no longer asks for a second confirming click; instead every
 * archive (single session, "Archive all" of a project, or "Archive all" of
 * every project) pushes one undo entry. Ctrl+Z restores the most recent batch
 * when focus is outside a text field, or inside an EMPTY one (archiving the
 * open session lands the focus in a fresh, empty composer, which used to
 * swallow the shortcut). The notice under the sidebar also has an Undo button.
 */
export interface ZaicodeArchiveUndoEntry {
  label: string;
  restore: () => Promise<void>;
}

interface StoredEntry extends ZaicodeArchiveUndoEntry {
  at: number;
}

/** One archive batch: what was archived and how to bring it back. */
export interface ZaicodeArchiveBatch {
  count: number;
  label: string;
  restore: () => Promise<void>;
  /**
   * Exactly which sessions this batch put away, when the caller can name them.
   * CLEAR ALL DONE reads these to report per-item results; the batch's undo
   * restore is unchanged either way.
   */
  archivedIds?: readonly string[];
  /** Sessions the handler declined (for example still running under it). */
  skippedIds?: readonly string[];
  /** Sessions the handler tried and could not archive, with the reason each one gave. */
  failedIds?: readonly { sessionId: string; reason: string }[];
}

/**
 * CLEAR ALL DONE's accountable archive result: a project whose handler is not
 * registered, or whose handler threw, is REPORTED rather than silently skipped,
 * because a silently dropped request looks exactly like a finished one.
 */
export interface ZaicodeArchiveOutcome {
  archived: { projectKey: string; sessionId: string }[];
  /** No handler for this project key: the row is unmounted, read-only or not a ZAICODE row. */
  unregistered: { projectKey: string; sessionIds: string[] }[];
  failed: { projectKey: string; sessionIds: string[]; reason: string }[];
  skipped: { projectKey: string; sessionIds: string[] }[];
}

const MAX_ENTRIES = 50;
/** Ctrl+Z typed inside an empty text field only reaches archives this recent. */
const EMPTY_FIELD_UNDO_WINDOW_MS = 15 * 60_000;

interface ZaicodeArchiveUndoState {
  entries: StoredEntry[];
  /** Last outcome, shown briefly by the listener host (e.g. "Restored 3 sessions"). */
  notice: string | null;
  /** True while the notice offers an Undo button (i.e. it announces an archive). */
  noticeUndoable: boolean;
  push: (entry: ZaicodeArchiveUndoEntry) => void;
  undo: () => Promise<boolean>;
  /** Makes a failed archive visible instead of silently leaving the row in place. */
  fail: (error: unknown) => void;
  clearNotice: () => void;
}

export const useZaicodeArchiveUndo = create<ZaicodeArchiveUndoState>((set, get) => ({
  entries: [],
  notice: null,
  noticeUndoable: false,
  push: (entry) => {
    playZaicodeSound("session.archive");
    set((state) => ({
      entries: [...state.entries, { ...entry, at: Date.now() }].slice(-MAX_ENTRIES),
      notice: `Archived ${entry.label} — Ctrl+Z restores`,
      noticeUndoable: true,
    }));
  },
  undo: async () => {
    const entries = get().entries;
    const last = entries.at(-1);
    if (!last) return false;
    set({ entries: entries.slice(0, -1), notice: `Restoring ${last.label}…`, noticeUndoable: false });
    try {
      await last.restore();
      playZaicodeSound("session.restore");
      set({ notice: `Restored ${last.label}` });
      return true;
    } catch (error) {
      logger.error("[zaicode-archive-undo] restore failed", { error });
      set({ notice: `Restore failed: ${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
  },
  fail: (error) =>
    set({
      notice: `Archive failed: ${error instanceof Error ? error.message : String(error)}`,
      noticeUndoable: false,
    }),
  clearNotice: () => set({ notice: null, noticeUndoable: false }),
}));

/**
 * Per-project "archive every idle session" handlers, registered by the
 * sidebar project rows so a single right-click can archive everywhere.
 */
type ArchiveAllHandler = () => Promise<ZaicodeArchiveBatch | null>;
const archiveAllHandlers = new Map<string, ArchiveAllHandler>();

export function registerZaicodeArchiveAll(key: string, handler: ArchiveAllHandler): () => void {
  archiveAllHandlers.set(key, handler);
  publishArchiveHandles();
  return () => {
    if (archiveAllHandlers.get(key) === handler) {
      archiveAllHandlers.delete(key);
      publishArchiveHandles();
    }
  };
}

/** Archives the given sessions of one project (CLEAR ALL DONE, SRC-044); registered by project rows. */
type ArchiveSomeHandler = (taskIds: readonly string[]) => Promise<ZaicodeArchiveBatch | null>;
const archiveSomeHandlers = new Map<string, ArchiveSomeHandler>();

export function registerZaicodeArchiveSome(key: string, handler: ArchiveSomeHandler): () => void {
  archiveSomeHandlers.set(key, handler);
  publishArchiveHandles();
  return () => {
    if (archiveSomeHandlers.get(key) === handler) {
      archiveSomeHandlers.delete(key);
      publishArchiveHandles();
    }
  };
}

let archiveHandlesVersion = 0;
const archiveHandleListeners = new Set<() => void>();
function publishArchiveHandles(): void {
  archiveHandlesVersion += 1;
  for (const listener of archiveHandleListeners) listener();
}

/** Archives `taskIds` per project key; one Ctrl+Z restores all of them. */
export async function archiveZaicodeSessions(byProject: ReadonlyMap<string, readonly string[]>): Promise<ZaicodeArchiveOutcome> {
  const outcome: ZaicodeArchiveOutcome = { archived: [], unregistered: [], failed: [], skipped: [] };
  const batches: ZaicodeArchiveBatch[] = [];
  for (const [key, ids] of byProject) {
    const handler = archiveSomeHandlers.get(key);
    // The requested work is not silently dropped: the caller reports it as
    // unavailable, and the counter keeps showing it as still actionable.
    if (!handler) {
      if (ids.length > 0) outcome.unregistered.push({ projectKey: key, sessionIds: [...ids] });
      continue;
    }
    if (ids.length === 0) continue;
    try {
      const batch = await handler(ids);
      const done = batch && batch.count > 0;
      if (done) batches.push(batch);
      const archivedIds = batch?.archivedIds ? [...batch.archivedIds] : done ? [] : [];
      for (const sessionId of archivedIds) outcome.archived.push({ projectKey: key, sessionId });
      for (const failure of batch?.failedIds ?? []) {
        outcome.failed.push({ projectKey: key, sessionIds: [failure.sessionId], reason: failure.reason });
      }
      const accounted = new Set([
        ...archivedIds,
        ...(batch?.failedIds ?? []).map((failure) => failure.sessionId),
      ]);
      const declined = batch?.skippedIds
        ? [...batch.skippedIds]
        : done || batch?.archivedIds
          ? ids.filter((sessionId) => !accounted.has(sessionId))
          : [...ids];
      if (declined.length > 0) outcome.skipped.push({ projectKey: key, sessionIds: declined });
      if (!done && declined.length === 0 && accounted.size === 0 && ids.length > 0) {
        outcome.skipped.push({ projectKey: key, sessionIds: [...ids] });
      }
    } catch (error) {
      logger.error("[zaicode-archive-undo] archive some: project failed", { error });
      outcome.failed.push({
        projectKey: key,
        sessionIds: [...ids],
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const total = batches.reduce((sum, batch) => sum + batch.count, 0);
  if (total > 0) {
    pushZaicodeArchiveBatch({
      count: total,
      label: `${total} finished session${total === 1 ? "" : "s"}`,
      restore: async () => {
        for (const batch of batches) await batch.restore();
      },
    });
  }
  return outcome;
}

/** Whether a project's archive-some handler is registered right now (CLEAR ALL DONE pre-check). */
export function hasZaicodeArchiveSomeHandler(projectKey: string): boolean {
  return archiveSomeHandlers.has(projectKey);
}

/**
 * Re-renders when an archive handler mounts or unmounts, so the button stops
 * advertising work whose project row is not there (like useZaicodeContinueHandlesVersion).
 */
export function useZaicodeArchiveHandlesVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      archiveHandleListeners.add(listener);
      return () => archiveHandleListeners.delete(listener);
    },
    () => archiveHandlesVersion,
    () => archiveHandlesVersion,
  );
}

/** Pushes one undo entry for a finished batch (no-op when nothing was archived). */
export function pushZaicodeArchiveBatch(batch: ZaicodeArchiveBatch | null): void {
  if (!batch || batch.count === 0) return;
  useZaicodeArchiveUndo.getState().push({ label: batch.label, restore: batch.restore });
}

/** Archives every idle session in every project in the sidebar; one Ctrl+Z restores all of them. */
export async function archiveAllZaicodeSessionsEverywhere(): Promise<number> {
  const batches: ZaicodeArchiveBatch[] = [];
  for (const handler of [...archiveAllHandlers.values()]) {
    try {
      const batch = await handler();
      if (batch && batch.count > 0) batches.push(batch);
    } catch (error) {
      logger.error("[zaicode-archive-undo] archive all: project failed", { error });
    }
  }
  const total = batches.reduce((sum, batch) => sum + batch.count, 0);
  if (total === 0) {
    useZaicodeArchiveUndo.setState({ notice: "Nothing to archive: no idle sessions", noticeUndoable: false });
    return 0;
  }
  pushZaicodeArchiveBatch({
    count: total,
    label: `${total} session${total === 1 ? "" : "s"} in ${batches.length} project${batches.length === 1 ? "" : "s"}`,
    restore: async () => {
      for (const batch of batches) await batch.restore();
    },
  });
  return total;
}

/**
 * Where Ctrl+Z belongs: "editor" when a text field holds text of its own
 * (it keeps its native undo), "empty-field" for an empty field, "none" for
 * anything else.
 */
export function classifyUndoTarget(target: EventTarget | null): "editor" | "empty-field" | "none" {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return "none";
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value.length > 0 ? "editor" : "empty-field";
  }
  if (target instanceof HTMLSelectElement) return "editor";
  const editable = target.isContentEditable
    ? target
    : target.closest<HTMLElement>("[contenteditable=true], [contenteditable='']");
  if (!editable) return "none";
  return (editable.textContent ?? "").trim().length > 0 ? "editor" : "empty-field";
}

/** Installs the global Ctrl+Z listener (text fields with text keep their own undo). Mount once. */
export function useZaicodeArchiveUndoShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl+Z by default (Settings -> Hotkeys), by physical key.
      if (!matchZaicodeHotkey("session.archiveUndo", event)) return;
      const last = useZaicodeArchiveUndo.getState().entries.at(-1);
      if (!last) return;
      const where = classifyUndoTarget(event.target);
      if (where === "editor") return;
      if (where === "empty-field" && Date.now() - last.at > EMPTY_FIELD_UNDO_WINDOW_MS) return;
      event.preventDefault();
      event.stopPropagation();
      void useZaicodeArchiveUndo.getState().undo();
    };
    // 捕获阶段：编辑器（Lexical）在自己的节点上处理 Ctrl+Z，冒泡到 window 前可能已被吞掉。
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
