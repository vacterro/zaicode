import { create } from "zustand";

/**
 * ZAICODE MAIN session ("iron slot") per project.
 *
 * Every project has one MAIN session: the place where the work starts and is
 * planned (START / STEP / planning commands). Other sessions of the project
 * are side slots — parallel helpers such as subSaipens (WIKI, TRANSL, TEST,
 * AUDIT) that can run next to MAIN without touching its work.
 *
 * - START (from a draft or a running session) makes the session it runs in
 *   the MAIN session; so does the first STEP/INIT in a project without MAIN.
 * - "Make MAIN" / "Unset MAIN" in the session context menu changes it by hand.
 * - The sidebar pins MAIN first in the project list with a ◆ marker; the
 *   project row's ◆ button opens it (or starts a new MAIN when there is none).
 *
 * Renderer-local (per machine), keyed by the workspace identity key
 * (`workspaceIdentity || workspacePath`).
 */
const STORAGE_KEY = "zaicode-main-sessions-v1";

interface Persisted {
  byWorkspace: Record<string, string>;
}

function load(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Persisted> | null;
    const byWorkspace: Record<string, string> = {};
    if (raw?.byWorkspace && typeof raw.byWorkspace === "object") {
      for (const [key, value] of Object.entries(raw.byWorkspace)) {
        if (typeof value === "string" && value) byWorkspace[key] = value;
      }
    }
    return { byWorkspace };
  } catch {
    return { byWorkspace: {} };
  }
}

function save(value: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Preference only; the in-memory map still applies for this window.
  }
}

export function zaicodeMainSessionKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

interface ZaicodeMainSessionState extends Persisted {
  /** Projects whose next created session becomes MAIN (START from a draft, "new MAIN"). */
  armed: Record<string, true>;
  setMain: (workspaceKey: string, sessionId: string) => void;
  clearMain: (workspaceKey: string) => void;
  arm: (workspaceKey: string) => void;
  /** Consumes an armed claim for `sessionId`; returns true when it became MAIN. */
  claimIfArmed: (workspaceKey: string, sessionId: string) => boolean;
}

export const useZaicodeMainSessions = create<ZaicodeMainSessionState>((set, get) => ({
  ...load(),
  armed: {},
  setMain: (workspaceKey, sessionId) => {
    if (get().byWorkspace[workspaceKey] === sessionId) return;
    const byWorkspace = { ...get().byWorkspace, [workspaceKey]: sessionId };
    save({ byWorkspace });
    set({ byWorkspace });
  },
  clearMain: (workspaceKey) => {
    if (!(workspaceKey in get().byWorkspace)) return;
    const byWorkspace = { ...get().byWorkspace };
    delete byWorkspace[workspaceKey];
    save({ byWorkspace });
    set({ byWorkspace });
  },
  arm: (workspaceKey) => set({ armed: { ...get().armed, [workspaceKey]: true } }),
  claimIfArmed: (workspaceKey, sessionId) => {
    if (!get().armed[workspaceKey]) return false;
    const armed = { ...get().armed };
    delete armed[workspaceKey];
    set({ armed });
    get().setMain(workspaceKey, sessionId);
    return true;
  },
}));

export function useZaicodeMainSessionId(workspaceKey: string): string | null {
  return useZaicodeMainSessions((state) => state.byWorkspace[workspaceKey] ?? null);
}

/**
 * SubSaipen modes offered in the composer strip. `parallel` modes only read
 * the project or write into their own package folders, so they can run next
 * to a working MAIN session without colliding with its edits; the others
 * change the tree or the board and are better run when MAIN is idle.
 */
export interface ZaicodeSaipenMode {
  label: string;
  command: string;
  hint: string;
  parallel: boolean;
}

export const ZAICODE_SAIPEN_MODES: readonly ZaicodeSaipenMode[] = [
  { label: "WIKI", command: "saiwiki", hint: "Wikier — saiwiki: write and refresh documentation", parallel: true },
  { label: "TRANSL", command: "saitranslate", hint: "Translator — saitranslate: translate docs and UI strings", parallel: true },
  { label: "TEST", command: "saitest", hint: "Tester — saitest: independently reproduce and verify", parallel: true },
  { label: "AUDIT", command: "aa", hint: "Auditor — saipen markhunt: dry audit, records findings, never fixes", parallel: true },
  { label: "HUNT", command: "saihunt", hint: "Hunter — saihunt: find bugs and weak spots", parallel: false },
  { label: "CLEAN", command: "saipen clean", hint: "Cleaner — saipen clean: remove junk, tidy the tree", parallel: false },
  { label: "CREW", command: "saipen crew", hint: "Crew — saipen crew: every sub-role in turn, polish until it shines", parallel: false },
];

/** Moves the MAIN session (when present) to the front of a project's session list. */
export function pinZaicodeMainFirst<T extends { taskId: string }>(tasks: readonly T[], mainId: string | null): T[] {
  if (!mainId) return [...tasks];
  const index = tasks.findIndex((task) => task.taskId === mainId);
  if (index <= 0) return [...tasks];
  return [tasks[index]!, ...tasks.slice(0, index), ...tasks.slice(index + 1)];
}
