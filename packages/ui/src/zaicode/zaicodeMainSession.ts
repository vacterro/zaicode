import { create } from "zustand";
import type { ZaicodePersistentRole } from "./zaicodeSessionRoles.js";

/**
 * ZAICODE MAIN session ("iron slot") per project.
 *
 * Every project has one MAIN session: the place where the work starts and is
 * planned (START / STEP / planning commands). Other sessions of the project
 * are side slots — parallel helpers such as subSaipens (WIKI, TRANSL, TEST,
 * HUNT) that can run next to MAIN without touching its work.
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
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<Persisted> | null;
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
export function foldZaicodeMainKeys(
  byWorkspace: Readonly<Record<string, string>>,
): Record<string, string> {
  const byForm = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(byWorkspace))
    byForm.set(zaicodeMainKeyForm(key), [key, value]);
  return Object.fromEntries(byForm.values());
}

function save(value: Persisted): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    // Preference only; the in-memory map still applies for this window.
    return false;
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
export function resolveZaicodeMainKey(
  byWorkspace: Readonly<Record<string, string>>,
  key: string,
): string {
  if (key in byWorkspace) return key;
  const form = zaicodeMainKeyForm(key);
  for (const existing of Object.keys(byWorkspace)) {
    if (zaicodeMainKeyForm(existing) === form) return existing;
  }
  return key;
}

/** MAIN's session id for a project under any spelling of its path. */
export function zaicodeMainSessionIdOf(
  byWorkspace: Readonly<Record<string, string>>,
  key: string,
): string | null {
  return byWorkspace[resolveZaicodeMainKey(byWorkspace, key)] ?? null;
}

interface ZaicodeMainSessionState extends Persisted {
  /** Projects whose next created session becomes MAIN (START from a draft, "new MAIN"). */
  armed: Record<string, true>;
  setMain: (workspaceKey: string, sessionId: string) => void;
  clearMain: (workspaceKey: string) => void;
  /**
   * One coordinated MAIN write for the bulk assignment: a single map build and a
   * single durable write, so a half-applied bulk command cannot be reported as
   * done. Existing valid entries are preserved; only the given keys move.
   * Returns false when the durable write was refused.
   */
  setMainBulk: (entries: readonly { workspaceKey: string; sessionId: string }[]) => boolean;
  arm: (workspaceKey: string) => void;
  disarm: (workspaceKey: string) => void;
  /** Live read after an edit; a snapshot from before the edit cannot see it. */
  currentMain: (workspaceKey: string) => string | null;
  provision: (workspaceKey: string, sessionId: string | null) => () => void;
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
  setMainBulk: (entries) => {
    if (entries.length === 0) return true;
    const current = get().byWorkspace;
    // Two spellings of one project collapse to one key; the later entry wins.
    const merged: Record<string, string> = { ...current };
    const targets: [string, string][] = [];
    for (const entry of entries) {
      if (!entry.workspaceKey || !entry.sessionId) continue;
      if (current[entry.workspaceKey] === entry.sessionId) continue;
      targets.push([resolveZaicodeMainKey(merged, entry.workspaceKey), entry.sessionId]);
    }
    if (targets.length === 0) return true;
    for (const [key, sessionId] of targets) merged[key] = sessionId;
    const persisted = save({ byWorkspace: merged });
    set({ byWorkspace: merged });
    return persisted;
  },
  arm: (workspaceKey) =>
    set({ armed: { ...get().armed, [zaicodeMainKeyForm(workspaceKey)]: true } }),
  currentMain: (workspaceKey) =>
    zaicodeMainSessionIdOf(get().byWorkspace, workspaceKey),
  disarm: (workspaceKey) => {
    const armedKey = zaicodeMainKeyForm(workspaceKey);
    if (!get().armed[armedKey]) return;
    const armed = { ...get().armed };
    delete armed[armedKey];
    set({ armed });
  },
  provision: (workspaceKey, sessionId) => {
    const initial = get();
    if (zaicodeMainSessionIdOf(initial.byWorkspace, workspaceKey)) return () => {};
    const armedKey = zaicodeMainKeyForm(workspaceKey);
    const alreadyArmed = Boolean(initial.armed[armedKey]);
    if (sessionId) initial.setMain(workspaceKey, sessionId);
    else initial.arm(workspaceKey);
    return () => {
      if (sessionId) {
        if (zaicodeMainSessionIdOf(get().byWorkspace, workspaceKey) === sessionId) {
          get().clearMain(workspaceKey);
        }
      } else if (!alreadyArmed) {
        // 仅撤销本次拒绝的 MAIN 预约；不能让后续 helper 继承，也不能清掉已有 owner。
        const armed = { ...get().armed };
        delete armed[armedKey];
        set({ armed });
      }
    };
  },
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

// A MAIN written by another renderer window reaches this one through the
// storage event; the armed claim stays local, so only the map is adopted.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    useZaicodeMainSessions.setState({ byWorkspace: load().byWorkspace });
  });
}

interface ModeAction {
  command: string;
  description: string;
  hint: string;
}

export type ZaicodeModeAction = ModeAction &
  (
    | { kind: "core"; ownership: "main"; parallel: false; role?: never }
    | { kind: "subSaipen"; ownership: "helper"; parallel: boolean; role: ZaicodePersistentRole }
  );

/**
 * SubSaipen and Core modes offered in the composer strip.
 * Normal click triggers the canonical Core command in MAIN;
 * Shift+Click triggers the persistent subSaipen role in a helper session
 * when a supported role exists.
 */
export interface ZaicodeSaipenMode {
  label: string;
  defaultAction: ZaicodeModeAction;
  shiftAction?: ZaicodeModeAction;
}

export function resolveZaicodeModeAction(
  mode: { defaultAction: ZaicodeModeAction; shiftAction?: ZaicodeModeAction },
  shiftKey: boolean,
): ZaicodeModeAction {
  if (shiftKey && mode.shiftAction) {
    return mode.shiftAction;
  }
  return mode.defaultAction;
}

export function formatZaicodeModeTooltip(mode: {
  label: string;
  defaultAction: ZaicodeModeAction;
  shiftAction?: ZaicodeModeAction;
}): string {
  if (mode.shiftAction) {
    return `${mode.label}\nClick: ${mode.defaultAction.description} (${mode.defaultAction.command}; MAIN)\nShift+Click: ${mode.shiftAction.description} (${mode.shiftAction.command}; helper, OUTBOX)`;
  }
  return `${mode.label}\nClick: ${mode.defaultAction.description} (${mode.defaultAction.command}; MAIN)`;
}

export const ZAICODE_SAIPEN_MODES: readonly ZaicodeSaipenMode[] = [
  {
    label: "WIKI",
    defaultAction: {
      command: "qq",
      kind: "core",
      description: "Core WIKI",
      hint: "Core WIKI — prepare saiwiki package",
      parallel: false,
      ownership: "main",
    },
    shiftAction: {
      command: "saiwiki",
      kind: "subSaipen",
      role: "WIKI",
      description: "persistent SAIWIKI",
      hint: "Wikier — saiwiki: write and refresh documentation",
      parallel: true,
      ownership: "helper",
    },
  },
  {
    label: "TRANSL",
    defaultAction: {
      command: "saipen translate",
      kind: "core",
      description: "Core TRANSLATE",
      hint: "Core TRANSLATE — saipen translate",
      parallel: false,
      ownership: "main",
    },
    shiftAction: {
      command: "saitranslate",
      kind: "subSaipen",
      role: "TRANSL",
      description: "persistent SAITRANSLATE",
      hint: "Translator — saitranslate: translate docs and UI strings",
      parallel: true,
      ownership: "helper",
    },
  },
  {
    label: "TEST",
    defaultAction: {
      command: "tt",
      kind: "core",
      description: "Core TEST",
      hint: "Core TEST — tt: run the declared suite, read-only",
      parallel: false,
      ownership: "main",
    },
    shiftAction: {
      command: "saitest",
      kind: "subSaipen",
      role: "TEST",
      description: "persistent SAITEST",
      hint: "Tester — saitest: independently reproduce and verify",
      parallel: true,
      ownership: "helper",
    },
  },
  {
    label: "HUNT",
    defaultAction: {
      command: "hh",
      kind: "core",
      description: "Core HUNT",
      hint: "Hunter — hh: autonomous defect/improvement scan",
      parallel: false,
      ownership: "main",
    },
    shiftAction: {
      command: "saihunt",
      kind: "subSaipen",
      role: "HUNT",
      description: "persistent SAIHUNT",
      hint: "Hunter — saihunt: find bugs and weak spots",
      parallel: true,
      ownership: "helper",
    },
  },
  {
    label: "AUDIT",
    defaultAction: {
      command: "aa",
      kind: "core",
      description: "Core AUDIT",
      hint: "Auditor — aa: dry audit, records findings, never fixes",
      parallel: false,
      ownership: "main",
    },
  },
  {
    label: "CLEAN",
    defaultAction: {
      command: "saipen clean",
      kind: "core",
      description: "Core CLEAN",
      hint: "Cleaner — saipen clean: remove junk, tidy the tree",
      parallel: false,
      ownership: "main",
    },
  },
  {
    label: "CREW",
    defaultAction: {
      command: "sc",
      kind: "core",
      description: "Core CREW",
      hint: "Crew — sc: serial full-platoon convergence circuit",
      parallel: false,
      ownership: "main",
    },
  },
];

/** Moves the MAIN session (when present) to the front of a project's session list. */
export function pinZaicodeMainFirst<T extends { taskId: string }>(
  tasks: readonly T[],
  mainId: string | null,
): T[] {
  if (!mainId) return [...tasks];
  const index = tasks.findIndex((task) => task.taskId === mainId);
  if (index <= 0) return [...tasks];
  return [tasks[index]!, ...tasks.slice(0, index), ...tasks.slice(index + 1)];
}
