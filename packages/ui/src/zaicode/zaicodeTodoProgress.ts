import { create } from "zustand";

/**
 * ZAICODE: last known TodoWrite items per session (taskId === sessionId).
 * The live source for sidebar rows is the sessions-index `todos` summary;
 * this store is the fallback for sessions whose summary has not arrived yet,
 * written by the open SessionPane and remembered across restarts (bounded).
 */
export type ZaicodeTodoStatus = "completed" | "inProgress" | "pending";

export interface ZaicodeTodoItem {
  status: ZaicodeTodoStatus;
  content: string;
}

const STORAGE_KEY = "zaicode-todo-progress-v2";
const MAX_SESSIONS = 200;

function isItem(value: unknown): value is ZaicodeTodoItem {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as ZaicodeTodoItem).content === "string" &&
    ["completed", "inProgress", "pending"].includes((value as ZaicodeTodoItem).status)
  );
}

function load(): Record<string, ZaicodeTodoItem[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, ZaicodeTodoItem[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.every(isItem)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function save(value: Record<string, ZaicodeTodoItem[]>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Mirror is cosmetic; storage failure keeps the in-memory copy.
  }
}

export function todoItemsEqual(
  left: readonly ZaicodeTodoItem[] | undefined,
  right: readonly ZaicodeTodoItem[] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.status === right[index]!.status && item.content === right[index]!.content,
    )
  );
}

interface ZaicodeTodoProgressState {
  bySession: Record<string, ZaicodeTodoItem[]>;
  publish: (sessionId: string, items: readonly ZaicodeTodoItem[]) => void;
}

export const useZaicodeTodoProgress = create<ZaicodeTodoProgressState>((set, get) => ({
  bySession: load(),
  publish: (sessionId, items) => {
    const current = get().bySession[sessionId];
    if (todoItemsEqual(current, items) || (!current && items.length === 0)) return;
    const next = { ...get().bySession };
    delete next[sessionId];
    if (items.length > 0) {
      next[sessionId] = items.map((item) => ({ status: item.status, content: item.content }));
    }
    const keys = Object.keys(next);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete next[key];
    save(next);
    set({ bySession: next });
  },
}));

export const ZAICODE_TODO_CELL_CLASS: Record<ZaicodeTodoStatus, string> = {
  completed: "border-[var(--color-success)] bg-[var(--color-success)]",
  inProgress: "border-[var(--zaicode-highlight,var(--color-warning))] bg-[var(--color-warning)]",
  pending: "border-border bg-transparent",
};

export const ZAICODE_TODO_STATUS_LABEL: Record<ZaicodeTodoStatus, string> = {
  completed: "DONE",
  inProgress: "NOW",
  pending: "TODO",
};

/** Completed fraction (0..1) of a todo list; empty list reads as 0 (just started). */
export function todoReadinessRatio(items: readonly ZaicodeTodoItem[] | undefined): number {
  if (!items || items.length === 0) return 0;
  const done = items.filter((item) => item.status === "completed").length;
  const inProgress = items.filter((item) => item.status === "inProgress").length;
  // A task mid-step counts as half, so a single running item reads amber, not black.
  return Math.min(1, (done + inProgress * 0.5) / items.length);
}

/**
 * Battlezone F-group health colour: black (no progress) -> red -> amber -> green
 * (almost done), interpolated through hue+lightness so a glance reads readiness.
 */
export function readinessBarColor(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  // Hue 0 (red) -> 120 (green); lightness climbs from near-black so 0% is dark.
  const hue = Math.round(r * 120);
  const light = Math.round(12 + r * 30);
  const sat = 70;
  return `hsl(${hue} ${sat}% ${light}%)`;
}
