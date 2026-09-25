import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Dispatch: open a terminal or a vendor CLI straight in a chosen project,
 * each as its own instance (AUDAPACK's per-project launcher). Engines come
 * from the Engines subsystem; these prefs hold where things open and the
 * operator's own launchers (any command line, e.g. `opencode .`).
 */

/** Own window = a separate PowerShell console that outlives ZAICODE; panel / window = in-app worker. */
export type ZaicodeDispatchWhere = "external" | "panel" | "window";

export interface ZaicodeDispatchLauncher {
  id: string;
  label: string;
  /** Up to 4 characters, shown on the tile. */
  short: string;
  /** Typed into PowerShell in the project folder; empty = a plain terminal. */
  command: string;
}

export interface ZaicodeDispatchPrefs {
  where: ZaicodeDispatchWhere;
  launchers: ZaicodeDispatchLauncher[];
  /** Last project picked in Dispatch (path); null = the active project. */
  lastProject: string | null;
}

export const ZAICODE_DISPATCH_DEFAULT_LAUNCHERS: readonly ZaicodeDispatchLauncher[] = [
  { id: "terminal", label: "Terminal", short: "PS", command: "" },
  { id: "opencode", label: "OpenCode", short: "OC", command: "opencode ." },
];

export const ZAICODE_DISPATCH_DEFAULT_PREFS: ZaicodeDispatchPrefs = {
  where: "external",
  launchers: [...ZAICODE_DISPATCH_DEFAULT_LAUNCHERS],
  lastProject: null,
};

const STORAGE_KEY = "zaicode-dispatch-prefs-v1";
const MAX_LAUNCHERS = 24;

function normalizeLauncher(raw: unknown, index: number): ZaicodeDispatchLauncher | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof ZaicodeDispatchLauncher, unknown>>;
  const label = typeof value.label === "string" ? value.label.trim().slice(0, 40) : "";
  if (!label) return null;
  const short = typeof value.short === "string" && value.short.trim() ? value.short.trim().slice(0, 4) : label.slice(0, 2).toUpperCase();
  return {
    id: typeof value.id === "string" && value.id ? value.id.slice(0, 60) : `launcher-${index}`,
    label,
    short,
    command: typeof value.command === "string" ? value.command.slice(0, 2000) : "",
  };
}

export function normalizeZaicodeDispatchPrefs(raw: unknown): ZaicodeDispatchPrefs {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeDispatchPrefs, unknown>>;
  const where: ZaicodeDispatchWhere = value.where === "panel" || value.where === "window" ? value.where : "external";
  const launchers = Array.isArray(value.launchers)
    ? value.launchers
        .map((item, index) => normalizeLauncher(item, index))
        .filter((item): item is ZaicodeDispatchLauncher => item !== null)
        .slice(0, MAX_LAUNCHERS)
    : [...ZAICODE_DISPATCH_DEFAULT_LAUNCHERS];
  const seen = new Set<string>();
  const unique = launchers.map((launcher, index) => {
    const id = seen.has(launcher.id) ? `${launcher.id}-${index}` : launcher.id;
    seen.add(id);
    return { ...launcher, id };
  });
  return {
    where,
    launchers: unique,
    lastProject: typeof value.lastProject === "string" && value.lastProject ? value.lastProject : null,
  };
}

function load(): ZaicodeDispatchPrefs {
  try {
    return normalizeZaicodeDispatchPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeDispatchPrefs(null);
  }
}

interface ZaicodeDispatchState extends ZaicodeDispatchPrefs {
  update: (patch: Partial<ZaicodeDispatchPrefs>) => void;
}

export const useZaicodeDispatch = create<ZaicodeDispatchState>((set, get) => ({
  ...load(),
  update: (patch) => {
    const { update: _update, ...current } = get();
    const next = normalizeZaicodeDispatchPrefs({ ...current, ...patch });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Preference only; the in-memory copy still applies.
    }
    set(next);
  },
}));

export interface ZaicodeDispatchProject {
  path: string;
  identity?: string;
  name: string;
}

/**
 * The project Dispatch opens in: the last one picked when it is still in the
 * list, else the active project, else the first one.
 */
export function pickZaicodeDispatchProject(
  projects: readonly ZaicodeDispatchProject[],
  lastProject: string | null,
  activePath: string | null,
): ZaicodeDispatchProject | null {
  return (
    projects.find((project) => project.path === lastProject) ??
    projects.find((project) => project.path === activePath) ??
    projects[0] ??
    null
  );
}

/** Console title for an external instance: "OC _ZAICODE | ZAICODE". */
export function zaicodeDispatchTitle(short: string, projectName: string): string {
  return `${short} ${projectName} | ZAICODE`;
}
