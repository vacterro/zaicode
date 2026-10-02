/* eslint-disable max-lines -- one owner module: every sidebar block's prefs, their normalize and the section ordering change together when the sidebar changes. */
import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  getTaskListAttention,
  getTaskListRowActivity,
  isTaskListRowActive,
} from "../v4/taskListRowActivity.js";
import { todoReadinessRatio, type ZaicodeTodoItem } from "./zaicodeTodoProgress.js";
import { zaicodeRunClock, type ZaicodeRunClock } from "./zaicodeRunClock.js";
import { zaicodeSessionWorking } from "./zaicodeStall.js";

/**
 * ZAICODE sidebar layout preferences (renderer-local, per machine).
 *
 * - navOpen:   the New task / Search / Automations / Plugins / ZAICODE block;
 *              hidden by default, toggled from the sidebar header.
 * - slots:     AUDAPACK-style priority groups MAIN0..SIDE3 for projects.
 *              Right-click SLOTS in the Projects header for every slot option.
 * - liveFirst: projects with a running session float up (LIVE). Right-click
 *              LIVE for its order, scope and indicators.
 * - compact:   tight rows, no empty vertical padding.
 * - projectIsMain: the third list view (default, SRC-044): a project row IS
 *              its MAIN session -- clicking it opens MAIN, MAIN is not listed
 *              again under it, and the sessions below are its helpers.
 */
export const ZAICODE_SLOT_GROUPS = ["MAIN0", "MAIN1", "SIDE0", "SIDE1", "SIDE2", "SIDE3"] as const;
export type ZaicodeSlotGroup = (typeof ZAICODE_SLOT_GROUPS)[number];
export const ZAICODE_DEFAULT_SLOT_GROUP: ZaicodeSlotGroup = "MAIN0";

export type ZaicodeSlotLabelAlign = "left" | "center" | "right";
/** Order of LIVE projects: most recently active first, closest to done, or least done. */
export type ZaicodeLiveOrder = "recent" | "closest" | "furthest";
/** LIVE projects float to the top of their own slot, or into one LIVE group above every slot. */
export type ZaicodeLiveScope = "slot" | "global";
/**
 * How long a project stays LIVE-ranked after its last live moment (SRC-051):
 * a task that just finished or failed must not teleport back down mid-glance.
 */
export const ZAICODE_LIVE_HOLD_MS: readonly number[] = [0, 30_000, 120_000, 600_000, 3_600_000];

/** Project freshness read-out (SRC-051): nothing, a leading dot, or a tint of the label. */
export type ZaicodeProjectFreshness = "off" | "dot" | "tint";
export const ZAICODE_PROJECT_FRESHNESS: readonly ZaicodeProjectFreshness[] = ["off", "dot", "tint"];

export type ZaicodeProjectTitleFont = "ui" | "verdana" | "terminus" | "consolas";
export const ZAICODE_PROJECT_TITLE_FONTS: readonly ZaicodeProjectTitleFont[] = [
  "ui",
  "verdana",
  "terminus",
  "consolas",
];

export function zaicodeProjectTitleFontFamily(font: ZaicodeProjectTitleFont): string | undefined {
  if (font === "verdana") return "Verdana, sans-serif";
  if (font === "terminus") return '"Terminus (TTF) for Windows", "ZAICODE Terminus", monospace';
  if (font === "consolas") return "Consolas, monospace";
  return undefined;
}

export type ZaicodeFreshnessBucket = "fresh" | "today" | "week" | "stale" | "none";

const ZAICODE_FRESHNESS_MS: Readonly<Record<"fresh" | "today" | "week", number>> = {
  fresh: 15 * 60_000,
  today: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
};

/** Age bucket of a project's last activity; "none" when nothing was ever seen. */
export function zaicodeFreshnessBucket(
  lastActivityAt: number,
  now: number,
): ZaicodeFreshnessBucket {
  if (!lastActivityAt) return "none";
  const age = now - lastActivityAt;
  if (age <= ZAICODE_FRESHNESS_MS.fresh) return "fresh";
  if (age <= ZAICODE_FRESHNESS_MS.today) return "today";
  if (age <= ZAICODE_FRESHNESS_MS.week) return "week";
  return "stale";
}

/** Win95-dark palette ties (UI.md): brighter = fresher; stale fades into the border colour. */
export const ZAICODE_FRESHNESS_COLORS: Readonly<Record<ZaicodeFreshnessBucket, string>> = {
  fresh: "var(--color-success)",
  today: "var(--color-primary)",
  week: "var(--color-warning)",
  stale: "var(--color-border)",
  none: "var(--color-border)",
};

export interface ZaicodeSidebarPrefs {
  sidebarsSwapped: boolean;
  navOpen: boolean;
  /** Project view where the project row stands for its MAIN session (SRC-044). */
  projectIsMain: boolean;
  slots: boolean;
  liveFirst: boolean;
  compact: boolean;
  /** workspace key -> priority group; missing keys sit in `defaultSlot`. */
  groups: Record<string, ZaicodeSlotGroup>;
  // SLOTS options
  slotLabelAlign: ZaicodeSlotLabelAlign;
  hideEmptySlots: boolean;
  showSlotCounts: boolean;
  tintMainSlots: boolean;
  /** Ctrl+click on a project moves it here (default SIDE2, "send it down"). */
  ctrlClickSlot: ZaicodeSlotGroup;
  /** Where projects without an explicit slot live. */
  defaultSlot: ZaicodeSlotGroup;
  /** Slots folded to their header line (click the header to toggle). */
  collapsedSlots: ZaicodeSlotGroup[];
  // LIVE options
  liveOrder: ZaicodeLiveOrder;
  liveScope: ZaicodeLiveScope;
  /** Projects with a session waiting for you (question / permission) count as LIVE and come first. */
  liveIncludeWaiting: boolean;
  /** Spinning working icon + running count on the project row. */
  liveProjectIndicator: boolean;
  /** Dim projects with nothing running while LIVE is on. */
  liveDimIdle: boolean;
  /** A project stays LIVE-ranked this long after its last live moment (0 = drop at once). */
  liveHoldMs: number;
  /**
   * SRC-060: a project that has gone live keeps its LIVE rank instead of
   * dropping back to its manual place when the work finishes. Bounded by the
   * project count, so "LIVE" then simply means "leave it where it is".
   */
  liveRemainInPosition: boolean;
  /** Freshness read-out on the project row from its last activity (SRC-051). */
  projectFreshness: ZaicodeProjectFreshness;
  /** Where project names sit in their row (SRC-038). */
  projectTitleAlign: ZaicodeSlotLabelAlign;
  /** Project row state styling (SRC-055): ON and OFF stay distinguishable and operator-controlled. */
  projectTitleFont: ZaicodeProjectTitleFont;
  projectTitleSize: number;
  projectTitleBold: boolean;
  projectTitleUnderline: boolean;
  projectOnColor: string;
  projectOffColor: string;
  projectOnOpacity: number;
  projectOffOpacity: number;
  /** Where session titles sit in their row. */
  sessionTitleAlign: ZaicodeSlotLabelAlign;
  // T-65 (SRC-049): one Settings > Sidebar section owns everything below.
  /** Sidebar text size in whole pixels (bitmap-font strikes stay crisp). */
  textSize: ZaicodeSidebarTextSize;
  /** Icon scale for every icon in the sidebar (relative to the row text). */
  iconSize: ZaicodeSidebarIconSize;
  /** Accent colour per slot header ("LIVE" included); missing = theme colour. */
  slotColors: Partial<Record<ZaicodeSlotGroup | "LIVE", string>>;
  /** When session rows are listed under a project. */
  sessionsCondition: ZaicodeSessionsCondition;
}

export type ZaicodeSidebarTextSize = 11 | 12 | 13 | 14;
export type ZaicodeSidebarIconSize = "small" | "normal" | "large";
export type ZaicodeSessionsCondition = "always" | "working" | "working-or-waiting";

export const ZAICODE_SIDEBAR_TEXT_SIZES: readonly ZaicodeSidebarTextSize[] = [11, 12, 13, 14];
export const ZAICODE_SIDEBAR_ICON_SIZES: readonly ZaicodeSidebarIconSize[] = [
  "small",
  "normal",
  "large",
];
export const ZAICODE_SESSIONS_CONDITIONS: readonly ZaicodeSessionsCondition[] = [
  "always",
  "working",
  "working-or-waiting",
];

/** A slot/side colour must be a hex colour; anything else falls back to the theme. */
export function normalizeZaicodeSidebarColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)
    ? value
    : undefined;
}

const STORAGE_KEY = "zaicode-sidebar-prefs-v1";
export const ZAICODE_SIDEBAR_DEFAULT_PREFS: ZaicodeSidebarPrefs = {
  sidebarsSwapped: false,
  navOpen: true,
  projectIsMain: true,
  slots: true,
  liveFirst: false,
  compact: true,
  groups: {},
  slotLabelAlign: "center",
  hideEmptySlots: false,
  showSlotCounts: true,
  tintMainSlots: true,
  ctrlClickSlot: "SIDE2",
  defaultSlot: ZAICODE_DEFAULT_SLOT_GROUP,
  collapsedSlots: [],
  liveOrder: "recent",
  liveScope: "slot",
  liveIncludeWaiting: true,
  liveProjectIndicator: true,
  liveDimIdle: false,
  liveHoldMs: 120_000,
  liveRemainInPosition: false,
  projectFreshness: "dot",
  projectTitleAlign: "left",
  projectTitleFont: "ui",
  projectTitleSize: 12,
  projectTitleBold: false,
  projectTitleUnderline: false,
  projectOnColor: "",
  projectOffColor: "#777777",
  projectOnOpacity: 100,
  projectOffOpacity: 55,
  sessionTitleAlign: "left",
  textSize: 12,
  iconSize: "normal",
  slotColors: {},
  sessionsCondition: "always",
};

export function isZaicodeSlotGroup(value: unknown): value is ZaicodeSlotGroup {
  return typeof value === "string" && (ZAICODE_SLOT_GROUPS as readonly string[]).includes(value);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Normalizes a stored (possibly older or hand-edited) preference object. */
export function normalizeZaicodeSidebarPrefs(raw: unknown): ZaicodeSidebarPrefs {
  const d = ZAICODE_SIDEBAR_DEFAULT_PREFS;
  if (!raw || typeof raw !== "object")
    return { ...d, groups: {}, collapsedSlots: [], slotColors: {} };
  const r = raw as Partial<Record<keyof ZaicodeSidebarPrefs, unknown>>;
  const groups: Record<string, ZaicodeSlotGroup> = {};
  if (r.groups && typeof r.groups === "object") {
    for (const [key, value] of Object.entries(r.groups as Record<string, unknown>)) {
      if (isZaicodeSlotGroup(value)) groups[key] = value;
    }
  }
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;
  return {
    sidebarsSwapped: flag(r.sidebarsSwapped, d.sidebarsSwapped),
    navOpen: flag(r.navOpen, d.navOpen),
    projectIsMain: flag(r.projectIsMain, d.projectIsMain),
    slots: flag(r.slots, d.slots),
    liveFirst: flag(r.liveFirst, d.liveFirst),
    compact: flag(r.compact, d.compact),
    groups,
    slotLabelAlign: pick(r.slotLabelAlign, ["left", "center", "right"] as const, d.slotLabelAlign),
    hideEmptySlots: flag(r.hideEmptySlots, d.hideEmptySlots),
    showSlotCounts: flag(r.showSlotCounts, d.showSlotCounts),
    tintMainSlots: flag(r.tintMainSlots, d.tintMainSlots),
    ctrlClickSlot: isZaicodeSlotGroup(r.ctrlClickSlot) ? r.ctrlClickSlot : d.ctrlClickSlot,
    defaultSlot: isZaicodeSlotGroup(r.defaultSlot) ? r.defaultSlot : d.defaultSlot,
    collapsedSlots: Array.isArray(r.collapsedSlots)
      ? [...new Set(r.collapsedSlots.filter(isZaicodeSlotGroup))]
      : [],
    liveOrder: pick(r.liveOrder, ["recent", "closest", "furthest"] as const, d.liveOrder),
    liveScope: pick(r.liveScope, ["slot", "global"] as const, d.liveScope),
    liveIncludeWaiting: flag(r.liveIncludeWaiting, d.liveIncludeWaiting),
    liveProjectIndicator: flag(r.liveProjectIndicator, d.liveProjectIndicator),
    liveDimIdle: flag(r.liveDimIdle, d.liveDimIdle),
    liveHoldMs: ZAICODE_LIVE_HOLD_MS.includes(r.liveHoldMs as number)
      ? (r.liveHoldMs as number)
      : d.liveHoldMs,
    liveRemainInPosition: flag(r.liveRemainInPosition, d.liveRemainInPosition),
    projectFreshness: pick(r.projectFreshness, ZAICODE_PROJECT_FRESHNESS, d.projectFreshness),
    projectTitleAlign: pick(
      r.projectTitleAlign,
      ["left", "center", "right"] as const,
      d.projectTitleAlign,
    ),
    projectTitleFont: pick(r.projectTitleFont, ZAICODE_PROJECT_TITLE_FONTS, d.projectTitleFont),
    projectTitleSize:
      typeof r.projectTitleSize === "number" && Number.isFinite(r.projectTitleSize)
        ? Math.min(18, Math.max(10, Math.round(r.projectTitleSize)))
        : d.projectTitleSize,
    projectTitleBold: flag(r.projectTitleBold, d.projectTitleBold),
    projectTitleUnderline: flag(r.projectTitleUnderline, d.projectTitleUnderline),
    projectOnColor: normalizeZaicodeSidebarColor(r.projectOnColor) ?? d.projectOnColor,
    projectOffColor: normalizeZaicodeSidebarColor(r.projectOffColor) ?? d.projectOffColor,
    projectOnOpacity:
      typeof r.projectOnOpacity === "number" && Number.isFinite(r.projectOnOpacity)
        ? Math.min(100, Math.max(20, Math.round(r.projectOnOpacity)))
        : d.projectOnOpacity,
    projectOffOpacity:
      typeof r.projectOffOpacity === "number" && Number.isFinite(r.projectOffOpacity)
        ? Math.min(100, Math.max(20, Math.round(r.projectOffOpacity)))
        : d.projectOffOpacity,
    sessionTitleAlign: pick(
      r.sessionTitleAlign,
      ["left", "center", "right"] as const,
      d.sessionTitleAlign,
    ),
    textSize: ZAICODE_SIDEBAR_TEXT_SIZES.includes(r.textSize as ZaicodeSidebarTextSize)
      ? (r.textSize as ZaicodeSidebarTextSize)
      : d.textSize,
    iconSize: pick(r.iconSize, ZAICODE_SIDEBAR_ICON_SIZES, d.iconSize),
    slotColors:
      r.slotColors && typeof r.slotColors === "object"
        ? Object.fromEntries(
            Object.entries(r.slotColors as Record<string, unknown>)
              .filter(
                ([key, value]) =>
                  (ZAICODE_SLOT_GROUPS as readonly string[]).includes(key) || key === "LIVE",
              )
              .map(([key, value]) => [key, normalizeZaicodeSidebarColor(value)])
              .filter((entry): entry is [string, string] => Boolean(entry[1])),
          )
        : {},
    sessionsCondition: pick(r.sessionsCondition, ZAICODE_SESSIONS_CONDITIONS, d.sessionsCondition),
  };
}

/** Publishes the title alignment as CSS variables (zaicodeMotionCss.ts reads them). */
function applyTitleAlign(
  prefs: Pick<ZaicodeSidebarPrefs, "projectTitleAlign" | "sessionTitleAlign">,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  root.setProperty("--zaicode-project-title-align", prefs.projectTitleAlign);
  root.setProperty("--zaicode-session-title-align", prefs.sessionTitleAlign);
}

function load(): ZaicodeSidebarPrefs {
  try {
    const raw = JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null");
    return migrateLiveOrderDefault(normalizeZaicodeSidebarPrefs(raw));
  } catch {
    return normalizeZaicodeSidebarPrefs(null);
  }
}

// SRC-051: "Live sorted by recently" — the order shipped as "closest" by
// default, so every stored profile carries it whether or not it was chosen.
// One-time migration to the new default ("recent"); an explicit later choice
// is never touched again.
const LIVE_ORDER_MIGRATION_KEY = "zaicode-sidebar-live-order-recent";
function migrateLiveOrderDefault(prefs: ZaicodeSidebarPrefs): ZaicodeSidebarPrefs {
  if (typeof localStorage === "undefined" || prefs.liveOrder !== "closest") return prefs;
  if (localStorage.getItem(LIVE_ORDER_MIGRATION_KEY) === "1") return prefs;
  try {
    localStorage.setItem(LIVE_ORDER_MIGRATION_KEY, "1");
  } catch {
    return prefs;
  }
  return { ...prefs, liveOrder: "recent" };
}

function save(prefs: ZaicodeSidebarPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Layout preference only; the in-memory copy still applies.
  }
}

interface ZaicodeSidebarPrefsState extends ZaicodeSidebarPrefs {
  update: (patch: Partial<Omit<ZaicodeSidebarPrefs, "groups">>) => void;
  setGroup: (workspaceKey: string, group: ZaicodeSlotGroup) => void;
  toggleSlotCollapsed: (group: ZaicodeSlotGroup) => void;
  resetGroups: () => void;
}

export const useZaicodeSidebarPrefs = create<ZaicodeSidebarPrefsState>((set, get) => {
  const snapshot = (): ZaicodeSidebarPrefs => {
    const state = get();
    const next = {} as Record<string, unknown>;
    for (const key of Object.keys(ZAICODE_SIDEBAR_DEFAULT_PREFS)) {
      next[key] = state[key as keyof ZaicodeSidebarPrefs];
    }
    return next as unknown as ZaicodeSidebarPrefs;
  };
  const persist = (patch: Partial<ZaicodeSidebarPrefs>) => {
    const next = normalizeZaicodeSidebarPrefs({ ...snapshot(), ...patch });
    save(next);
    set(next);
    applyTitleAlign(next);
  };
  const initial = load();
  applyTitleAlign(initial);
  return {
    ...initial,
    update: (patch) => persist(patch),
    setGroup: (workspaceKey, group) =>
      persist({ groups: { ...get().groups, [workspaceKey]: group } }),
    toggleSlotCollapsed: (group) => {
      playZaicodeSound("sidebar.collapse");
      const collapsed = get().collapsedSlots;
      persist({
        collapsedSlots: collapsed.includes(group)
          ? collapsed.filter((entry) => entry !== group)
          : [...collapsed, group],
      });
    },
    resetGroups: () => persist({ groups: {} }),
  };
});

export function slotGroupOf(
  groups: Readonly<Record<string, ZaicodeSlotGroup>>,
  workspaceKey: string,
  fallback: ZaicodeSlotGroup = ZAICODE_DEFAULT_SLOT_GROUP,
): ZaicodeSlotGroup {
  return groups[workspaceKey] ?? fallback;
}

/** Live state of one project, derived from its task list (sessions-index activity). */
export interface ZaicodeProjectLive {
  /** Sessions working right now. */
  running: number;
  /** Sessions waiting for the operator (question / permission). */
  waiting: number;
  /** Best todo readiness among running sessions, 0..1. */
  ratio: number;
  /**
   * Latest activity timestamp among ALL sessions (ms) — running, waiting and
   * finished alike (SRC-051): a task that just finished or failed is still the
   * most recent thing that happened, so LIVE-by-recency and the freshness dot
   * must not go blind the moment the phase leaves "running".
   */
  lastActivityAt: number;
  /**
   * When the longest-running working streak of this project began (ms; 0 = none).
   * SRC-058: from the run clock, never the session's createdAt.
   */
  since: number;
}

export function projectLiveOf(
  tasks: readonly ZCodeTaskMeta[],
  ratios: readonly number[],
  clock: ZaicodeRunClock = zaicodeRunClock,
  now: number = Date.now(),
): ZaicodeProjectLive {
  let running = 0;
  let waiting = 0;
  let lastActivityAt = 0;
  let since = 0;
  for (const task of tasks) {
    const active = isTaskListRowActive(task);
    const asking = getTaskListAttention(task) !== null || Boolean(task.pendingInteraction);
    // Every session is observed, working or not, so an idle one closes its streak.
    const streakSince = clock.observe(
      task.taskId,
      active,
      getTaskListRowActivity(task)?.lastActivityAt ?? task.updatedAt ?? 0,
      now,
    );
    if (active) running += 1;
    if (asking) waiting += 1;
    if (active || asking) {
      lastActivityAt = Math.max(
        lastActivityAt,
        getTaskListRowActivity(task)?.lastActivityAt ?? 0,
        task.updatedAt ?? 0,
      );
      if (streakSince > 0) since = since === 0 ? streakSince : Math.min(since, streakSince);
    } else {
      // Finished sessions keep the recency story alive: their final updatedAt is
      // the project's last seen moment.
      lastActivityAt = Math.max(lastActivityAt, task.updatedAt ?? 0);
    }
  }
  return {
    running,
    waiting,
    ratio: ratios.reduce((best, ratio) => Math.max(best, ratio), 0),
    lastActivityAt,
    since,
  };
}

export type ZaicodeProjectSectionGroup = ZaicodeSlotGroup | "LIVE";

/**
 * Orders project keys into sidebar sections. Pure: the sidebar passes keys in
 * their manual order plus each key's slot and live state.
 *
 * SRC-051: `now` + `liveHoldMs` keep a project LIVE-ranked for a grace period
 * after its last live moment, so a row does not dive back down the instant a
 * task completes or fails while the operator watches the list.
 */
export function orderZaicodeProjectSections<K extends string>(
  keys: readonly K[],
  options: {
    prefs: Pick<
      ZaicodeSidebarPrefs,
      | "slots"
      | "liveFirst"
      | "groups"
      | "defaultSlot"
      | "hideEmptySlots"
      | "liveOrder"
      | "liveScope"
      | "liveIncludeWaiting"
      | "liveHoldMs"
      | "liveRemainInPosition"
    >;
    liveOf: (key: K) => ZaicodeProjectLive | undefined;
    now?: number;
  },
): { group: ZaicodeProjectSectionGroup | null; keys: K[] }[] {
  const { prefs, liveOf } = options;
  const now = options.now ?? Date.now();
  const isLive = (key: K) => {
    const live = liveOf(key);
    if (!live) return false;
    if (live.running > 0 || (prefs.liveIncludeWaiting && live.waiting > 0)) return true;
    // SRC-060 "Remain in position": once a project has been live, the grace hold
    // never expires for it, so a finished project keeps its LIVE rank instead of
    // dropping back down the hierarchy. Bounded by the project count.
    if (prefs.liveRemainInPosition && live.lastActivityAt > 0) return true;
    // Grace hold: recently live stays live (0 disables).
    return (
      prefs.liveHoldMs > 0 &&
      live.lastActivityAt > 0 &&
      now - live.lastActivityAt < prefs.liveHoldMs
    );
  };
  const liveRank = (key: K): number => {
    const live = liveOf(key);
    if (!live) return 0;
    switch (prefs.liveOrder) {
      case "furthest":
        return 1 - live.ratio;
      case "closest":
        return live.ratio;
      default:
        return live.lastActivityAt;
    }
  };
  let ordered = [...keys];
  if (prefs.liveFirst) {
    ordered = ordered
      .map((key, index) => ({ key, index, live: isLive(key) }))
      .sort((left, right) => {
        if (left.live !== right.live) return left.live ? -1 : 1;
        if (!left.live) return left.index - right.index;
        // 等你回应的项目排在正在跑的前面：人一眼就能看到哪里卡着等他。
        const leftWaiting = prefs.liveIncludeWaiting && (liveOf(left.key)?.waiting ?? 0) > 0;
        const rightWaiting = prefs.liveIncludeWaiting && (liveOf(right.key)?.waiting ?? 0) > 0;
        if (leftWaiting !== rightWaiting) return leftWaiting ? -1 : 1;
        return liveRank(right.key) - liveRank(left.key) || left.index - right.index;
      })
      .map((entry) => entry.key);
  }
  if (!prefs.slots) {
    return [{ group: null, keys: ordered }];
  }
  const sections: { group: ZaicodeProjectSectionGroup | null; keys: K[] }[] = [];
  let rest = ordered;
  if (prefs.liveFirst && prefs.liveScope === "global") {
    const live = ordered.filter(isLive);
    rest = ordered.filter((key) => !isLive(key));
    if (live.length > 0 || !prefs.hideEmptySlots) sections.push({ group: "LIVE", keys: live });
  }
  for (const group of ZAICODE_SLOT_GROUPS) {
    const groupKeys = rest.filter(
      (key) => slotGroupOf(prefs.groups, key, prefs.defaultSlot) === group,
    );
    if (groupKeys.length === 0 && prefs.hideEmptySlots) continue;
    sections.push({ group, keys: groupKeys });
  }
  return sections;
}

/** One running session: its id, title, todo readiness (0..1) and where it lives. */
export interface ZaicodeRunningSession {
  sessionId: string;
  title: string;
  ratio: number;
  workspaceKey: string;
  /** Needed to open the session from anywhere (header meter, session cycling). */
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface ZaicodeSessionLocation {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** Running sessions of one project's task list, read from the live sessions-index activity. */
export function runningSessionsOf(
  workspaceKey: string,
  tasks: readonly ZCodeTaskMeta[],
  storedTodos: Readonly<Record<string, readonly ZaicodeTodoItem[]>>,
  location?: ZaicodeSessionLocation,
  now: number = Date.now(),
): ZaicodeRunningSession[] {
  // SRC-081: a session nobody has heard from for hours is STALLED, not working.
  return tasks
    .filter((task) => zaicodeSessionWorking(task, now))
    .map((task) => {
      const todos = getTaskListRowActivity(task)?.todos ?? storedTodos[task.taskId];
      return {
        sessionId: task.taskId,
        title: task.title || task.taskId,
        ratio: todoReadinessRatio(todos),
        workspaceKey,
        ...(location ? { workspacePath: location.workspacePath } : {}),
        ...(location?.workspaceIdentity ? { workspaceIdentity: location.workspaceIdentity } : {}),
      };
    });
}

/** Sessions of one project waiting for the operator (question / permission). */
export function waitingSessionsOf(
  workspaceKey: string,
  tasks: readonly ZCodeTaskMeta[],
  location?: ZaicodeSessionLocation,
): ZaicodeRunningSession[] {
  return tasks
    .filter((task) => getTaskListAttention(task) !== null || Boolean(task.pendingInteraction))
    .map((task) => ({
      sessionId: task.taskId,
      title: task.title || task.taskId,
      ratio: 0,
      workspaceKey,
      ...(location ? { workspacePath: location.workspacePath } : {}),
      ...(location?.workspaceIdentity ? { workspaceIdentity: location.workspaceIdentity } : {}),
    }));
}

/**
 * Every session working right now across all projects, published by the
 * sidebar so the header meter (count + Battlezone readiness cells) and the
 * ambience player can read it without re-querying task lists.
 */
interface ZaicodeRunningState {
  sessions: ZaicodeRunningSession[];
  publish: (sessions: ZaicodeRunningSession[]) => void;
}

function sameSessions(
  left: readonly ZaicodeRunningSession[],
  right: readonly ZaicodeRunningSession[],
) {
  return (
    left.length === right.length &&
    left.every(
      (session, index) =>
        session.sessionId === right[index]!.sessionId &&
        session.workspaceKey === right[index]!.workspaceKey &&
        session.workspacePath === right[index]!.workspacePath &&
        session.ratio === right[index]!.ratio &&
        session.title === right[index]!.title,
    )
  );
}

export const useZaicodeRunningSessions = create<ZaicodeRunningState>((set, get) => ({
  sessions: [],
  publish: (sessions) => {
    if (!sameSessions(get().sessions, sessions)) set({ sessions });
  },
}));
