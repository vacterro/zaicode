import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Sessions marked for the SCHEDULER (SRC-044 "continue only in the sessions I
 * ticked"): a schedule with "only marked sessions" on continues exactly these
 * -- their goal again, else `cc` -- and starts nothing new. Marked from the
 * session's right-click menu; the row shows a small flag. Per machine.
 */

const STORAGE_KEY = "zaicode-scheduler-marks-v1";
const MAX_MARKS = 200;

export interface ZaicodeSchedulerMark {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

function load(): Record<string, ZaicodeSchedulerMark> {
  try {
    const raw = JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const marks: Record<string, ZaicodeSchedulerMark> = {};
    for (const value of Object.values(raw ?? {}).slice(0, MAX_MARKS)) {
      const mark = value as Partial<ZaicodeSchedulerMark>;
      if (typeof mark?.sessionId !== "string" || typeof mark.workspacePath !== "string") continue;
      marks[mark.sessionId] = {
        sessionId: mark.sessionId,
        workspacePath: mark.workspacePath,
        ...(typeof mark.workspaceIdentity === "string" && mark.workspaceIdentity ? { workspaceIdentity: mark.workspaceIdentity } : {}),
      };
    }
    return marks;
  } catch {
    return {};
  }
}

interface ZaicodeSchedulerMarksState {
  marks: Record<string, ZaicodeSchedulerMark>;
  toggle: (mark: ZaicodeSchedulerMark) => void;
  unmark: (sessionId: string) => void;
}

export const useZaicodeSchedulerMarks = create<ZaicodeSchedulerMarksState>((set, get) => {
  const persist = (marks: Record<string, ZaicodeSchedulerMark>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
    } catch {
      // preference only
    }
    set({ marks });
  };
  return {
    marks: load(),
    toggle: (mark) => {
      const marks = { ...get().marks };
      if (marks[mark.sessionId]) delete marks[mark.sessionId];
      else marks[mark.sessionId] = mark;
      persist(marks);
    },
    unmark: (sessionId) => {
      if (!get().marks[sessionId]) return;
      const marks = { ...get().marks };
      delete marks[sessionId];
      persist(marks);
    },
  };
});

export function useZaicodeSchedulerMarked(sessionId: string): boolean {
  return useZaicodeSchedulerMarks((state) => Boolean(state.marks[sessionId]));
}

/** Marked sessions of one project (by path, case-insensitive like Windows). */
export function zaicodeMarkedSessionsIn(workspacePath: string): ZaicodeSchedulerMark[] {
  const path = workspacePath.toLowerCase();
  return Object.values(useZaicodeSchedulerMarks.getState().marks).filter((mark) => mark.workspacePath.toLowerCase() === path);
}
