/* oxlint-disable eslint(max-lines) -- saipen state, pending commands and fresh session coordinator */
import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { resolveWorkspaceKey, type ZaicodeSaipenProjection } from "@zcode/shared";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { toast, type ToastOptions } from "@/components/ui/toast.js";
import { zaicodeMainKeyForm, type ZaicodeModeAction } from "./zaicodeMainSession.js";
import { formatIntentFeedback, useZaicodeActionIntents } from "./zaicodeActionIntent.js";
import {
  describeZaicodeSaipenReadError,
  isZaicodeSaipenMissingFileError,
  parseSaipenBoard,
  parseSaipenLastAction,
  parseSaipenState,
  type ZaicodeSaipenSnapshot,
} from "./zaicodeSaipenModel.js";
import {
  parseSaipenBoardTickets,
  parseSaipenLogLines,
  parseSaipenStateFields,
} from "./zaicodeSaipenDetail.js";

export { ZAICODE_SAIPEN_SHORTCUTS, type ZaicodeSaipenSnapshot } from "./zaicodeSaipenModel.js";

const POLL_MS = 3000;
/** Projects without `.saipen/` are re-checked rarely (someone may run `saipen set`). */
const MISSING_POLL_MS = 15000;
/** Enough LOG tail for the SAIPEN side pane (~100 recent events). */
const LOG_TAIL_BYTES = 24576;
const BOARD_BYTES = 65536;
const STATE_BYTES = 8192;
/**
 * A projection that says "an operation is pending" is asked again this often
 * even when STATE did not move: the pending journal can clear without another
 * checkpoint, and RECOVERY then hung on a project with no chats (SRC-049).
 */
export const ZAICODE_SAIPEN_PENDING_RECHECK_MS = 10_000;

/** Whether a snapshot's projection must be asked again although STATE did not change. */
export function zaicodeSaipenNeedsRecheck(
  projection: ZaicodeSaipenProjection | null | undefined,
  askedAt: number,
  now: number,
): boolean {
  return Boolean(projection?.recoveryPending) && now - askedAt >= ZAICODE_SAIPEN_PENDING_RECHECK_MS;
}

type FileService = ReturnType<typeof useWorkspaceServices>["fileService"];

interface ProjectionBridge {
  getZaicodeSaipenProjection?(projectPath: string): Promise<ZaicodeSaipenProjection | null>;
}
type Listener = (snapshot: ZaicodeSaipenSnapshot | null) => void;

/**
 * One poller per project, shared by every consumer (composer strip, SAIPEN
 * menu, ...). STATE.md is the change signal: its `last_event` moves on every
 * SAIPEN checkpoint, so BOARD.md and the LOG tail are re-read only when STATE
 * changed. Paused while the window is hidden.
 */
class SaipenPoller {
  private readonly listeners = new Set<Listener>();
  private snapshot: ZaicodeSaipenSnapshot | null = null;
  private lastState: string | null = null;
  private logSize = 0;
  private timer: number | null = null;
  private running = false;
  private askedAt = 0;

  constructor(
    private readonly root: string,
    private readonly fileService: FileService,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    if (this.listeners.size === 1) void this.tick();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  get idle(): boolean {
    return this.listeners.size === 0;
  }

  private schedule(delay: number) {
    if (this.listeners.size === 0) return;
    this.timer = window.setTimeout(() => void this.tick(), delay);
  }

  private emit(snapshot: ZaicodeSaipenSnapshot | null) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private async readLogTail(): Promise<string> {
    const path = `${this.root}/LOG.md`;
    let slice = await this.fileService.readTextFile({
      path,
      offset: Math.max(0, this.logSize - LOG_TAIL_BYTES),
      length: LOG_TAIL_BYTES,
    });
    if (slice.truncated) {
      slice = await this.fileService.readTextFile({
        path,
        offset: Math.max(0, slice.totalBytes - LOG_TAIL_BYTES),
        length: LOG_TAIL_BYTES,
      });
    }
    this.logSize = slice.totalBytes;
    return slice.content;
  }

  /** SAIPEN's own projection for the read model; the desktop main process runs and caches it. */
  private async askProjection(snapshot: ZaicodeSaipenSnapshot) {
    const bridge =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as { zcode?: ProjectionBridge }).zcode;
    if (!bridge?.getZaicodeSaipenProjection) return;
    this.askedAt = Date.now();
    const projectPath = this.root.replace(/[\\/]\.saipen$/, "");
    try {
      const projection = await bridge.getZaicodeSaipenProjection(projectPath);
      // A newer STATE may have arrived meanwhile: attach only to the snapshot it was asked for.
      if (this.snapshot === snapshot) this.emit({ ...snapshot, projection: projection ?? null });
    } catch {
      if (this.snapshot === snapshot) this.emit({ ...snapshot, projection: null });
    }
  }

  private async tick() {
    this.timer = null;
    if (this.running || this.listeners.size === 0) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.schedule(POLL_MS);
      return;
    }
    this.running = true;
    let delay = POLL_MS;
    try {
      const state = await this.fileService.readTextFile({
        path: `${this.root}/STATE.md`,
        length: STATE_BYTES,
      });
      if (state.content !== this.lastState || !this.snapshot) {
        const [board, log] = await Promise.all([
          this.fileService
            .readTextFile({ path: `${this.root}/BOARD.md`, length: BOARD_BYTES })
            .then((slice) => slice.content)
            .catch(() => ""),
          this.readLogTail().catch(() => ""),
        ]);
        this.lastState = state.content;
        const previousProjection = this.snapshot?.projection;
        this.emit({
          // Keep the last projection until the new one arrives: no flicker to the file-only answer.
          ...(previousProjection !== undefined ? { projection: previousProjection } : {}),
          ...parseSaipenState(state.content),
          ...parseSaipenBoard(board),
          ...parseSaipenLastAction(log),
          detail: {
            state: parseSaipenStateFields(state.content),
            tickets: parseSaipenBoardTickets(board),
            log: parseSaipenLogLines(log),
          },
        });
        if (this.snapshot) void this.askProjection(this.snapshot);
      } else if (
        this.snapshot &&
        zaicodeSaipenNeedsRecheck(this.snapshot.projection, this.askedAt, Date.now())
      ) {
        void this.askProjection(this.snapshot);
      }
    } catch (error) {
      this.lastState = null;
      // SRC-114: a read failure and an absent directory used to be the same
      // null, so a permissions error was shown as "no .saipen/ memory yet".
      // Only a genuinely missing directory keeps that answer.
      if (isZaicodeSaipenMissingFileError(error)) {
        if (this.snapshot !== null) this.emit(null);
      } else {
        this.emit({
          ...parseSaipenState(""),
          ...parseSaipenBoard(""),
          ...parseSaipenLastAction(""),
          detail: { state: [], tickets: [], log: [] },
          readError: describeZaicodeSaipenReadError(error),
        });
      }
      delay = MISSING_POLL_MS;
    } finally {
      this.running = false;
      this.schedule(delay);
    }
  }

  /** Ask again now: the RETRY in an unreadable-state pane, and nothing else. */
  recheck(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    void this.tick();
  }
}

/** Cache key for the shared per-project poller (T-289: identity-scoped). */
export function zaicodeSaipenPollerKey(workspacePath: string, workspaceIdentity?: string): string {
  return resolveWorkspaceKey({ workspacePath, workspaceIdentity });
}

const pollers = new Map<string, SaipenPoller>();

function acquirePoller(
  workspacePath: string,
  fileService: FileService,
  workspaceIdentity?: string,
): SaipenPoller {
  const root = `${workspacePath.replace(/[\\/]+$/, "")}/.saipen`;
  const key = zaicodeSaipenPollerKey(workspacePath, workspaceIdentity);
  let poller = pollers.get(key);
  if (!poller) {
    poller = new SaipenPoller(root, fileService);
    pollers.set(key, poller);
  }
  return poller;
}

export function useZaicodeSaipen(
  workspacePath: string,
  workspaceIdentity?: string,
): ZaicodeSaipenSnapshot | null {
  const { fileService } = useWorkspaceServices(workspacePath, undefined, workspaceIdentity);
  const [snapshot, setSnapshot] = useState<ZaicodeSaipenSnapshot | null>(null);

  useEffect(() => {
    if (!workspacePath) {
      setSnapshot(null);
      return;
    }
    const poller = acquirePoller(workspacePath, fileService, workspaceIdentity);
    const unsubscribe = poller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      if (poller.idle) {
        for (const [key, value] of pollers) if (value === poller) pollers.delete(key);
      }
    };
  }, [fileService, workspacePath, workspaceIdentity]);

  return snapshot;
}

/**
 * Ask the shared poller for a fresh read now. Used by the SAIPEN pane's RETRY
 * when `.saipen/` exists but could not be read: without it the only way out of
 * that state was to wait for the next poll, with nothing on screen to press.
 */
export function useZaicodeSaipenRefresh(
  workspacePath: string,
  workspaceIdentity?: string,
): () => void {
  const { fileService } = useWorkspaceServices(workspacePath, undefined, workspaceIdentity);
  return useCallback(() => {
    if (!workspacePath) return;
    acquirePoller(workspacePath, fileService, workspaceIdentity).recheck();
  }, [fileService, workspacePath]);
}

/**
 * One-shot command queued for a workspace's next composer (e.g. the project
 * row START button: open a fresh chat, then send `cc`). The SAIPEN strip in
 * that composer consumes it once the composer can submit.
 */
interface PendingTarget {
  workspaceIdentity?: string;
  /** null means a fresh draft, never an arbitrary existing session. */
  sessionId?: string | null;
}

export interface ZaicodePendingCommandItem {
  command: string;
  action?: ZaicodeModeAction;
  intentId?: string | null;
}

interface ZaicodePendingCommandState {
  byWorkspace: Record<string, ZaicodePendingCommandItem[]>;
  queue: (
    workspacePath: string,
    command: string,
    target?: PendingTarget,
    action?: ZaicodeModeAction,
    intentId?: string | null,
  ) => void;
  take: (
    workspacePath: string,
    target?: PendingTarget,
  ) => ZaicodePendingCommandItem | null;
  peek: (
    workspacePath: string,
    target?: PendingTarget,
  ) => ZaicodePendingCommandItem | null;
  restore: (
    workspacePath: string,
    item: ZaicodePendingCommandItem,
    target?: PendingTarget,
  ) => void;
  removeByIntent: (
    workspacePath: string,
    intentId: string,
    target?: PendingTarget,
  ) => boolean;
}

function workspaceCommandKey(workspacePath: string, target?: PendingTarget): string {
  return JSON.stringify([
    zaicodeMainKeyForm(target?.workspaceIdentity?.trim() || workspacePath),
    target?.sessionId ?? null,
  ]);
}

export const useZaicodePendingCommand = create<ZaicodePendingCommandState>((set, get) => ({
  byWorkspace: {},
  queue: (workspacePath, command, target, action, intentId) =>
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceCommandKey(workspacePath, target)]: [
          ...(state.byWorkspace[workspaceCommandKey(workspacePath, target)] ?? []),
          { command, ...(action ? { action } : {}), ...(intentId ? { intentId } : {}) },
        ],
      },
    })),
  take: (workspacePath, target) => {
    const key = workspaceCommandKey(workspacePath, target);
    const entries = get().byWorkspace[key] ?? [];
    let validIndex = -1;
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      if (!item) continue;
      if (item.intentId) {
        const intent = useZaicodeActionIntents.getState().intents[item.intentId];
        if (intent && (intent.state === "REJECTED" || intent.state === "CANCELLED")) {
          continue;
        }
      }
      validIndex = i;
      break;
    }
    if (validIndex === -1) {
      if (entries.length > 0) {
        const next = { ...get().byWorkspace };
        delete next[key];
        set({ byWorkspace: next });
      }
      return null;
    }
    const command = entries[validIndex] ?? null;
    const nextEntries = entries.filter((_, idx) => idx !== validIndex);
    const next = { ...get().byWorkspace };
    if (nextEntries.length > 0) next[key] = nextEntries;
    else delete next[key];
    set({ byWorkspace: next });
    return command;
  },
  peek: (workspacePath, target) => {
    const key = workspaceCommandKey(workspacePath, target);
    const entries = get().byWorkspace[key] ?? [];
    for (const item of entries) {
      if (item.intentId) {
        const intent = useZaicodeActionIntents.getState().intents[item.intentId];
        if (intent && (intent.state === "REJECTED" || intent.state === "CANCELLED")) {
          continue;
        }
      }
      return item;
    }
    return null;
  },
  restore: (workspacePath, item, target) => {
    const key = workspaceCommandKey(workspacePath, target);
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [key]: [item, ...(state.byWorkspace[key] ?? [])],
      },
    }));
  },
  removeByIntent: (workspacePath, intentId, target) => {
    const key = workspaceCommandKey(workspacePath, target);
    const entries = get().byWorkspace[key] ?? [];
    const filtered = entries.filter((e) => e.intentId !== intentId);
    if (filtered.length !== entries.length) {
      const next = { ...get().byWorkspace };
      if (filtered.length > 0) next[key] = filtered;
      else delete next[key];
      set({ byWorkspace: next });
      return true;
    }
    return false;
  },
}));

export function hasZaicodePendingCommand(
  state: ZaicodePendingCommandState,
  workspacePath: string,
  target?: PendingTarget,
): boolean {
  return Boolean(state.byWorkspace[workspaceCommandKey(workspacePath, target)]?.length);
}

/**
 * Request for a brand-new session in a project (CLEAR in "open a new session"
 * mode, the helper-mode buttons of the strip, the sidebar project START). The
 * shell layout owns draft creation, so the request is published here and
 * consumed there once; an optional command is queued for the fresh composer to
 * send. The composer's own START button does NOT come through here any more: a
 * plain click sends the goal in the session that has focus (T-318).
 */
export interface ZaicodeFreshSessionRequest {
  id: number;
  workspacePath: string;
  workspaceIdentity?: string;
  command: string | null;
  action?: ZaicodeModeAction;
  originSessionId?: string | null;
  intentId?: string | null;
  generation?: number;
  destination?: "main" | "helper";
}

export interface ZaicodeSessionCreationAck {
  sessionId: string;
  requestId?: number;
  intentId?: string | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  destination?: "main" | "helper";
  generation?: number;
}

interface ZaicodeFreshSessionState {
  request: ZaicodeFreshSessionRequest | null;
  queue: ZaicodeFreshSessionRequest[];
  currentId: number | null;
  generationCounter: number;
  open: (
    workspacePath: string,
    workspaceIdentity: string | undefined,
    command: string | null,
    action?: ZaicodeModeAction,
    originSessionId?: string | null,
    intentId?: string | null,
  ) => void;
  consume: (id: number) => void;
  confirmSession: (ack: string | ZaicodeSessionCreationAck) => boolean;
  advance: (timedOut?: boolean) => void;
  reset: () => void;
}

function safeToast(message: string, options?: ToastOptions): void {
  if (typeof document !== "undefined") {
    try {
      toast(message, options);
    } catch {
      // Ignore in non-DOM or test environment
    }
  }
}

export const useZaicodeFreshSession = create<ZaicodeFreshSessionState>((set, get) => {
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  const confirmedSessionIds = new Set<string>();

  const clearSafetyTimer = () => {
    if (safetyTimer !== null) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  };

  const advanceNext = (timedOut = false) => {
    clearSafetyTimer();
    const state = get();
    if (timedOut && state.currentId !== null) {
      const timedOutReq = state.queue.find((r) => r.id === state.currentId);
      if (timedOutReq?.intentId) {
        const intent = useZaicodeActionIntents.getState().intents[timedOutReq.intentId];
        if (intent && (intent.state === "CREATED" || intent.state === "ADMISSION_PENDING")) {
          const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
            rejectionReason: "Helper session creation timed out",
          });
          if (rejected) safeToast(formatIntentFeedback(rejected), { variant: "warning" });
          useZaicodeActionIntents.getState().advanceHelperQueue(intent.id);
        }
        useZaicodePendingCommand.getState().removeByIntent(
          timedOutReq.workspacePath,
          timedOutReq.intentId,
          { workspaceIdentity: timedOutReq.workspaceIdentity },
        );
      } else {
        const helperIntent = useZaicodeActionIntents.getState().peekHelperQueue();
        if (helperIntent && (helperIntent.state === "CREATED" || helperIntent.state === "ADMISSION_PENDING")) {
          const rejected = useZaicodeActionIntents.getState().transitionState(helperIntent.id, "REJECTED", {
            rejectionReason: "Helper session creation timed out",
          });
          if (rejected) safeToast(formatIntentFeedback(rejected), { variant: "warning" });
          useZaicodeActionIntents.getState().advanceHelperQueue(helperIntent.id);
        }
        if (timedOutReq?.command) {
          useZaicodePendingCommand.getState().take(timedOutReq.workspacePath, { workspaceIdentity: timedOutReq.workspaceIdentity });
        }
      }
    }

    const remaining = state.queue.filter((r) => r.id !== state.currentId);
    const nextReq = remaining[0] ?? null;
    set({
      queue: remaining,
      currentId: nextReq ? nextReq.id : null,
      request: nextReq,
    });
    if (nextReq) {
      safetyTimer = setTimeout(() => {
        if (get().currentId === nextReq.id) {
          advanceNext(true);
        }
      }, 10_000);
    }
  };

  return {
    request: null,
    queue: [],
    currentId: null,
    generationCounter: 0,
    open: (workspacePath, workspaceIdentity, command, action, originSessionId, intentId) => {
      const state = get();
      const lastId =
        state.queue.length > 0
          ? (state.queue.at(-1)?.id ?? 0)
          : (state.currentId ?? state.request?.id ?? 0);
      const nextId = lastId + 1;
      const nextGeneration = (state.generationCounter ?? 0) + 1;
      const newReq: ZaicodeFreshSessionRequest = {
        id: nextId,
        workspacePath,
        workspaceIdentity,
        command,
        ...(action ? { action } : {}),
        originSessionId: originSessionId ?? null,
        intentId: intentId ?? null,
        generation: nextGeneration,
        destination: action?.ownership === "main" ? "main" : "helper",
      };

      if (command) {
        useZaicodePendingCommand
          .getState()
          .queue(workspacePath, command, { workspaceIdentity }, action, intentId);
      }

      const nextQueue = [...state.queue, newReq];

      if (state.currentId === null && state.request === null) {
        set({
          queue: nextQueue,
          currentId: nextId,
          request: newReq,
          generationCounter: nextGeneration,
        });
        clearSafetyTimer();
        safetyTimer = setTimeout(() => {
          if (get().currentId === nextId) {
            advanceNext(true);
          }
        }, 10_000);
      } else {
        set({
          queue: nextQueue,
          generationCounter: nextGeneration,
        });
      }
    },
    consume: (id) => {
      const state = get();
      if (state.request?.id === id) {
        set({ request: null });
      }
    },
    confirmSession: (ack) => {
      const state = get();
      if (!state.currentId) return false;
      const currentReq = state.queue.find((r) => r.id === state.currentId);
      if (!currentReq) return false;

      // 1. Generic session-mount confirmation is rejected for helper requests.
      // Helper requests require an authoritative creation ACK with matching intentId/requestId.
      if (typeof ack === "string") {
        if (currentReq.intentId || currentReq.action?.ownership === "helper") {
          return false;
        }
        if (currentReq.originSessionId && currentReq.originSessionId === ack) {
          return false;
        }
        if (confirmedSessionIds.has(ack)) return false;
        confirmedSessionIds.add(ack);
        advanceNext(false);
        return true;
      }

      // 2. Authoritative creation ACK validation
      const { sessionId, requestId, intentId, workspacePath, workspaceIdentity, generation } = ack;
      if (!sessionId) return false;

      // Unrelated origin session cannot confirm helper
      if (currentReq.originSessionId && currentReq.originSessionId === sessionId) {
        return false;
      }

      // Delayed ACK must not confirm next request
      if (requestId !== undefined && requestId !== currentReq.id) {
        return false;
      }

      // IntentId must match
      if (currentReq.intentId) {
        if (!intentId || currentReq.intentId !== intentId) {
          return false;
        }
      }

      // Generation must match if provided
      if (generation !== undefined && currentReq.generation !== undefined && generation !== currentReq.generation) {
        return false;
      }

      // Workspace match
      if (workspaceIdentity && currentReq.workspaceIdentity && workspaceIdentity !== currentReq.workspaceIdentity) {
        return false;
      }
      if (workspacePath && currentReq.workspacePath) {
        const keyA = zaicodeMainKeyForm(currentReq.workspaceIdentity?.trim() || currentReq.workspacePath);
        const keyB = zaicodeMainKeyForm(workspaceIdentity?.trim() || workspacePath);
        if (keyA !== keyB) return false;
      }

      if (confirmedSessionIds.has(sessionId)) return false;
      confirmedSessionIds.add(sessionId);

      // Advance action intents for helper
      const targetIntentId = currentReq?.intentId ?? intentId;
      const helperIntent = targetIntentId
        ? useZaicodeActionIntents.getState().intents[targetIntentId]
        : useZaicodeActionIntents.getState().peekHelperQueue();
      if (helperIntent) {
        useZaicodeActionIntents.getState().transitionState(helperIntent.id, "RUNNING", {
          targetSessionId: sessionId,
        });
        useZaicodeActionIntents.getState().advanceHelperQueue(helperIntent.id);
      }

      advanceNext(false);
      return true;
    },
    advance: (timedOut = true) => {
      advanceNext(timedOut);
    },
    reset: () => {
      clearSafetyTimer();
      confirmedSessionIds.clear();
      set({
        request: null,
        queue: [],
        currentId: null,
        generationCounter: 0,
      });
    },
  };
});

/**
 * CLEAR in place: the composer strip asks the session pane that shows
 * `sessionId` to empty it (v4 `clearConversation`). The pane owns the
 * command channel, so the request is published here and consumed there once.
 */
export interface ZaicodeClearSessionRequest {
  id: number;
  sessionId: string;
  /**
   * T-318: Shift+START clears the session and THEN sends the goal in it. The
   * clear is an async dispatch owned by the pane, so the command rides along
   * and is handed to the composer only after the clear is acknowledged --
   * sending it up front would race the goal against the wipe.
   */
  after?: string;
}

interface ZaicodeClearSessionState {
  request: ZaicodeClearSessionRequest | null;
  clear: (sessionId: string, after?: string) => void;
  consume: (id: number) => void;
}

export const useZaicodeClearSession = create<ZaicodeClearSessionState>((set, get) => ({
  request: null,
  clear: (sessionId, after) =>
    set({ request: { id: (get().request?.id ?? 0) + 1, sessionId, after } }),
  consume: (id) => {
    if (get().request?.id === id) set({ request: null });
  },
}));

/**
 * The follow-up of a CLEAR-then-run (T-318), armed by the session pane once the
 * clear is acknowledged and consumed by the composer that owns `sessionId`:
 * only the composer knows how a command is normally submitted here (plan mode,
 * attachments, the Auto-Goal suffix, queue disposition), so the pane never
 * sends it itself.
 */
export interface ZaicodeAfterClearRequest {
  sessionId: string;
  command: string;
}

interface ZaicodeAfterClearState {
  request: ZaicodeAfterClearRequest | null;
  arm: (sessionId: string, command: string) => void;
  take: (sessionId: string) => string | null;
}

export const useZaicodeAfterClear = create<ZaicodeAfterClearState>((set, get) => ({
  request: null,
  arm: (sessionId, command) => set({ request: { sessionId, command } }),
  take: (sessionId) => {
    const current = get().request;
    if (!current || current.sessionId !== sessionId) return null;
    set({ request: null });
    return current.command;
  },
}));

/** The SAIPEN goal START sends: continue and close every ticket a human is not needed for. */
export const ZAICODE_SAIPEN_START_COMMAND = "/goal cc all";

/**
 * Request to open an existing session (the composer's "→ MAIN" jump, the
 * project row ◆ button). Like the fresh-session request, the shell layout
 * owns navigation and consumes it once.
 */
export interface ZaicodeOpenSessionRequest {
  id: number;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}

interface ZaicodeOpenSessionState {
  request: ZaicodeOpenSessionRequest | null;
  open: (workspacePath: string, workspaceIdentity: string | undefined, sessionId: string) => void;
  consume: (id: number) => void;
}

export const useZaicodeOpenSession = create<ZaicodeOpenSessionState>((set, get) => ({
  request: null,
  open: (workspacePath, workspaceIdentity, sessionId) =>
    set({
      request: { id: (get().request?.id ?? 0) + 1, workspacePath, workspaceIdentity, sessionId },
    }),
  consume: (id) => {
    if (get().request?.id === id) set({ request: null });
  },
}));
