import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * SRC-138: Auto-Goal. The operator writes "/goal cc all" at the end of a handoff by
 * hand; with the mode on the composer appends it to every prompt it sends, invisibly,
 * so the goal rides along with the handoff instead of costing a second message.
 *
 * The suffix is not parsed anywhere in this app: the host that receives the prompt is
 * what reads it. So the whole feature is one text transform at the one point where the
 * outgoing body is built, plus a per-project switch next to the send control.
 */

/** Exactly what the operator types by hand when Auto-Goal is off. */
export const ZAICODE_AUTO_GOAL_SUFFIX = "/goal cc all";

const STORAGE_KEY = "zaicode-auto-goal-v1";

/** Only projects the operator turned OFF are recorded; every other project is on. */
export interface ZaicodeAutoGoalState {
  off: Record<string, true>;
  toggle: (workspaceKey: string) => void;
}

function load(): Record<string, true> {
  try {
    const raw = JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null") as { off?: unknown } | null;
    const off = raw && typeof raw === "object" ? raw.off : null;
    if (!off || typeof off !== "object" || Array.isArray(off)) return {};
    const kept: Record<string, true> = {};
    // Bound the map the way every other ZAICODE pref store does: one short key per project.
    for (const [key, value] of Object.entries(off as Record<string, unknown>).slice(0, 200)) {
      if (value === true && key.trim()) kept[key] = true;
    }
    return kept;
  } catch {
    return {};
  }
}

function persist(off: Record<string, true>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ off }));
  } catch {
    // Applies for this window; the next start reads what did land.
  }
}

export const useZaicodeAutoGoal = create<ZaicodeAutoGoalState>((set, get) => ({
  off: load(),
  toggle: (workspaceKey: string) => {
    const key = workspaceKey.trim();
    if (!key) return;
    const current = { ...get().off };
    if (current[key]) delete current[key];
    else current[key] = true;
    persist(current);
    set({ off: current });
  },
}));

/** The unfiled draft scope has no project of its own, so it is off rather than shared with one. */
export function zaicodeAutoGoalKey(workspaceKey: string): string {
  return workspaceKey.trim();
}

export function zaicodeAutoGoalEnabled(state: Pick<ZaicodeAutoGoalState, "off">, workspaceKey: string): boolean {
  const key = zaicodeAutoGoalKey(workspaceKey);
  return key !== "" && state.off[key] !== true;
}

export type OutgoingInputCategory =
  | "work"
  | "explicit_goal"
  | "saipen_control"
  | "zaicode_continuation"
  | "lifecycle_control"
  | "unknown_command";

export interface OutgoingInputClassification {
  category: OutgoingInputCategory;
  eligibleForAutoGoal: boolean;
  isStop: boolean;
  isContinuation: boolean;
  isGoal: boolean;
  isLifecycle: boolean;
  commandToken?: string;
  reason: string;
}

const SAIPEN_SHORTCUT_TOKENS = new Set([
  "gg",
  "hh",
  "ff",
  "xx",
  "vv",
  "zz",
  "sss",
  "dd",
  "aa",
  "qq",
  "qqq",
  "ee",
  "eee",
  "pp",
  "tt",
  "sc",
  "аа",
  "ее",
  "еее",
  "рр",
  "хх",
]);

/**
 * P0 AUTO-GOAL COMMAND ISOLATION (SRC-226 / T-310).
 *
 * Classifies outgoing user input into distinct semantic categories before Auto-Goal
 * augmentation and goal intent registration.
 *
 * Invariants:
 * 1. Control commands (saipen, lifecycle stop/pause/cancel, continuation, slash commands)
 *    are NEVER augmented with "/goal cc all".
 * 2. Explicit manual STOP outranks continuation; manual STOP must never become STOP + CONTINUE.
 * 3. Ineligible commands never register fresh Auto-Goal intents.
 * 4. Ordinary task prompts and handoffs remain eligible, including prompts that reference
 *    or quote commands (e.g. 'Fix "saipen stop" bug').
 */
export function classifyOutgoingInput(text: string): OutgoingInputClassification {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      category: "work",
      eligibleForAutoGoal: true,
      isStop: false,
      isContinuation: false,
      isGoal: false,
      isLifecycle: false,
      reason: "empty handoff",
    };
  }

  // Quoted command in an ordinary task:
  // If the input starts with quotes or backticks, it is treated as prose discussing/referencing
  // the command rather than a bare command invocation.
  if (/^["'`]/.test(trimmed)) {
    return {
      category: "work",
      eligibleForAutoGoal: true,
      isStop: false,
      isContinuation: false,
      isGoal: false,
      isLifecycle: false,
      reason: "quoted command or prose",
    };
  }

  // 1. Explicit goal declarations (/goal or /target anywhere in directive context)
  if (/(?:^|\s)\/(?:goal|target)\b/i.test(trimmed)) {
    return {
      category: "explicit_goal",
      eligibleForAutoGoal: false,
      isStop: false,
      isContinuation: false,
      isGoal: true,
      isLifecycle: false,
      reason: "explicit goal declaration",
    };
  }

  // 2. Explicit SAIPEN CLI invocations
  const saipenMatch = /^saipen(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (saipenMatch) {
    const rawArgs = saipenMatch[1]?.trim() ?? "";
    const subVerb = rawArgs.split(/\s+/)[0]?.toLowerCase() ?? "";

    if (subVerb === "stop") {
      return {
        category: "lifecycle_control",
        eligibleForAutoGoal: false,
        isStop: true,
        isContinuation: false,
        isGoal: false,
        isLifecycle: true,
        commandToken: "saipen stop",
        reason: "saipen stop lifecycle control",
      };
    }

    if (subVerb === "continue" || subVerb === "cc" || subVerb === "ccc") {
      return {
        category: "zaicode_continuation",
        eligibleForAutoGoal: false,
        isStop: false,
        isContinuation: true,
        isGoal: false,
        isLifecycle: false,
        commandToken: "saipen continue",
        reason: "saipen continuation command",
      };
    }

    return {
      category: "saipen_control",
      eligibleForAutoGoal: false,
      isStop: false,
      isContinuation: false,
      isGoal: false,
      isLifecycle: false,
      commandToken: subVerb ? `saipen ${subVerb}` : "saipen",
      reason: "saipen control command",
    };
  }

  // 3. Lifecycle controls (stop, cancel, pause, abort, interrupt, st)
  // Bare command line tokens or 'command all', not multi-word prose sentences.
  if (
    /^(?:\/)?(?:stop|cancel|abort)(?:\s+all)?$/i.test(trimmed) ||
    /^(?:\/)?(?:pause|interrupt)$/i.test(trimmed) ||
    /^st(?:\s+all)?$/i.test(trimmed)
  ) {
    const isStop = !/^(?:\/)?pause$/i.test(trimmed);
    return {
      category: "lifecycle_control",
      eligibleForAutoGoal: false,
      isStop,
      isContinuation: false,
      isGoal: false,
      isLifecycle: true,
      commandToken: trimmed,
      reason: isStop ? "lifecycle stop command" : "lifecycle pause command",
    };
  }

  // 4. ZAICODE continuation commands (cc, cc all, ccc, step, /continue, /resume)
  if (
    /^(?:cc|сс|ccc|ссс)(?:\s+all)?$/i.test(trimmed) ||
    /^cc-all$/i.test(trimmed) ||
    /^step$/i.test(trimmed) ||
    /^\/(?:continue|resume)\b/i.test(trimmed)
  ) {
    return {
      category: "zaicode_continuation",
      eligibleForAutoGoal: false,
      isStop: false,
      isContinuation: true,
      isGoal: false,
      isLifecycle: false,
      commandToken: trimmed,
      reason: "continuation command",
    };
  }

  // 5. SAIPEN declared shortcuts (whole-token match)
  if (SAIPEN_SHORTCUT_TOKENS.has(trimmed.toLowerCase())) {
    return {
      category: "saipen_control",
      eligibleForAutoGoal: false,
      isStop: false,
      isContinuation: false,
      isGoal: false,
      isLifecycle: false,
      commandToken: trimmed.toLowerCase(),
      reason: "saipen shortcut command",
    };
  }

  // 6. Unknown or ambiguous command-like input (starts with /, !, $)
  if (/^[/!$]/.test(trimmed)) {
    const token = trimmed.split(/\s+/)[0];
    return {
      category: "unknown_command",
      eligibleForAutoGoal: false,
      isStop: false,
      isContinuation: false,
      isGoal: false,
      isLifecycle: false,
      commandToken: token,
      reason: "command-like input",
    };
  }

  // 7. Ordinary work prompts and handoffs
  return {
    category: "work",
    eligibleForAutoGoal: true,
    isStop: false,
    isContinuation: false,
    isGoal: false,
    isLifecycle: false,
    reason: "ordinary work prompt",
  };
}

export function isEligibleForAutoGoal(text: string): boolean {
  return classifyOutgoingInput(text).eligibleForAutoGoal;
}

export function isStopCommand(text: string): boolean {
  return classifyOutgoingInput(text).isStop;
}

/**
 * The prompt as the host receives it. Nothing is inserted into the visible editor, and a
 * prompt that already carries a goal is left alone so the operator can write a goal by
 * hand and Auto-Goal does not add a second one. Control and lifecycle commands are never
 * augmented with an automatic goal.
 */
export function withZaicodeAutoGoal(text: string, enabled: boolean): string {
  if (!enabled) return text;
  const classification = classifyOutgoingInput(text);
  if (!classification.eligibleForAutoGoal) return text;
  const body = text.trim();
  return body ? `${body}\n${ZAICODE_AUTO_GOAL_SUFFIX}` : ZAICODE_AUTO_GOAL_SUFFIX;
}

/**
 * The prompt as the operator should read it again (SRC-163 / SRC-151:R006). Auto-Goal is
 * meant to be invisible, but the suffix travels inside the message body, so every surface
 * that shows a sent or queued prompt -- the transcript bubble, the queue row, the inline
 * edit draft -- strips the trailing goal line it appended and says "goal" instead. A queued
 * screenshot with no text used to read as a bare "/goal cc all".
 */
export function splitZaicodeAutoGoal(text: string): { body: string; goal: boolean } {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === ZAICODE_AUTO_GOAL_SUFFIX) return { body: "", goal: true };
  const tail = `
${ZAICODE_AUTO_GOAL_SUFFIX}`;
  if (trimmed.endsWith(tail)) return { body: trimmed.slice(0, -tail.length), goal: true };
  return { body: text, goal: false };
}
