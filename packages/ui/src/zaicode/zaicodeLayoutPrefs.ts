import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Which buttons sit in the sidebar header and which lines the sidebar menu
 * block shows, in the operator's order. Both lists are edited in place
 * (right-click the header / the menu) or in Settings -> Layout. Unknown ids
 * from an older build are dropped; ids added by a newer build append with
 * their defaults, so an upgrade never loses a button nor hides the order.
 */

export type ZaicodeHeaderToolId =
  | "home"
  | "back"
  | "forward"
  | "focusCycle"
  | "cycleArrows"
  | "menu"
  | "search"
  | "newTask"
  | "timers"
  | "help"
  | "mute"
  | "workers"
  | "dispatch"
  | "settings"
  | "meter";

export type ZaicodeNavItemId =
  | "saihome"
  | "newTask"
  | "zaicode"
  | "scheduler"
  | "search"
  | "plugins"
  | "timers"
  | "help"
  | "workers"
  | "settings";

export interface ZaicodeLayoutEntry<T extends string> {
  id: T;
  visible: boolean;
}

export interface ZaicodeLayoutItemDef<T extends string> {
  id: T;
  label: string;
  hint: string;
  visible: boolean;
}

export const ZAICODE_HEADER_TOOLS: readonly ZaicodeLayoutItemDef<ZaicodeHeaderToolId>[] = [
  { id: "home", label: "SAIHOME", hint: "The operator home: clock, limits, projects, agents, statistics (Alt+H)", visible: false },
  { id: "back", label: "Back", hint: "Previous place in the session history", visible: true },
  { id: "forward", label: "Forward", hint: "Next place in the session history", visible: true },
  { id: "focusCycle", label: "Focus next session", hint: "Click: next working / waiting session, round the ring. Right-click: back", visible: true },
  { id: "cycleArrows", label: "Session arrows ‹ ›", hint: "The same ring as two arrow buttons", visible: false },
  { id: "menu", label: "Menu toggle", hint: "Shows / hides the sidebar menu block (New task, ZAICODE, …)", visible: true },
  { id: "search", label: "Search", hint: "Command center: find sessions, files and commands (Ctrl+K)", visible: true },
  { id: "newTask", label: "New task", hint: "Starts a new session (Ctrl+N)", visible: false },
  { id: "timers", label: "Timers", hint: "Alarms, interval reminders, Temp Timer, productivity, calendar", visible: false },
  { id: "help", label: "Help", hint: "What every ZAICODE control does (F1)", visible: false },
  { id: "mute", label: "Mute sounds", hint: "Master mute of every ZAICODE sound", visible: false },
  { id: "workers", label: "WORKERS", hint: "Shows / hides the WORKERS panel (subscription CLIs docked under the chat)", visible: false },
  { id: "dispatch", label: "Dispatch", hint: "Opens a terminal or a vendor CLI in any project, each as its own instance", visible: true },
  { id: "settings", label: "Settings", hint: "Opens Settings", visible: false },
  { id: "meter", label: "Working meter", hint: "How many sessions work now, one readiness cell each; click a cell to open it", visible: true },
];

export const ZAICODE_NAV_ITEMS: readonly ZaicodeLayoutItemDef<ZaicodeNavItemId>[] = [
  // T-56: SAIHOME ("what is happening?") is its own line, first; New task ("what do I start?") stays the composer.
  { id: "saihome", label: "SAIHOME", hint: "The operator home: clock, limits, projects, agents, statistics", visible: true },
  { id: "newTask", label: "New task", hint: "Starts a new session in this project", visible: true },
  { id: "zaicode", label: "ZAICODE", hint: "Agents, queue and ready-made team presets", visible: true },
  // SRC-038: SCHEDULER replaces upstream's Automations page (same job -- prompts on a timer --
  // plus quota resets, sidebar sections, agents and presets, in plain words).
  { id: "scheduler", label: "SCHEDULER", hint: "Prompts that start by themselves: times, intervals, quota resets", visible: true },
  { id: "search", label: "Search", hint: "Command center (also an icon in the header)", visible: false },
  { id: "plugins", label: "Plugin Marketplace", hint: "Browse and install plugins", visible: false },
  { id: "timers", label: "Timers", hint: "Alarms, reminders, Temp Timer, productivity, calendar", visible: false },
  { id: "help", label: "Help", hint: "What every ZAICODE control does", visible: false },
  { id: "workers", label: "WORKERS", hint: "Shows / hides the WORKERS panel", visible: false },
  { id: "settings", label: "Settings", hint: "Opens Settings", visible: false },
];

/**
 * Stored list -> complete list: known ids in stored order; a new id lands
 * right after the entry that precedes it in the definitions (so a new menu
 * line appears where it belongs, not at the bottom), with its default.
 */
export function normalizeZaicodeLayoutList<T extends string>(
  raw: unknown,
  defs: readonly ZaicodeLayoutItemDef<T>[],
): ZaicodeLayoutEntry<T>[] {
  const known = new Map(defs.map((def) => [def.id as string, def]));
  const out: ZaicodeLayoutEntry<T>[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      const visible = (entry as { visible?: unknown }).visible;
      out.push({ id: id as T, visible: typeof visible === "boolean" ? visible : known.get(id)!.visible });
    }
  }
  defs.forEach((def, index) => {
    if (seen.has(def.id)) return;
    seen.add(def.id);
    const before = index > 0 ? out.findIndex((entry) => entry.id === defs[index - 1]!.id) : -1;
    // A new first definition goes first (not last): SAIHOME tops an older stored menu.
    out.splice(before >= 0 ? before + 1 : index === 0 ? 0 : out.length, 0, { id: def.id, visible: def.visible });
  });
  return out;
}

/** Moves entry `id` one step up (-1) or down (+1). */
export function moveZaicodeLayoutEntry<T extends string>(
  list: readonly ZaicodeLayoutEntry<T>[],
  id: T,
  direction: -1 | 1,
): ZaicodeLayoutEntry<T>[] {
  const index = list.findIndex((entry) => entry.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Moves entry `id` to position `to` (drag and drop). */
export function placeZaicodeLayoutEntry<T extends string>(
  list: readonly ZaicodeLayoutEntry<T>[],
  id: T,
  to: number,
): ZaicodeLayoutEntry<T>[] {
  const index = list.findIndex((entry) => entry.id === id);
  if (index < 0) return [...list];
  const next = [...list];
  const [entry] = next.splice(index, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, entry!);
  return next;
}

interface ZaicodeLayoutPrefs {
  headerTools: ZaicodeLayoutEntry<ZaicodeHeaderToolId>[];
  navItems: ZaicodeLayoutEntry<ZaicodeNavItemId>[];
}

const STORAGE_KEY = "zaicode-layout-v1";

function load(): ZaicodeLayoutPrefs {
  let raw: Partial<Record<keyof ZaicodeLayoutPrefs, unknown>> = {};
  try {
    raw = (JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null") as typeof raw | null) ?? {};
  } catch {
    raw = {};
  }
  return {
    headerTools: normalizeZaicodeLayoutList(raw.headerTools, ZAICODE_HEADER_TOOLS),
    navItems: normalizeZaicodeLayoutList(raw.navItems, ZAICODE_NAV_ITEMS),
  };
}

interface ZaicodeLayoutState extends ZaicodeLayoutPrefs {
  setHeaderTools: (list: ZaicodeLayoutEntry<ZaicodeHeaderToolId>[]) => void;
  setNavItems: (list: ZaicodeLayoutEntry<ZaicodeNavItemId>[]) => void;
  resetHeaderTools: () => void;
  resetNavItems: () => void;
}

export const useZaicodeLayout = create<ZaicodeLayoutState>((set, get) => {
  const persist = (patch: Partial<ZaicodeLayoutPrefs>) => {
    set(patch);
    try {
      const { headerTools, navItems } = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ headerTools, navItems }));
    } catch {
      // this session only
    }
  };
  return {
    ...load(),
    setHeaderTools: (headerTools) => persist({ headerTools: normalizeZaicodeLayoutList(headerTools, ZAICODE_HEADER_TOOLS) }),
    setNavItems: (navItems) => persist({ navItems: normalizeZaicodeLayoutList(navItems, ZAICODE_NAV_ITEMS) }),
    resetHeaderTools: () => persist({ headerTools: normalizeZaicodeLayoutList(null, ZAICODE_HEADER_TOOLS) }),
    resetNavItems: () => persist({ navItems: normalizeZaicodeLayoutList(null, ZAICODE_NAV_ITEMS) }),
  };
});
