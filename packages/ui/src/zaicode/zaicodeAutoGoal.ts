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

/**
 * The prompt as the host receives it. Nothing is inserted into the visible editor, and a
 * prompt that already carries a goal is left alone so the operator can write a goal by
 * hand and Auto-Goal does not add a second one.
 */
export function withZaicodeAutoGoal(text: string, enabled: boolean): string {
  if (!enabled) return text;
  const body = text.trim();
  if (/(^|\s)\/goal\b/.test(body)) return text;
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
