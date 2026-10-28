import { isZaicodeHumanBlocker, type ZaicodeSaipenProjection } from "@zcode/shared";

/**
 * Live, read-only projection of a project's SAIPEN memory (`.saipen/`):
 * STATE.md (phase / ticket / next action / blocker), BOARD.md (ticket
 * counts, next ticket) and the LOG.md tail (last action). ZAICODE never
 * writes these files — agents own them through the SAIPEN launcher.
 */
export interface ZaicodeSaipenTicket {
  id: string;
  title: string;
}

export interface ZaicodeSaipenSnapshot {
  phase: string | null;
  task: string | null;
  nextAction: string | null;
  blocker: string | null;
  updated: string | null;
  lastAction: string | null;
  lastActionTime: string | null;
  doing: ZaicodeSaipenTicket | null;
  nextTicket: ZaicodeSaipenTicket | null;
  /** `humanBlocked`: how many of the `blocked` tickets wait for a person (the rest are BLOCKED for real). */
  counts: { doing: number; todo: number; done: number; blocked: number; humanBlocked?: number };
  /** STATE `agent:` (the Work owner) and `last_event` (generation). */
  owner?: string | null;
  generation?: number | null;
  /**
   * SAIPEN's own projection (`saipen status --json`, T-41 read model). The
   * protocol state comes from here; the file parse above is display only.
   * undefined = not asked yet, null = unavailable (no launcher, remote, error).
   */
  projection?: ZaicodeSaipenProjection | null;
  /**
   * SRC-114: `.saipen/` exists but could not be read. It used to be the same
   * "nothing here" answer as an absent directory, so a permission error or a
   * file caught mid-write was reported as "no memory yet" -- a statement the
   * user cannot act on. Absent means null; unreadable means this.
   */
  readError?: string;
  /** Full BOARD / LOG / STATE projection for the SAIPEN side pane (absent in light consumers). */
  detail?: ZaicodeSaipenDetail;
}

export type ZaicodeSaipenSection = "DOING" | "TODO" | "BLOCKED" | "DONE";

/**
 * Whether a failed read means "there is no `.saipen/` here" as opposed to
 * "there is one and I could not read it". Only the former may answer with a
 * null snapshot; the latter must say so, or the UI states a falsehood.
 */
export function isZaicodeSaipenMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\bENOENT\b|no such file|not found/i.test(message);
}

/** One line a user can act on, without a stack trace. */
export function describeZaicodeSaipenReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "unknown error";
}

/** One BOARD.md ticket with its `| key: value` fields. */
export interface ZaicodeSaipenBoardTicket {
  id: string;
  section: ZaicodeSaipenSection;
  priority: string | null;
  title: string;
  fields: Record<string, string>;
}

/** One LOG.md event line split into its Event Graph parts. */
export interface ZaicodeSaipenLogLine {
  /** E-### when present, else a stable hash-free fallback (the raw line). */
  key: string;
  date: string | null;
  time: string | null;
  event: string | null;
  ticket: string | null;
  agent: string | null;
  /** RUN / DEC / USR / ... */
  tag: string | null;
  text: string;
}

export interface ZaicodeSaipenDetail {
  /** Every STATE.md front-matter key, in file order. */
  state: [string, string][];
  tickets: ZaicodeSaipenBoardTicket[];
  /** Oldest first. */
  log: ZaicodeSaipenLogLine[];
}

/** Whole-message SAIPEN shortcuts offered in the ZAICODE composer (COMMANDS.md). */
export const ZAICODE_SAIPEN_SHORTCUTS = [
  { command: "cc", label: "Continue", hint: "saipen continue — resume active work" },
  { command: "ccc", label: "Converge & ship", hint: "saipen continue — converge target ship" },
  { command: "sss", label: "Status", hint: "saipen status — read-only" },
  { command: "tt", label: "Test", hint: "saipen test — run declared suite" },
  { command: "hh", label: "Hunt", hint: "saipen hunt — defect/improvement scan" },
  { command: "aa", label: "Audit", hint: "saipen markhunt — dry audit, never fixes" },
  { command: "dd ", label: "Plan…", hint: "saipen plan — type the items after dd" },
  { command: "gg ", label: "Goal…", hint: "saipen goal — type the objective after gg" },
  { command: "zz", label: "Undo", hint: "saipen undo — restore last safe milestone" },
  { command: "st", label: "Stop", hint: "saipen stop — checkpoint and return control" },
] as const;

function frontMatterValue(content: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\r\\n]*))`, "m").exec(content);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return value || null;
}

export function parseSaipenState(content: string) {
  const blocker = frontMatterValue(content, "blocker");
  const lastEvent = Number(frontMatterValue(content, "last_event"));
  return {
    phase: frontMatterValue(content, "phase"),
    task: frontMatterValue(content, "task"),
    nextAction: frontMatterValue(content, "next_action"),
    blocker: blocker && blocker.toLowerCase() !== "none" ? blocker : null,
    updated: frontMatterValue(content, "updated"),
    owner: frontMatterValue(content, "agent"),
    generation: Number.isFinite(lastEvent) && lastEvent > 0 ? lastEvent : null,
  };
}

function parseTicket(line: string): ZaicodeSaipenTicket | null {
  const match = /^- \[[ /x]\] (T-\d+)\s+(?:\[P\d\]\s+)?([^|]*)/.exec(line.trim());
  if (!match) return null;
  return { id: match[1]!, title: match[2]!.trim() };
}

export function parseSaipenBoard(content: string) {
  const sections: Record<string, ZaicodeSaipenTicket[]> = {};
  let section = "";
  let humanBlocked = 0;
  for (const line of content.split(/\r?\n/)) {
    const heading = /^## (\w+)/.exec(line);
    if (heading) {
      section = heading[1]!.toUpperCase();
      continue;
    }
    const ticket = section ? parseTicket(line) : null;
    if (ticket) (sections[section] ??= []).push(ticket);
    // A BLOCKED ticket whose blocker only a person can lift waits for the operator (orange).
    if (ticket && section === "BLOCKED" && isZaicodeHumanBlocker(/\|\s*blocker:\s*([^|]*)/.exec(line)?.[1])) humanBlocked += 1;
  }
  const blocked = sections.BLOCKED ?? [];
  return {
    doing: sections.DOING?.[0] ?? null,
    nextTicket: sections.TODO?.[0] ?? blocked[0] ?? null,
    counts: {
      doing: sections.DOING?.length ?? 0,
      todo: sections.TODO?.length ?? 0,
      done: sections.DONE?.length ?? 0,
      blocked: blocked.length,
      humanBlocked,
    },
  };
}

/** Last LOG line without its Event Graph skeleton: `RUN: SCOUT -- ...`. */
export function parseSaipenLastAction(logTail: string) {
  const lines = logTail.split(/\r?\n/).filter((line) => line.startsWith("- "));
  const last = lines.at(-1);
  if (!last) return { lastAction: null, lastActionTime: null };
  const time = /^- \d\d\.\d\d\.\d\d (\d\d:\d\d)/.exec(last)?.[1] ?? null;
  const body = last
    .replace(/^- \d\d\.\d\d\.\d\d \d\d:\d\d\s*/, "")
    .replace(/^(\[[^\]]*\]\s*)+/, "")
    // Agents sometimes repeat the tag inside the checkpoint text ("RUN: RUN: ..."): show it once.
    .replace(/^([A-Z]{2,5}):\s+\1:\s*/, "$1: ")
    .trim();
  return { lastAction: body || null, lastActionTime: time };
}

/**
 * Board shares for the project title strip, filled from the right edge:
 * BLOCKED (red), then WAITING FOR A PERSON (orange), then TODO incl. DOING
 * (yellow), then DONE (green). Each part is a 0..1 share of all tickets so the
 * four segments always sum to 1.
 */
export function saipenBoardShares(snapshot: ZaicodeSaipenSnapshot | null): {
  blocked: number;
  human: number;
  todo: number;
  done: number;
  total: number;
} | null {
  if (!snapshot) return null;
  const { doing, todo, done, blocked } = snapshot.counts;
  const total = doing + todo + done + blocked;
  if (total === 0) return null;
  const human = Math.min(blocked, Math.max(0, snapshot.counts.humanBlocked ?? 0));
  return { blocked: (blocked - human) / total, human: human / total, todo: (todo + doing) / total, done: done / total, total };
}
