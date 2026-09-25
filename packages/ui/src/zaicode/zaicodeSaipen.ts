import { useEffect, useState } from "react";
import { create } from "zustand";
import type { ZaicodeSaipenProjection } from "@zcode/shared";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
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
    const bridge = (typeof window === "undefined" ? undefined : (window as unknown as { zcode?: ProjectionBridge }).zcode);
    if (!bridge?.getZaicodeSaipenProjection) return;
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
      }
    } catch {
      this.lastState = null;
      if (this.snapshot !== null) this.emit(null);
      delay = MISSING_POLL_MS;
    } finally {
      this.running = false;
      this.schedule(delay);
    }
  }
}

const pollers = new Map<string, SaipenPoller>();

function acquirePoller(workspacePath: string, fileService: FileService): SaipenPoller {
  const root = `${workspacePath.replace(/[\\/]+$/, "")}/.saipen`;
  const key = root.toLowerCase();
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
    const poller = acquirePoller(workspacePath, fileService);
    const unsubscribe = poller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      if (poller.idle) {
        for (const [key, value] of pollers) if (value === poller) pollers.delete(key);
      }
    };
  }, [fileService, workspacePath]);

  return snapshot;
}

/**
 * One-shot command queued for a workspace's next composer (e.g. the project
 * row START button: open a fresh chat, then send `cc`). The SAIPEN strip in
 * that composer consumes it once the composer can submit.
 */
interface ZaicodePendingCommandState {
  byWorkspace: Record<string, string>;
  queue: (workspacePath: string, command: string) => void;
  take: (workspacePath: string) => string | null;
}

function workspaceCommandKey(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, "").toLowerCase();
}

export const useZaicodePendingCommand = create<ZaicodePendingCommandState>((set, get) => ({
  byWorkspace: {},
  queue: (workspacePath, command) =>
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspaceCommandKey(workspacePath)]: command },
    })),
  take: (workspacePath) => {
    const key = workspaceCommandKey(workspacePath);
    const command = get().byWorkspace[key] ?? null;
    if (command) {
      const next = { ...get().byWorkspace };
      delete next[key];
      set({ byWorkspace: next });
    }
    return command;
  },
}));

export function hasZaicodePendingCommand(
  state: ZaicodePendingCommandState,
  workspacePath: string,
): boolean {
  return Boolean(state.byWorkspace[workspaceCommandKey(workspacePath)]);
}

/**
 * Request for a brand-new session in a project (START from the composer of a
 * running session, CLEAR, the sidebar project START). The shell layout owns
 * draft creation, so the request is published here and consumed there once;
 * an optional command is queued for the fresh composer to send.
 */
export interface ZaicodeFreshSessionRequest {
  id: number;
  workspacePath: string;
  workspaceIdentity?: string;
  command: string | null;
}

interface ZaicodeFreshSessionState {
  request: ZaicodeFreshSessionRequest | null;
  open: (workspacePath: string, workspaceIdentity: string | undefined, command: string | null) => void;
  consume: (id: number) => void;
}

export const useZaicodeFreshSession = create<ZaicodeFreshSessionState>((set, get) => ({
  request: null,
  open: (workspacePath, workspaceIdentity, command) => {
    if (command) useZaicodePendingCommand.getState().queue(workspacePath, command);
    set({
      request: { id: (get().request?.id ?? 0) + 1, workspacePath, workspaceIdentity, command },
    });
  },
  consume: (id) => {
    if (get().request?.id === id) set({ request: null });
  },
}));

/**
 * CLEAR in place: the composer strip asks the session pane that shows
 * `sessionId` to empty it (v4 `clearConversation`). The pane owns the
 * command channel, so the request is published here and consumed there once.
 */
export interface ZaicodeClearSessionRequest {
  id: number;
  sessionId: string;
}

interface ZaicodeClearSessionState {
  request: ZaicodeClearSessionRequest | null;
  clear: (sessionId: string) => void;
  consume: (id: number) => void;
}

export const useZaicodeClearSession = create<ZaicodeClearSessionState>((set, get) => ({
  request: null,
  clear: (sessionId) => set({ request: { id: (get().request?.id ?? 0) + 1, sessionId } }),
  consume: (id) => {
    if (get().request?.id === id) set({ request: null });
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
