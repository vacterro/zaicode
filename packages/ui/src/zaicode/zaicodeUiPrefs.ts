import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import {
  ZAICODE_SIDE_PANE_VISIBILITY_DEFAULT,
  normalizeZaicodeSidePaneVisibility,
  type ZaicodeSidePaneVisibilityPrefs,
} from "./zaicodeSidePaneVisibility.js";

/**
 * ZAICODE interface preferences that are not layout or audio: the home
 * screen greeting and "Empty" marker, the SAIMAIL envelope, and automatic
 * retry after a failed model turn. Renderer-local (per machine), applied live.
 */

/** Whatever the settings say, an automatic retry gives up after this many attempts (SRC-082). */
export const ZAICODE_AUTO_RETRY_HARD_CAP = 8;
/** What the "Give up after" setting starts from. */
export const ZAICODE_AUTO_RETRY_DEFAULT_ATTEMPTS = 5;

export type ZaicodeGreetingMode = "time" | "custom";
export type ZaicodeSaimailClick = "brief" | "settings" | "reader";
/** CLEAR: empty this session in place (default) or open a new empty one. */
export type ZaicodeClearMode = "session" | "new";
/**
 * SRC-113: how much of the interface is on screen at once. `compact` honours
 * each entry's own `when` (only while working, only while idle, only on
 * hover); `full` draws every ticked button and line, so nothing the operator
 * configured stays hidden behind a condition they have to rediscover.
 */
export type ZaicodeActionView = "compact" | "full";
/**
 * SRC-135: who the auto-retry switch governs. `project` = only the project/session the
 * composer it sits in; `global` = every ZAICODE session and project at once.
 */
export type ZaicodeAutoRetryScope = "session" | "project" | "global";

export interface ZaicodeUiPrefs {
  // Home (empty draft) screen
  showGreeting: boolean;
  greetingMode: ZaicodeGreetingMode;
  /** Custom greeting; `{name}` = active profile name, `{time}` = the time-of-day greeting. */
  greetingText: string;
  /** Show the greeting only from this hour (0..23) ... */
  greetingFromHour: number;
  /** ... until this hour (1..24, exclusive). 0..24 = always. */
  greetingToHour: number;
  showEmptyMarker: boolean;
  // SAIMAIL envelope (right-click it for these)
  saimailOnHome: boolean;
  saimailHomeShowEmpty: boolean;
  saimailShowCount: boolean;
  saimailUnreadRing: boolean;
  saimailHoverPreview: boolean;
  saimailPreviewRows: number;
  saimailClick: ZaicodeSaimailClick;
  // Auto-retry after a failed turn ("the model returned no content", provider errors, ...)
  autoRetry: boolean;
  autoRetryIntervalSec: number;
  autoRetryMaxAttempts: number;
  /**
   * SRC-135: whether the composer switch governs this project/session only or every
   * ZAICODE session at once. "global" keeps the single switch that always existed;
   * "project" is the one the operator asked for when a long handoff must not make
   * every other workspace retry behind their back.
   */
  autoRetryScope: ZaicodeAutoRetryScope;
  /** Effective overrides always apply; scope selects which preference the control edits. */
  autoRetryProjects: Record<string, boolean>;
  autoRetrySessions: Record<string, boolean>;
  /**
   * SRC-132: accounts the operator Ctrl+Clicked off the Scheduler's route list.
   * Only the Scheduler reads this -- the account itself stays usable by hand.
   */
  schedulerIneligible: Record<string, boolean>;
  /**
   * Auto-continue after a crash (SRC-044): sessions the dead process left
   * "running" in tasks-index, and goals that were still active, continue by
   * themselves once ZAICODE is back.
   */
  resumeAfterCrash: boolean;
  /** Only sessions cut off within this many hours are continued automatically. */
  resumeAfterCrashHours: number;
  /** Workers (subscription CLIs) that ran when ZAICODE died start again in the same project. */
  relaunchWorkersAfterCrash: boolean;
  clearMode: ZaicodeClearMode;
  /**
   * SRC-113: Compact keeps the conditional buttons and lines conditional; Full
   * shows all of them at once.
   */
  actionView: ZaicodeActionView;
  /**
   * SRC-151:R011: right-click a control that owns settings. `true` opens that
   * control's own settings panel; `false` leaves right-click to the app menu
   * for that control. Default true everywhere, so the rule the user asked for
   * is what happens without anyone visiting a setting first.
   */
  rightClickSettings: Record<string, boolean>;
  /**
   * T-224 / SRC-154:R003: how the right SAIPEN/task side pane (Ctrl+Alt+B)
   * remembers visibility - one answer everywhere, or one per project/session.
   * Persisted with the rest of the UI prefs, never only in memory.
   */
  sidePaneVisibility: ZaicodeSidePaneVisibilityPrefs;
  // Calm interface: less visual noise, nothing moves
  /** No animations or transitions anywhere (fades, slides, spinners). */
  noMotion: boolean;
  /** No dimmed backdrops, blur or see-through panels. */
  noDim: boolean;
  /** No pop-ups on hover (tooltips, hover cards, hover previews). */
  noHoverPopups: boolean;
  /**
   * Home-screen defaults revision. 2 (T-36): the "Empty" marker and the
   * empty SAIMAIL line are off by default; older stored prefs had them on
   * only because every save wrote the old defaults, so they move once.
   */
  homeRev: number;
  /**
   * SAIMAIL click revision. 1 (T-133): the envelope opens and reads letters itself since T-115 (SRC-079: "open the
   * mail right in the widget"). Prefs stored before that held "brief" (the old default, written by every save) or
   * "settings" -- the bundled release defaults carried "settings" -- so a click kept opening Settings instead of the
   * letters. Those move to "reader" once; a choice made after that sticks.
   */
  saimailRev: number;
}

const HOME_REV = 2;
const SAIMAIL_REV = 1;

export const ZAICODE_UI_DEFAULT_PREFS: ZaicodeUiPrefs = {
  showGreeting: true,
  greetingMode: "time",
  greetingText: "{time}, {name}",
  greetingFromHour: 0,
  greetingToHour: 24,
  showEmptyMarker: false,
  saimailOnHome: true,
  saimailHomeShowEmpty: false,
  saimailShowCount: true,
  saimailUnreadRing: true,
  saimailHoverPreview: true,
  saimailPreviewRows: 8,
  saimailClick: "reader",
  autoRetry: true,
  autoRetryIntervalSec: 60,
  autoRetryMaxAttempts: ZAICODE_AUTO_RETRY_DEFAULT_ATTEMPTS,
  autoRetryScope: "global",
  autoRetryProjects: {},
  autoRetrySessions: {},
  schedulerIneligible: {},
  resumeAfterCrash: true,
  resumeAfterCrashHours: 12,
  relaunchWorkersAfterCrash: true,
  clearMode: "session",
  actionView: "compact",
  rightClickSettings: {},
  sidePaneVisibility: { ...ZAICODE_SIDE_PANE_VISIBILITY_DEFAULT },
  noMotion: false,
  noDim: false,
  noHoverPopups: false,
  homeRev: HOME_REV,
  saimailRev: SAIMAIL_REV,
};

const STORAGE_KEY = "zaicode-ui-prefs-v1";
/** Fresh REQ-001: persistence verification reads the same key the store writes. */
export const ZAICODE_UI_PREFS_STORAGE_KEY = STORAGE_KEY;

function int(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** Keep only real boolean answers under string keys; the per-project map is user-writable. */
function flags(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [key, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on === "boolean") out[key] = on;
  }
  return out;
}

export function normalizeZaicodeUiPrefs(raw: unknown): ZaicodeUiPrefs {
  const d = ZAICODE_UI_DEFAULT_PREFS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeUiPrefs, unknown>>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const from = int(r.greetingFromHour, 0, 23, d.greetingFromHour);
  const to = int(r.greetingToHour, 1, 24, d.greetingToHour);
  const homeCurrent = typeof r.homeRev === "number" && r.homeRev >= HOME_REV;
  const saimailCurrent = typeof r.saimailRev === "number" && r.saimailRev >= SAIMAIL_REV;
  return {
    showGreeting: flag(r.showGreeting, d.showGreeting),
    greetingMode: r.greetingMode === "custom" ? "custom" : "time",
    greetingText:
      typeof r.greetingText === "string" ? r.greetingText.slice(0, 200) : d.greetingText,
    greetingFromHour: from,
    greetingToHour: to,
    showEmptyMarker: homeCurrent ? flag(r.showEmptyMarker, d.showEmptyMarker) : d.showEmptyMarker,
    saimailOnHome: flag(r.saimailOnHome, d.saimailOnHome),
    saimailHomeShowEmpty: homeCurrent ? flag(r.saimailHomeShowEmpty, d.saimailHomeShowEmpty) : d.saimailHomeShowEmpty,
    saimailShowCount: flag(r.saimailShowCount, d.saimailShowCount),
    saimailUnreadRing: flag(r.saimailUnreadRing, d.saimailUnreadRing),
    saimailHoverPreview: flag(r.saimailHoverPreview, d.saimailHoverPreview),
    saimailPreviewRows: int(r.saimailPreviewRows, 1, 30, d.saimailPreviewRows),
    saimailClick:
      saimailCurrent && ["brief", "settings", "reader"].includes(String(r.saimailClick))
        ? (r.saimailClick as ZaicodeSaimailClick)
        : d.saimailClick,
    autoRetry: flag(r.autoRetry, d.autoRetry),
    autoRetryIntervalSec: int(r.autoRetryIntervalSec, 10, 3600, d.autoRetryIntervalSec),
    autoRetryMaxAttempts: int(r.autoRetryMaxAttempts, 1, ZAICODE_AUTO_RETRY_HARD_CAP, d.autoRetryMaxAttempts),
    autoRetryScope: r.autoRetryScope === "session" ? "session" : r.autoRetryScope === "project" ? "project" : "global",
    autoRetryProjects: flags(r.autoRetryProjects),
    autoRetrySessions: flags(r.autoRetrySessions),
    schedulerIneligible: flags(r.schedulerIneligible),
    resumeAfterCrash: flag(r.resumeAfterCrash, d.resumeAfterCrash),
    resumeAfterCrashHours: int(r.resumeAfterCrashHours, 1, 168, d.resumeAfterCrashHours),
    relaunchWorkersAfterCrash: flag(r.relaunchWorkersAfterCrash, d.relaunchWorkersAfterCrash),
    clearMode: r.clearMode === "new" ? "new" : "session",
    actionView: r.actionView === "full" ? "full" : "compact",
    rightClickSettings: flags(r.rightClickSettings),
    sidePaneVisibility: normalizeZaicodeSidePaneVisibility(r.sidePaneVisibility),
    noMotion: flag(r.noMotion, d.noMotion),
    noDim: flag(r.noDim, d.noDim),
    noHoverPopups: flag(r.noHoverPopups, d.noHoverPopups),
    homeRev: HOME_REV,
    saimailRev: SAIMAIL_REV,
  };
}

function load(): ZaicodeUiPrefs {
  try {
    return normalizeZaicodeUiPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeUiPrefs(null);
  }
}

interface ZaicodeUiPrefsState extends ZaicodeUiPrefs {
  update: (patch: Partial<ZaicodeUiPrefs>) => void;
}

export const useZaicodeUiPrefs = create<ZaicodeUiPrefsState>((set, get) => ({
  ...load(),
  update: (patch) => {
    const current = get();
    const next = normalizeZaicodeUiPrefs({ ...current, ...patch });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Preference only; the in-memory copy still applies.
    }
    set(next);
  },
}));

/** Whether the greeting shows at `hour` (0..23) for a [from, to) window; from >= to wraps midnight. */
export function isZaicodeGreetingHour(hour: number, from: number, to: number): boolean {
  if (from === 0 && to === 24) return true;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/** Fills `{name}` and `{time}` in a custom greeting. */
export function formatZaicodeGreeting(template: string, values: { name: string; time: string }): string {
  return template.replace(/\{name\}/g, values.name).replace(/\{time\}/g, values.time).trim();
}

/** The <html> classes the calm-interface switches map to (CSS in zaicodePalettes.ts). */
export function zaicodeCalmClasses(prefs: Pick<ZaicodeUiPrefs, "noMotion" | "noDim" | "noHoverPopups">): Record<string, boolean> {
  return {
    "zaicode-no-motion": prefs.noMotion,
    "zaicode-no-dim": prefs.noDim,
    "zaicode-no-popups": prefs.noHoverPopups,
  };
}

/** One switch for all three (the hotkey and the master checkbox). */
export function isZaicodeCalm(prefs: Pick<ZaicodeUiPrefs, "noMotion" | "noDim" | "noHoverPopups">): boolean {
  return prefs.noMotion && prefs.noDim && prefs.noHoverPopups;
}

/** Live preset apply (T-208): take the stored UI prefs without reloading the window. */
export function reloadZaicodeUiPrefs(): void {
  useZaicodeUiPrefs.setState(load());
}

// ------------------------------------------------------------------ SRC-135 scope

/**
 * 编辑范围不改变继承规则；当前会话 > 项目 > 全局，不能把全局 ON 冒充有效 ON。
 */
export function zaicodeAutoRetryEnabled(
  prefs: Pick<ZaicodeUiPrefs, "autoRetry" | "autoRetryScope" | "autoRetryProjects"> & Partial<Pick<ZaicodeUiPrefs, "autoRetrySessions">>,
  projectKey: string,
  sessionId?: string | null,
): boolean {
  const session = sessionId ? prefs.autoRetrySessions?.[sessionId] : undefined;
  if (session !== undefined) return session;
  const own = prefs.autoRetryProjects[projectKey];
  return own === undefined ? prefs.autoRetry : own;
}

/** The patch the composer switch writes: a per-project answer, or the one global flag. */
export function zaicodeAutoRetryPatch(
  prefs: Pick<ZaicodeUiPrefs, "autoRetry" | "autoRetryScope" | "autoRetryProjects"> & Partial<Pick<ZaicodeUiPrefs, "autoRetrySessions">>,
  projectKey: string,
  next: boolean,
  sessionId?: string | null,
): Partial<ZaicodeUiPrefs> {
  if (prefs.autoRetryScope === "global") return { autoRetry: next };
  if (prefs.autoRetryScope === "session") return sessionId ? { autoRetrySessions: { ...prefs.autoRetrySessions, [sessionId]: next } } : {};
  return { autoRetryProjects: { ...prefs.autoRetryProjects, [projectKey]: next } };
}

/**
 * Fresh REQ-001: the scope that actually decides the effective answer.
 * session override > project override > global. The primary control must
 * write here, never to an unrelated editing scope.
 */
export function zaicodeAutoRetryEffectiveScope(
  prefs: Pick<ZaicodeUiPrefs, "autoRetryProjects"> & Partial<Pick<ZaicodeUiPrefs, "autoRetrySessions">>,
  projectKey: string,
  sessionId?: string | null,
): "session" | "project" | "global" {
  if (sessionId && prefs.autoRetrySessions?.[sessionId] !== undefined) return "session";
  if (prefs.autoRetryProjects[projectKey] !== undefined) return "project";
  return "global";
}

/**
 * Fresh REQ-001: the patch the primary switch writes. Click OFF always turns
 * the effective answer ON and vice versa, because it edits the scope that
 * currently owns the effective value instead of a hidden editing scope.
 */
export function zaicodeAutoRetryEffectivePatch(
  prefs: Pick<ZaicodeUiPrefs, "autoRetry" | "autoRetryProjects"> & Partial<Pick<ZaicodeUiPrefs, "autoRetrySessions">>,
  projectKey: string,
  next: boolean,
  sessionId?: string | null,
): Partial<ZaicodeUiPrefs> {
  const scope = zaicodeAutoRetryEffectiveScope(prefs, projectKey, sessionId);
  if (scope === "session" && sessionId) return { autoRetrySessions: { ...prefs.autoRetrySessions, [sessionId]: next } };
  if (scope === "project") return { autoRetryProjects: { ...prefs.autoRetryProjects, [projectKey]: next } };
  return { autoRetry: next };
}

/**
 * Fresh REQ-001: explicit effective-scope label. Inheritance is spelled out
 * so the UI never shows a bare "Global default" while a hidden project or
 * session override controls the actual behavior.
 */
export function zaicodeAutoRetryEffectiveLabel(
  prefs: Pick<ZaicodeUiPrefs, "autoRetry" | "autoRetryProjects"> & Partial<Pick<ZaicodeUiPrefs, "autoRetrySessions">>,
  projectKey: string,
  sessionId?: string | null,
): string {
  const scope = zaicodeAutoRetryEffectiveScope(prefs, projectKey, sessionId);
  if (scope === "session") return "This session";
  if (scope === "project") return "This project";
  return prefs.autoRetry ? "Inherited: Global ON" : "Inherited: Global OFF";
}

/** The other scope, for the small switch beside the main toggle. */
export function zaicodeAutoRetryScopeNext(scope: ZaicodeAutoRetryScope): ZaicodeAutoRetryScope {
  return scope === "global" ? "project" : scope === "project" ? "session" : "global";
}

/** What the scope switch says; the tooltip spells out what each mode covers. */
export function zaicodeAutoRetryScopeLabel(scope: ZaicodeAutoRetryScope): string {
  return scope === "global" ? "Global default" : scope === "project" ? "This project" : "This session";
}

/**
 * SRC-151:R011 — the controls that own a settings panel and therefore answer to
 * a right-click. Named here so the rule has one list, not one string literal
 * per call site.
 */
export const ZAICODE_RIGHT_CLICK_CONTROLS = Object.freeze({
  /** Title bar: back / forward / search / new task / settings. */
  header: "Header buttons",
  /** The message box strip's compact button. */
  composer: "Message box parts",
  /** Title bar limit meters. */
  meter: "Limit meters",
  /** Sidebar Compact / Full. */
  actionView: "Compact / Full",
  /** Sidebar nav block. */
  sidebarNav: "Sidebar",
  /** SAIMAIL envelope. */
  saimail: "SAIMAIL envelope",
  /** Title bar clock. */
  clock: "Clock",
  /** Footer tools. */
  footer: "Footer tools",
  /** Title bar project title. */
  projectTitle: "Project title",
  /** Per-session action strip. */
  sessionActions: "Session actions",
  /** Auto retry button by the composer. */
  retry: "Auto retry",
  /** Engine/model row. */
  engines: "Engines",
  /** The composer's model buttons. */
  modelButtons: "Model buttons",
  /** The empty new-task screen. */
  greeting: "New task screen",
  /** Sidebar section headers. */
  sidebarSections: "Sidebar sections",
} as const);

export type ZaicodeRightClickPrefKey = keyof typeof ZAICODE_RIGHT_CLICK_CONTROLS;

/**
 * A right-click on a registered control always opens its settings (SRC-162). The per-control
 * "app menu" choice is gone: buttons own no menu in the packaged app, so it only ever killed the
 * right button. `rightClickSettings` stays readable so an old prefs file still loads.
 */
export function rightClickOpensSettings(
  _prefs: Pick<ZaicodeUiPrefs, "rightClickSettings">,
  _key: ZaicodeRightClickPrefKey | undefined,
): boolean {
  return true;
}
