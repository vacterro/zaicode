import { create } from "zustand";
import { ZAICODE_STREAK_MEASURES, type ZaicodeStreakMeasure } from "@zcode/shared";
import { readZaicodeSetting } from "../zaicodeSettingsSnapshot.js";

/**
 * SAIHOME preferences (T-56), one local record per ZAICODE profile:
 * startup view, layout (preset or the operator's own arrangement), clock,
 * statistics and refresh. Unknown / older values fall back to defaults; a
 * widget added by a newer build appears in CUSTOM at its default place.
 */

export type ZaicodeHomeWidgetId =
  | "clock"
  | "now"
  | "actions"
  | "stats"
  | "limits"
  | "scheduler"
  | "fleet"
  | "agents"
  | "streak"
  | "routing"
  | "saipen"
  | "saimail"
  | "nerd"
  | "activity";

export type ZaicodeHomeWidgetSize = "compact" | "normal" | "large";

export interface ZaicodeHomeWidgetDef {
  id: ZaicodeHomeWidgetId;
  label: string;
  hint: string;
  size: ZaicodeHomeWidgetSize;
}

export const ZAICODE_HOME_WIDGETS: readonly ZaicodeHomeWidgetDef[] = [
  { id: "clock", label: "Clock", hint: "Large analog clock, date and time zone", size: "normal" },
  { id: "now", label: "Now", hint: "Working, queue, today, next reset / schedule, health", size: "large" },
  { id: "actions", label: "Needs you", hint: "Problems with one next step each; empty when all is well", size: "large" },
  { id: "stats", label: "Tokens & work", hint: "Tokens today, yesterday, week, month, all time; runs and runtime", size: "normal" },
  { id: "limits", label: "AI limits", hint: "Every subscription's quota, resets and prepared prompts", size: "normal" },
  { id: "scheduler", label: "Scheduler", hint: "The next armed schedules and their countdowns", size: "normal" },
  { id: "fleet", label: "Projects", hint: "Every project: SAIPEN phase, work, blocker, workers", size: "large" },
  { id: "agents", label: "Agents", hint: "Running sessions, workers and queue runs", size: "normal" },
  { id: "streak", label: "Activity", hint: "Day squares with current and longest streak", size: "large" },
  { id: "routing", label: "Routing", hint: "Router, SAIFREN and SAIOPP health", size: "compact" },
  { id: "saipen", label: "SAIPEN", hint: "Protocol state over all projects", size: "compact" },
  { id: "saimail", label: "SAIMAIL", hint: "Unread mail (hidden when there is none)", size: "compact" },
  { id: "nerd", label: "Numbers", hint: "Streaks, ratios, busiest day, peak hour, favourite model", size: "normal" },
  { id: "activity", label: "Recent", hint: "Latest queue runs and worker sessions", size: "normal" },
];

export type ZaicodeHomePreset = "everything" | "minimal" | "operator" | "stats" | "factory" | "custom";

export const ZAICODE_HOME_PRESETS: Record<Exclude<ZaicodeHomePreset, "custom">, { label: string; widgets: readonly ZaicodeHomeWidgetId[] }> = {
  everything: {
    label: "EVERYTHING",
    widgets: ["clock", "now", "actions", "stats", "limits", "scheduler", "fleet", "agents", "streak", "routing", "saipen", "saimail", "nerd", "activity"],
  },
  minimal: { label: "MINIMAL", widgets: ["clock", "now", "limits", "scheduler", "actions"] },
  operator: { label: "OPERATOR", widgets: ["clock", "now", "actions", "limits", "fleet", "agents", "scheduler", "routing"] },
  stats: { label: "STATS", widgets: ["clock", "stats", "streak", "nerd", "activity"] },
  factory: { label: "FACTORY", widgets: ["now", "actions", "fleet", "agents", "scheduler", "limits", "routing", "saipen"] },
};

export interface ZaicodeHomeWidgetEntry {
  id: ZaicodeHomeWidgetId;
  visible: boolean;
  size: ZaicodeHomeWidgetSize;
}

export type ZaicodeStartupView = "home" | "last" | "newTask";
export type ZaicodeRememberedView = "home" | "chat" | "zaicode";

export interface ZaicodeHomeClockPrefs {
  size: "small" | "medium" | "large";
  secondHand: boolean;
  smooth: boolean;
  numerals: boolean;
  date: boolean;
  timeZone: boolean;
  /** 24 / 12-hour digital line under the face, or none. */
  digital: "24" | "12" | "off";
  /** IANA zone of a second clock line ("" = none). */
  secondZone: string;
}

export interface ZaicodeHomePrefs {
  startup: ZaicodeStartupView;
  lastView: ZaicodeRememberedView;
  preset: ZaicodeHomePreset;
  /** The operator's own arrangement (CUSTOM). */
  custom: ZaicodeHomeWidgetEntry[];
  density: "compact" | "normal";
  clock: ZaicodeHomeClockPrefs;
  statsRange: "today" | "week" | "month" | "all";
  streakMeasure: ZaicodeStreakMeasure;
  weekStartsOn: 0 | 1;
  gridDays: number;
  /** Seconds between SAIHOME refreshes while it is on screen. */
  refreshSeconds: number;
}

export const ZAICODE_HOME_CLOCK_DEFAULTS: ZaicodeHomeClockPrefs = {
  size: "medium",
  secondHand: true,
  smooth: false,
  numerals: true,
  date: true,
  timeZone: true,
  digital: "24",
  secondZone: "",
};

function defaultCustom(): ZaicodeHomeWidgetEntry[] {
  const everything = new Set<string>(ZAICODE_HOME_PRESETS.everything.widgets);
  return ZAICODE_HOME_WIDGETS.map((widget) => ({ id: widget.id, visible: everything.has(widget.id), size: widget.size }));
}

export const ZAICODE_HOME_DEFAULTS: ZaicodeHomePrefs = {
  startup: "home",
  lastView: "home",
  preset: "everything",
  custom: defaultCustom(),
  density: "normal",
  clock: ZAICODE_HOME_CLOCK_DEFAULTS,
  statsRange: "today",
  streakMeasure: "activity",
  weekStartsOn: 1,
  gridDays: 182,
  refreshSeconds: 60,
};

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const SIZES = ["compact", "normal", "large"] as const;

/** Stored list -> every known widget once, stored order first, new widgets at their default place. */
export function normalizeZaicodeHomeWidgets(raw: unknown): ZaicodeHomeWidgetEntry[] {
  const known = new Map(ZAICODE_HOME_WIDGETS.map((widget) => [widget.id as string, widget]));
  const out: ZaicodeHomeWidgetEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      const record = entry as { visible?: unknown; size?: unknown };
      out.push({
        id: id as ZaicodeHomeWidgetId,
        visible: typeof record.visible === "boolean" ? record.visible : true,
        size: pick(record.size, SIZES, known.get(id)!.size),
      });
    }
  }
  ZAICODE_HOME_WIDGETS.forEach((widget, index) => {
    if (seen.has(widget.id)) return;
    const before = index > 0 ? out.findIndex((entry) => entry.id === ZAICODE_HOME_WIDGETS[index - 1]!.id) : -1;
    out.splice(before >= 0 ? before + 1 : index === 0 ? 0 : out.length, 0, { id: widget.id, visible: true, size: widget.size });
  });
  return out;
}

export function normalizeZaicodeHomePrefs(raw: unknown): ZaicodeHomePrefs {
  const d = ZAICODE_HOME_DEFAULTS;
  if (!raw || typeof raw !== "object") return { ...d, custom: defaultCustom(), clock: { ...d.clock } };
  const r = raw as Partial<Record<keyof ZaicodeHomePrefs, unknown>>;
  const c = (r.clock && typeof r.clock === "object" ? r.clock : {}) as Partial<Record<keyof ZaicodeHomeClockPrefs, unknown>>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const gridDays = Number(r.gridDays);
  const refresh = Number(r.refreshSeconds);
  return {
    startup: pick(r.startup, ["home", "last", "newTask"] as const, d.startup),
    lastView: pick(r.lastView, ["home", "chat", "zaicode"] as const, d.lastView),
    preset: pick(r.preset, ["everything", "minimal", "operator", "stats", "factory", "custom"] as const, d.preset),
    custom: normalizeZaicodeHomeWidgets(r.custom),
    density: pick(r.density, ["compact", "normal"] as const, d.density),
    clock: {
      size: pick(c.size, ["small", "medium", "large"] as const, d.clock.size),
      secondHand: flag(c.secondHand, d.clock.secondHand),
      smooth: flag(c.smooth, d.clock.smooth),
      numerals: flag(c.numerals, d.clock.numerals),
      date: flag(c.date, d.clock.date),
      timeZone: flag(c.timeZone, d.clock.timeZone),
      digital: pick(c.digital, ["24", "12", "off"] as const, d.clock.digital),
      secondZone: typeof c.secondZone === "string" ? c.secondZone.trim().slice(0, 64) : d.clock.secondZone,
    },
    statsRange: pick(r.statsRange, ["today", "week", "month", "all"] as const, d.statsRange),
    streakMeasure: pick(r.streakMeasure, ZAICODE_STREAK_MEASURES, d.streakMeasure),
    weekStartsOn: r.weekStartsOn === 0 ? 0 : 1,
    gridDays: Number.isFinite(gridDays) ? Math.max(28, Math.min(371, Math.trunc(gridDays))) : d.gridDays,
    refreshSeconds: Number.isFinite(refresh) ? Math.max(15, Math.min(600, Math.trunc(refresh))) : d.refreshSeconds,
  };
}

/** The widgets on screen, in order, for the current preset. */
export function zaicodeHomeLayout(prefs: Pick<ZaicodeHomePrefs, "preset" | "custom">): ZaicodeHomeWidgetEntry[] {
  if (prefs.preset === "custom") return prefs.custom.filter((entry) => entry.visible);
  const sizes = new Map(prefs.custom.map((entry) => [entry.id, entry.size]));
  return ZAICODE_HOME_PRESETS[prefs.preset].widgets.map((id) => ({
    id,
    visible: true,
    size: sizes.get(id) ?? ZAICODE_HOME_WIDGETS.find((widget) => widget.id === id)!.size,
  }));
}

/** The first view after a start: SAIHOME, the remembered one, or the composer. */
export function zaicodeStartupMainView(prefs: Pick<ZaicodeHomePrefs, "startup" | "lastView">): "saihome" | "chat" | "zaicode" {
  if (prefs.startup === "newTask") return "chat";
  if (prefs.startup === "last") return prefs.lastView === "home" ? "saihome" : prefs.lastView;
  return "saihome";
}

const STORAGE_KEY = "zaicode-home-v1";

function load(): ZaicodeHomePrefs {
  try {
    return normalizeZaicodeHomePrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeHomePrefs(null);
  }
}

interface ZaicodeHomePrefsState extends ZaicodeHomePrefs {
  update: (patch: Partial<ZaicodeHomePrefs>) => void;
  setClock: (patch: Partial<ZaicodeHomeClockPrefs>) => void;
  /** Switching to CUSTOM starts from what is on screen, so nothing jumps. */
  editLayout: (custom: ZaicodeHomeWidgetEntry[]) => void;
  resetLayout: () => void;
}

export const useZaicodeHomePrefs = create<ZaicodeHomePrefsState>((set, get) => {
  const persist = (patch: Partial<ZaicodeHomePrefs>) => {
    set(patch);
    try {
      const { update: _u, setClock: _c, editLayout: _e, resetLayout: _r, ...prefs } = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // this session only
    }
  };
  return {
    ...load(),
    update: (patch) => persist(normalizeZaicodeHomePrefs({ ...get(), ...patch })),
    setClock: (patch) => persist({ clock: normalizeZaicodeHomePrefs({ clock: { ...get().clock, ...patch } }).clock }),
    editLayout: (custom) => persist({ preset: "custom", custom: normalizeZaicodeHomeWidgets(custom) }),
    resetLayout: () => persist({ preset: ZAICODE_HOME_DEFAULTS.preset, custom: defaultCustom(), density: ZAICODE_HOME_DEFAULTS.density }),
  };
});

export function readZaicodeHomePrefs(): ZaicodeHomePrefs {
  return useZaicodeHomePrefs.getState();
}
