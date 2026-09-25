import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { recordZaicodeHomeEvent } from "./home/zaicodeHomeJournal.js";

/**
 * ZAICODE notifications: one scenario per kind of moment, each with its own
 * card (in-app, FastPrompter-style), Windows notification, how long it stays
 * and whether the thing that changed glows for a while ("fresh from the
 * oven": which subscription refilled, which window reset). Sounds stay in the
 * Sounds table; quiet hours can silence cards and sounds together.
 */

export type ZaicodeNotifyGroup = "Agents" | "Limits" | "Workers" | "Timers" | "Other";

export interface ZaicodeNotifyScenarioSetting {
  /** In-app card. */
  toast: boolean;
  /** Windows notification, only while ZAICODE is in the background. */
  system: boolean;
  /** Seconds the card stays; 0 = until dismissed. */
  seconds: number;
  /** Glow on the thing that changed. */
  highlight: boolean;
  highlightMinutes: number;
}

export interface ZaicodeNotifyScenarioDef {
  id: string;
  group: ZaicodeNotifyGroup;
  label: string;
  hint: string;
  /** Scenario can mark something as fresh (limits, engines). */
  canHighlight: boolean;
  defaults: ZaicodeNotifyScenarioSetting;
}

const card = (seconds: number, extra: Partial<ZaicodeNotifyScenarioSetting> = {}): ZaicodeNotifyScenarioSetting => ({
  toast: true,
  system: false,
  seconds,
  highlight: false,
  highlightMinutes: 0,
  ...extra,
});

export const ZAICODE_NOTIFY_SCENARIOS: readonly ZaicodeNotifyScenarioDef[] = [
  { id: "agent.done", group: "Agents", label: "Turn finished", hint: "A session finished its turn", canHighlight: false, defaults: card(6, { toast: false }) },
  { id: "agent.failed", group: "Agents", label: "Turn failed", hint: "A session ended with an error", canHighlight: false, defaults: card(12) },
  { id: "agent.question", group: "Agents", label: "Question", hint: "An agent asks you something or wants a plan approved", canHighlight: false, defaults: card(0) },
  { id: "agent.human", group: "Agents", label: "Human needed", hint: "An agent needs your permission to continue", canHighlight: false, defaults: card(0) },
  { id: "limits.refill", group: "Limits", label: "Quota refilled / window reset", hint: "A subscription window reset: the card names the exact window, the meter and engine tile glow", canHighlight: true, defaults: card(12, { highlight: true, highlightMinutes: 20 }) },
  { id: "limits.low", group: "Limits", label: "Quota low / out", hint: "A subscription dropped under 20% or ran out", canHighlight: true, defaults: card(10, { highlight: true, highlightMinutes: 10 }) },
  { id: "worker.exit", group: "Workers", label: "Worker finished", hint: "A subscription CLI worker exited normally", canHighlight: false, defaults: card(6, { toast: false }) },
  { id: "worker.fail", group: "Workers", label: "Worker crashed", hint: "A worker exited with an error code", canHighlight: false, defaults: card(15) },
  { id: "autostart.fire", group: "Workers", label: "Autostart fired", hint: "A scheduled autostart launched", canHighlight: false, defaults: card(8) },
  { id: "autostart.missed", group: "Workers", label: "Autostart missed", hint: "A scheduled autostart missed its window", canHighlight: false, defaults: card(0) },
  { id: "timer.fire", group: "Timers", label: "Timer / alarm", hint: "An alarm, calendar event or the Temp Timer went off (snooze buttons on the card)", canHighlight: false, defaults: card(30, { system: true }) },
  { id: "interval.fire", group: "Timers", label: "Interval reminder", hint: "An interval rule with “Show notification” reached its time", canHighlight: false, defaults: card(4) },
  { id: "productivity.phase", group: "Timers", label: "Work / break phase", hint: "The productivity timer switched between work and break", canHighlight: false, defaults: card(0, { system: true }) },
  { id: "router.free", group: "Other", label: "Free model added", hint: "The daily scan added a new free model to SAIFREN", canHighlight: false, defaults: card(15) },
  { id: "router.ready", group: "Other", label: "SAIFREN ready", hint: "ZAICODE set up its free models on its own (first start)", canHighlight: false, defaults: card(20) },
  { id: "saimail.new", group: "Other", label: "New SAIMAIL letter", hint: "A letter arrived in your SAIMAIL inbox", canHighlight: false, defaults: card(8) },
  { id: "problip.goal", group: "Other", label: "Problip goal", hint: "The problip counter reached a round number", canHighlight: false, defaults: card(5) },
];

const SCENARIO_BY_ID = new Map(ZAICODE_NOTIFY_SCENARIOS.map((scenario) => [scenario.id, scenario]));

export type ZaicodeNotifyPosition = "bottom-right" | "top-right" | "bottom-left" | "top-center";

/**
 * Where notifications go (SRC-035). "custom" = each moment's own Card /
 * Windows ticks; the other three send every moment that is on (either tick)
 * to the in-app card, to Windows, or to both.
 */
export type ZaicodeNotifyDelivery = "custom" | "in-app" | "windows" | "both";

/**
 * When a glow ("this just reset") ends (SRC-035). Any enabled condition ends
 * it; with none enabled it stays until the next reset of the same thing.
 */
export interface ZaicodeGlowRules {
  /** After the moment's "Glow min". */
  timed: boolean;
  /** After the pointer rests on it for a moment (seen). */
  hover: boolean;
  /** When it is clicked (acknowledged). */
  click: boolean;
  /** When that quota starts going down again (it is being used). */
  use: boolean;
  /** Fades as it ages instead of staying at full strength. */
  fade: boolean;
}

export interface ZaicodeNotifySettings {
  enabled: boolean;
  position: ZaicodeNotifyPosition;
  /** Cards on screen at once; older ones fold into "+N more". */
  maxVisible: number;
  quietEnabled: boolean;
  /** Minute of day; a window past midnight wraps. */
  quietFrom: number;
  quietTo: number;
  /** Quiet hours also mute ZAICODE sounds. */
  quietSounds: boolean;
  delivery: ZaicodeNotifyDelivery;
  /** Windows notifications also while ZAICODE is the active window (always on for delivery "windows"). */
  systemWhenFocused: boolean;
  glow: ZaicodeGlowRules;
  scenarios: Record<string, ZaicodeNotifyScenarioSetting>;
}

const STORAGE_KEY = "zaicode-notifications-v1";
const CHANGE_EVENT = "zaicode-notifications-changed";

export function defaultZaicodeNotifySettings(): ZaicodeNotifySettings {
  const scenarios: Record<string, ZaicodeNotifyScenarioSetting> = {};
  for (const scenario of ZAICODE_NOTIFY_SCENARIOS) scenarios[scenario.id] = { ...scenario.defaults };
  return {
    enabled: true,
    position: "bottom-right",
    maxVisible: 4,
    quietEnabled: false,
    quietFrom: 23 * 60,
    quietTo: 7 * 60,
    quietSounds: false,
    delivery: "custom",
    systemWhenFocused: false,
    glow: { timed: true, hover: false, click: true, use: true, fade: true },
    scenarios,
  };
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

export function normalizeZaicodeNotifySettings(raw: unknown): ZaicodeNotifySettings {
  const base = defaultZaicodeNotifySettings();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<ZaicodeNotifySettings>;
  const scenarios = { ...base.scenarios };
  for (const [id, value] of Object.entries(r.scenarios ?? {})) {
    const current = scenarios[id];
    if (!current || !value || typeof value !== "object") continue;
    scenarios[id] = {
      toast: typeof value.toast === "boolean" ? value.toast : current.toast,
      system: typeof value.system === "boolean" ? value.system : current.system,
      seconds: num(value.seconds, 0, 600, current.seconds),
      highlight: typeof value.highlight === "boolean" ? value.highlight : current.highlight,
      highlightMinutes: num(value.highlightMinutes, 0, 240, current.highlightMinutes),
    };
  }
  const positions: readonly ZaicodeNotifyPosition[] = ["bottom-right", "top-right", "bottom-left", "top-center"];
  const deliveries: readonly ZaicodeNotifyDelivery[] = ["custom", "in-app", "windows", "both"];
  const glowRaw = (r.glow ?? {}) as Partial<Record<keyof ZaicodeGlowRules, unknown>>;
  const glow = { ...base.glow };
  for (const key of Object.keys(glow) as (keyof ZaicodeGlowRules)[]) {
    if (typeof glowRaw[key] === "boolean") glow[key] = glowRaw[key] as boolean;
  }
  return {
    enabled: r.enabled !== false,
    position: positions.includes(r.position as ZaicodeNotifyPosition) ? (r.position as ZaicodeNotifyPosition) : base.position,
    maxVisible: num(r.maxVisible, 1, 10, base.maxVisible),
    quietEnabled: r.quietEnabled === true,
    quietFrom: num(r.quietFrom, 0, 1439, base.quietFrom),
    quietTo: num(r.quietTo, 0, 1439, base.quietTo),
    quietSounds: r.quietSounds === true,
    delivery: deliveries.includes(r.delivery as ZaicodeNotifyDelivery) ? (r.delivery as ZaicodeNotifyDelivery) : base.delivery,
    systemWhenFocused: r.systemWhenFocused === true,
    glow,
    scenarios,
  };
}

/** Where one moment goes under the chosen delivery. */
export function zaicodeNotifyChannels(
  settings: Pick<ZaicodeNotifySettings, "delivery">,
  row: Pick<ZaicodeNotifyScenarioSetting, "toast" | "system">,
): { toast: boolean; system: boolean } {
  if (settings.delivery === "custom") return { toast: row.toast, system: row.system };
  const on = row.toast || row.system;
  return {
    toast: on && settings.delivery !== "windows",
    system: on && settings.delivery !== "in-app",
  };
}

let cached: ZaicodeNotifySettings | null = null;

export function readZaicodeNotifySettings(): ZaicodeNotifySettings {
  if (cached) return cached;
  try {
    cached = normalizeZaicodeNotifySettings(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    cached = defaultZaicodeNotifySettings();
  }
  return cached;
}

function write(next: ZaicodeNotifySettings): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // applies for this window anyway
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setZaicodeNotifySettings(patch: Partial<Omit<ZaicodeNotifySettings, "scenarios">>): void {
  if (patch.glow) patch = { ...patch, glow: { ...readZaicodeNotifySettings().glow, ...patch.glow } };
  write(normalizeZaicodeNotifySettings({ ...readZaicodeNotifySettings(), ...patch }));
}

export function setZaicodeNotifyScenario(id: string, patch: Partial<ZaicodeNotifyScenarioSetting>): void {
  const current = readZaicodeNotifySettings();
  const row = current.scenarios[id];
  if (!row) return;
  write(normalizeZaicodeNotifySettings({ ...current, scenarios: { ...current.scenarios, [id]: { ...row, ...patch } } }));
}

export function resetZaicodeNotifySettings(): void {
  write(defaultZaicodeNotifySettings());
}

export function useZaicodeNotifySettings(): ZaicodeNotifySettings {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(CHANGE_EVENT, listener);
      return () => window.removeEventListener(CHANGE_EVENT, listener);
    },
    readZaicodeNotifySettings,
    readZaicodeNotifySettings,
  );
}

export function zaicodeNotifyScenario(id: string): ZaicodeNotifyScenarioDef | undefined {
  return SCENARIO_BY_ID.get(id);
}

/** Inside quiet hours at `date`? */
export function isZaicodeQuietTime(settings: Pick<ZaicodeNotifySettings, "quietEnabled" | "quietFrom" | "quietTo">, date: Date): boolean {
  if (!settings.quietEnabled || settings.quietFrom === settings.quietTo) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  if (settings.quietFrom < settings.quietTo) return minute >= settings.quietFrom && minute < settings.quietTo;
  return minute >= settings.quietFrom || minute < settings.quietTo;
}

/** Sounds ask this before playing: quiet hours with "also mute sounds". */
export function isZaicodeSoundQuietNow(date: Date = new Date()): boolean {
  const settings = readZaicodeNotifySettings();
  return settings.quietSounds && isZaicodeQuietTime(settings, date);
}

// ---------------------------------------------------------------------------
// Cards on screen
// ---------------------------------------------------------------------------

export interface ZaicodeToastAction {
  label: string;
  run: () => void;
  /** Keep the card open after the action (e.g. a counter). */
  keepOpen?: boolean;
}

export interface ZaicodeToast {
  id: number;
  scenario: string;
  /** Small caption in the card's title bar ("Limits · Claude 1"). */
  header: string;
  title: string;
  body: string;
  /** Short state line in the accent colour ("Refilled", "Time's up"). */
  status: string;
  accent: string;
  createdAt: number;
  /** Epoch ms, or null = until dismissed. */
  expiresAt: number | null;
  actions: ZaicodeToastAction[];
  /** Same key replaces the older card instead of stacking. */
  key?: string;
}

interface ZaicodeToastState {
  toasts: ZaicodeToast[];
  dismiss: (id: number) => void;
  dismissAll: () => void;
}

export const useZaicodeToasts = create<ZaicodeToastState>((set) => ({
  toasts: [],
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  dismissAll: () => set({ toasts: [] }),
}));

let nextToastId = 1;

const GROUP_ACCENT: Record<ZaicodeNotifyGroup, string> = {
  Agents: "#d9b340",
  Limits: "#7cc850",
  Workers: "#58a6d8",
  Timers: "#e08a3c",
  Other: "#b8a878",
};

export interface ZaicodeNotifyInput {
  title: string;
  body?: string;
  header?: string;
  status?: string;
  accent?: string;
  actions?: ZaicodeToastAction[];
  key?: string;
  /** Fresh-mark keys to glow (e.g. `engine:<account>`, `window:<account>|<window>`). */
  highlight?: readonly string[];
  /** Label shown on the glowing element ("refilled", "5h window reset"). */
  highlightLabel?: string;
  /** Overrides the scenario's card length (seconds, 0 = sticky). */
  seconds?: number;
  /** Per highlight key: the quota % at the moment it glowed, for the "ends when used" rule. */
  highlightPeaks?: Readonly<Record<string, number>>;
}

/** A glow without the time rule still ends within a day. */
export const ZAICODE_GLOW_UNTIMED_MINUTES = 24 * 60;

interface ZaicodeNotifyBridge {
  showZaicodeNotification?(input: { title: string; body?: string }): Promise<{ ok: boolean; message: string }>;
}

/**
 * A Windows notification: the desktop app's native one (main process, a
 * click brings ZAICODE forward), else the browser's. `always` also shows it
 * while ZAICODE is the active window.
 */
export function showZaicodeSystemNotification(title: string, body: string, always: boolean): void {
  try {
    if (typeof document !== "undefined" && document.hasFocus() && !always) return;
    const bridge = typeof window === "undefined" ? undefined : (window as unknown as { zcode?: ZaicodeNotifyBridge }).zcode;
    if (bridge?.showZaicodeNotification) {
      void bridge.showZaicodeNotification({ title, body }).catch(() => undefined);
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    // silent: the Sounds table already plays the scenario's sound once.
    new Notification(title, { body, silent: true });
  } catch {
    // a notification never breaks the action that caused it
  }
}

/**
 * Shows `scenario` as configured. Returns the card id (or null when no card
 * was shown). Highlights are applied even in quiet hours: they are silent.
 */
export function notifyZaicode(scenario: string, input: ZaicodeNotifyInput, now: number = Date.now()): number | null {
  // SAIHOME's timeline records the event itself, whatever the card settings say (T-56).
  recordZaicodeHomeEvent(scenario, input.title, input.body ?? "", now);
  const def = SCENARIO_BY_ID.get(scenario);
  const settings = readZaicodeNotifySettings();
  const row = settings.scenarios[scenario] ?? def?.defaults;
  if (!row) return null;
  if (row.highlight && input.highlight?.length && row.highlightMinutes > 0) {
    // Without the time rule a glow lasts until another rule ends it (capped at a day).
    const minutes = settings.glow.timed ? row.highlightMinutes : ZAICODE_GLOW_UNTIMED_MINUTES;
    markZaicodeFresh(input.highlight, minutes, input.highlightLabel ?? input.status ?? input.title, now, input.highlightPeaks);
  }
  if (!settings.enabled || isZaicodeQuietTime(settings, new Date(now))) return null;
  const channels = zaicodeNotifyChannels(settings, row);
  if (channels.system) {
    showZaicodeSystemNotification(input.title, input.body ?? "", settings.systemWhenFocused || settings.delivery === "windows");
  }
  if (!channels.toast) return null;
  const seconds = input.seconds ?? row.seconds;
  const toast: ZaicodeToast = {
    id: nextToastId++,
    scenario,
    header: input.header ?? def?.group ?? "ZAICODE",
    title: input.title,
    body: input.body ?? "",
    status: input.status ?? def?.label ?? "",
    accent: input.accent ?? GROUP_ACCENT[def?.group ?? "Other"],
    createdAt: now,
    expiresAt: seconds > 0 ? now + seconds * 1000 : null,
    actions: input.actions ?? [],
    ...(input.key ? { key: input.key } : {}),
  };
  useZaicodeToasts.setState((state) => ({
    toasts: [...state.toasts.filter((item) => !toast.key || item.key !== toast.key), toast],
  }));
  return toast.id;
}

// ---------------------------------------------------------------------------
// Fresh marks: "this just refilled" glow on meters and tiles
// ---------------------------------------------------------------------------

export interface ZaicodeFreshMark {
  since: number;
  until: number;
  label: string;
  /** Quota % when it started to glow (refills): a drop below it means it is in use. */
  peak?: number;
}

const FRESH_EVENT = "zaicode-fresh-changed";
let fresh = new Map<string, ZaicodeFreshMark>();
let freshVersion = 0;
let freshTimer: number | null = null;

function scheduleFreshSweep(): void {
  if (typeof window === "undefined") return;
  if (freshTimer !== null) window.clearTimeout(freshTimer);
  const next = Math.min(...[...fresh.values()].map((mark) => mark.until));
  if (!Number.isFinite(next)) return;
  freshTimer = window.setTimeout(() => {
    const now = Date.now();
    const kept = new Map([...fresh].filter(([, mark]) => mark.until > now));
    if (kept.size !== fresh.size) {
      fresh = kept;
      freshVersion += 1;
      window.dispatchEvent(new Event(FRESH_EVENT));
    }
    scheduleFreshSweep();
  }, Math.max(1000, next - Date.now()));
}

export function markZaicodeFresh(
  keys: readonly string[],
  minutes: number,
  label: string,
  now: number = Date.now(),
  peaks?: Readonly<Record<string, number>>,
): void {
  if (minutes <= 0 || keys.length === 0) return;
  const next = new Map(fresh);
  for (const key of keys) {
    const peak = peaks?.[key];
    next.set(key, { since: now, until: now + minutes * 60_000, label, ...(typeof peak === "number" ? { peak } : {}) });
  }
  fresh = next;
  freshVersion += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FRESH_EVENT));
  scheduleFreshSweep();
}

/** Ends glows now (seen, acknowledged, in use). */
export function dismissZaicodeFresh(keys: readonly string[]): void {
  const present = keys.filter((key) => fresh.has(key));
  if (present.length === 0) return;
  const next = new Map(fresh);
  for (const key of present) next.delete(key);
  fresh = next;
  freshVersion += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FRESH_EVENT));
  scheduleFreshSweep();
}

/** Every live glow (key -> mark), for rules that sweep them. */
export function listZaicodeFresh(now: number = Date.now()): [string, ZaicodeFreshMark][] {
  return [...fresh].filter(([, mark]) => mark.until > now);
}

export function readZaicodeFresh(key: string, now: number = Date.now()): ZaicodeFreshMark | null {
  const mark = fresh.get(key);
  return mark && mark.until > now ? mark : null;
}

/** Re-renders when any fresh mark appears or expires (for lists that read many keys). */
export function useZaicodeFreshVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(FRESH_EVENT, listener);
      return () => window.removeEventListener(FRESH_EVENT, listener);
    },
    () => freshVersion,
    () => freshVersion,
  );
}

/** Re-renders when any fresh mark appears or expires; returns the mark for `key`. */
export function useZaicodeFresh(key: string): ZaicodeFreshMark | null {
  useZaicodeFreshVersion();
  return readZaicodeFresh(key);
}

export function describeZaicodeFreshAge(mark: ZaicodeFreshMark, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - mark.since) / 60_000));
  return `${mark.label} ${minutes <= 0 ? "just now" : `${minutes} min ago`}`;
}
