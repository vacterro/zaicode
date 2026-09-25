/**
 * ZAICODE System Read Model (T-41).
 *
 * One answer to "is this project working, waiting, blocked or done", built
 * from facts other owners hold: SAIPEN's own projection (`saipen status
 * --json`, the protocol's truth; ZAICODE does not re-derive it), the runtime
 * ZAICODE runs (sessions, workers), engine availability and SAIMAIL. Every
 * surface (sidebar tint, composer chip, SAIPEN pane) reads this snapshot and
 * this one state function, so they cannot disagree.
 *
 * Board counts parsed from BOARD.md stay display-only (progress bars); they
 * never decide the state when SAIPEN's projection is available.
 */

export interface ZaicodeSaipenProjection {
  /** "saipen" = `saipen status --json`; "files" = STATE/BOARD read directly (projection unavailable). */
  source: "saipen" | "files";
  protocolVersion: string | null;
  phase: string | null;
  task: string | null;
  nextAction: string | null;
  /** null = no blocker ("none" in STATE). */
  blocker: string | null;
  claimedTicket: string | null;
  topWorkableTicket: string | null;
  /** SAIPEN automation says every human-free ticket is closed. null = not reported. */
  closureComplete: boolean | null;
  recoveryPending: boolean;
  boardErrors: number;
  /** Parked (BLOCKED) Work lines as SAIPEN reports them. */
  parkedWork: string[];
  /** Unread telegrams at turn entry; null when SAIMAIL is not configured for SAIPEN. */
  unreadTelegrams: number | null;
  /** Epoch ms of the read. */
  readAt: number;
  error: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "none" ? value.trim() : null;
}

/** `saipen status --json` -> the fields ZAICODE uses. Unknown shapes yield null, never a guess. */
export function normalizeZaicodeSaipenStatus(raw: unknown, readAt: number): ZaicodeSaipenProjection | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.ok === false) return null;
  const automation = (value.automation ?? {}) as Record<string, unknown>;
  const telegrams = (value.telegrams ?? {}) as Record<string, unknown>;
  const unread =
    typeof telegrams.unread === "number"
      ? telegrams.unread
      : typeof telegrams.unread_count === "number"
        ? telegrams.unread_count
        : null;
  return {
    source: "saipen",
    protocolVersion: str(value.protocol_version),
    phase: str(value.phase),
    task: str(value.task),
    nextAction: str(value.computed_next_action) ?? str(value.next_action),
    blocker: str(value.blocker),
    claimedTicket: str(value.claimed_ticket),
    topWorkableTicket: str(value.top_workable_ticket),
    closureComplete: typeof automation.closure_complete === "boolean" ? automation.closure_complete : null,
    recoveryPending: value.recovery_pending === true || value.recovery_conflict === true,
    boardErrors: Array.isArray(value.board_errors) ? value.board_errors.length : 0,
    parkedWork: Array.isArray(value.parked_work) ? value.parked_work.filter((line): line is string => typeof line === "string") : [],
    unreadTelegrams: telegrams.state === "NOT_CONFIGURED" ? null : unread,
    readAt,
    error: null,
  };
}

export interface ZaicodeBoardCounts {
  doing: number;
  todo: number;
  done: number;
  blocked: number;
}

export interface ZaicodeProjectRuntimeSnapshot {
  project: { path: string; identity?: string };
  /** null = the project has no `.saipen/`. */
  protocol: ZaicodeSaipenProjection | null;
  /** Display only (progress); see the module comment. */
  board: ZaicodeBoardCounts | null;
  /** STATE `agent:` (the Work owner) and `last_event` (generation) when known. */
  owner: string | null;
  generation: number | null;
  sessions: { running: number; waiting: number };
  workers: { running: number };
  engines: { usable: number; blocked: number } | null;
  messages: { unread: number } | null;
}

export type ZaicodeProjectRuntimeState = "blocked" | "waiting" | "working" | "pending" | "done" | "idle";

export interface ZaicodeProjectRuntimeVerdict {
  state: ZaicodeProjectRuntimeState;
  /** Short label for chips and tooltips. */
  label: string;
  /** Why, in one sentence. */
  reason: string;
}

/**
 * The one answer. Order matters: a human is needed (blocked / waiting) before
 * anything runs; running work before queued work; done only when SAIPEN says
 * so (or, without its projection, when no ticket is open).
 */
export function zaicodeProjectRuntimeState(snapshot: ZaicodeProjectRuntimeSnapshot): ZaicodeProjectRuntimeVerdict {
  const protocol = snapshot.protocol;
  const board = snapshot.board;
  const where = protocol ? [protocol.task, protocol.phase].filter(Boolean).join(" ") : "";
  if (protocol?.recoveryPending) {
    return { state: "blocked", label: "RECOVERY", reason: "SAIPEN has an interrupted operation to recover" };
  }
  if (protocol && protocol.boardErrors > 0) {
    return { state: "blocked", label: "BOARD ERROR", reason: `SAIPEN reports ${protocol.boardErrors} board error(s)` };
  }
  if (protocol?.blocker) {
    return { state: "blocked", label: "BLOCKED", reason: protocol.blocker };
  }
  if (snapshot.sessions.waiting > 0) {
    return { state: "waiting", label: "WAITING FOR YOU", reason: `${snapshot.sessions.waiting} session(s) wait for an answer` };
  }
  if (snapshot.sessions.running > 0 || snapshot.workers.running > 0) {
    const parts = [
      snapshot.sessions.running > 0 ? `${snapshot.sessions.running} session(s)` : "",
      snapshot.workers.running > 0 ? `${snapshot.workers.running} worker(s)` : "",
    ].filter(Boolean);
    return { state: "working", label: where || "WORKING", reason: `${parts.join(" and ")} running` };
  }
  if (!protocol) return { state: "idle", label: "no SAIPEN", reason: "the project has no .saipen/ memory" };
  const openWork = protocol.claimedTicket ?? protocol.topWorkableTicket;
  if (protocol.source === "saipen") {
    if (protocol.closureComplete === true || !openWork) {
      const parked = protocol.parkedWork.length;
      return {
        state: "done",
        label: parked > 0 ? `DONE · ${parked} parked` : "DONE",
        reason: parked > 0 ? `every human-free ticket is closed; ${parked} wait for a human` : "every ticket is closed",
      };
    }
    return { state: "pending", label: openWork, reason: `${openWork} is ready to run; nothing is running now` };
  }
  // No projection: the board decides, conservatively.
  const open = board ? board.doing + board.todo : 0;
  if (open > 0) return { state: "pending", label: where || "OPEN", reason: `${open} open ticket(s); nothing is running now` };
  if (board && board.done + board.blocked > 0) return { state: "done", label: "DONE", reason: "no open ticket" };
  return { state: "idle", label: "SAIPEN idle", reason: "no tickets" };
}

/** One colour language for the state everywhere (sidebar strip, composer chip, SAIPEN pane). */
export const ZAICODE_RUNTIME_STATE_COLOR: Record<ZaicodeProjectRuntimeState, string | null> = {
  blocked: "var(--color-destructive)",
  waiting: "var(--color-destructive)",
  working: "var(--zaicode-highlight, var(--color-warning))",
  pending: "var(--color-warning)",
  done: "var(--color-success)",
  idle: null,
};
