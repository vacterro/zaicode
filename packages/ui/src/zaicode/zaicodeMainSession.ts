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
    return { byWorkspace: foldZaicodeMainKeys(byWorkspace) };
  } catch {
    return { byWorkspace: {} };
  }
}

/** Two saved entries for one project (two spellings of its path) become one: the later one wins. */
export function foldZaicodeMainKeys(byWorkspace: Readonly<Record<string, string>>): Record<string, string> {
  const byForm = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(byWorkspace)) byForm.set(zaicodeMainKeyForm(key), [key, value]);
  return Object.fromEntries(byForm.values());
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

/**
 * How two spellings of one project path compare: C:\a\b, c:/a/b/ and C:/a/b are one key.
 * The project row, the composer, CONTINUE ALL and the scheduler each name a project with
 * the path they were handed, and a MAIN written under one spelling was invisible under
 * another: the row then listed the very session it stands for as its own child (SRC-081).
 * Only drive-letter paths fold case; identities and other paths are compared as written.
 */
export function zaicodeMainKeyForm(key: string): string {
  const slashed = key.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:(\/|$)/i.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** The key already in the map that means `key`, else `key` itself (so old saved keys keep working). */
export function resolveZaicodeMainKey(byWorkspace: Readonly<Record<string, string>>, key: string): string {
  if (key in byWorkspace) return key;
  const form = zaicodeMainKeyForm(key);
  for (const existing of Object.keys(byWorkspace)) {
    if (zaicodeMainKeyForm(existing) === form) return existing;
  }
  return key;
}

/** MAIN's session id for a project under any spelling of its path. */
export function zaicodeMainSessionIdOf(byWorkspace: Readonly<Record<string, string>>, key: string): string | null {
  return byWorkspace[resolveZaicodeMainKey(byWorkspace, key)] ?? null;
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
    // One project, one entry, however its path was spelled by the caller.
    const key = resolveZaicodeMainKey(get().byWorkspace, workspaceKey);
    if (get().byWorkspace[key] === sessionId) return;
    const byWorkspace = { ...get().byWorkspace, [key]: sessionId };
    save({ byWorkspace });
    set({ byWorkspace });
  },
  clearMain: (workspaceKey) => {
    const key = resolveZaicodeMainKey(get().byWorkspace, workspaceKey);
    if (!(key in get().byWorkspace)) return;
    const byWorkspace = { ...get().byWorkspace };
    delete byWorkspace[key];
    save({ byWorkspace });
    set({ byWorkspace });
  },
  arm: (workspaceKey) => set({ armed: { ...get().armed, [zaicodeMainKeyForm(workspaceKey)]: true } }),
  claimIfArmed: (workspaceKey, sessionId) => {
    const armedKey = zaicodeMainKeyForm(workspaceKey);
    if (!get().armed[armedKey]) return false;
    const armed = { ...get().armed };
    delete armed[armedKey];
    set({ armed });
    get().setMain(workspaceKey, sessionId);
    return true;
  },
}));

export function useZaicodeMainSessionId(workspaceKey: string): string | null {
  return useZaicodeMainSessions((state) => zaicodeMainSessionIdOf(state.byWorkspace, workspaceKey));
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
