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
/** Order of LIVE projects: closest to done, least done, or most recently active first. */
export type ZaicodeLiveOrder = "closest" | "furthest" | "recent";
/** LIVE projects float to the top of their own slot, or into one LIVE group above every slot. */
export type ZaicodeLiveScope = "slot" | "global";

export interface ZaicodeSidebarPrefs {
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
  /** Where project names sit in their row (SRC-038). */
  projectTitleAlign: ZaicodeSlotLabelAlign;
  /** Where session titles sit in their row. */
  sessionTitleAlign: ZaicodeSlotLabelAlign;
}

const STORAGE_KEY = "zaicode-sidebar-prefs-v1";
export const ZAICODE_SIDEBAR_DEFAULT_PREFS: ZaicodeSidebarPrefs = {
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
  liveOrder: "closest",
  liveScope: "slot",
  liveIncludeWaiting: true,
  liveProjectIndicator: true,
  liveDimIdle: false,
  projectTitleAlign: "left",
  sessionTitleAlign: "left",
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
  if (!raw || typeof raw !== "object") return { ...d, groups: {}, collapsedSlots: [] };
  const r = raw as Partial<Record<keyof ZaicodeSidebarPrefs, unknown>>;
  const groups: Record<string, ZaicodeSlotGroup> = {};
  if (r.groups && typeof r.groups === "object") {
    for (const [key, value] of Object.entries(r.groups as Record<string, unknown>)) {
      if (isZaicodeSlotGroup(value)) groups[key] = value;
    }
  }
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  return {
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
    liveOrder: pick(r.liveOrder, ["closest", "furthest", "recent"] as const, d.liveOrder),
    liveScope: pick(r.liveScope, ["slot", "global"] as const, d.liveScope),
    liveIncludeWaiting: flag(r.liveIncludeWaiting, d.liveIncludeWaiting),
    liveProjectIndicator: flag(r.liveProjectIndicator, d.liveProjectIndicator),
    liveDimIdle: flag(r.liveDimIdle, d.liveDimIdle),
    projectTitleAlign: pick(r.projectTitleAlign, ["left", "center", "right"] as const, d.projectTitleAlign),
    sessionTitleAlign: pick(r.sessionTitleAlign, ["left", "center", "right"] as const, d.sessionTitleAlign),
  };
}

/** Publishes the title alignment as CSS variables (zaicodeMotionCss.ts reads them). */
function applyTitleAlign(prefs: Pick<ZaicodeSidebarPrefs, "projectTitleAlign" | "sessionTitleAlign">): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  root.setProperty("--zaicode-project-title-align", prefs.projectTitleAlign);
  root.setProperty("--zaicode-session-title-align", prefs.sessionTitleAlign);
}

function load(): ZaicodeSidebarPrefs {
  try {
    return normalizeZaicodeSidebarPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeSidebarPrefs(null);
  }
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
    setGroup: (workspaceKey, group) => persist({ groups: { ...get().groups, [workspaceKey]: group } }),
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
  /** Latest activity timestamp among running/waiting sessions (ms). */
  lastActivityAt: number;
}

export function projectLiveOf(tasks: readonly ZCodeTaskMeta[], ratios: readonly number[]): ZaicodeProjectLive {
  let running = 0;
  let waiting = 0;
  let lastActivityAt = 0;
  for (const task of tasks) {
    const active = isTaskListRowActive(task);
    const asking = getTaskListAttention(task) !== null || Boolean(task.pendingInteraction);
    if (active) running += 1;
    if (asking) waiting += 1;
    if (active || asking) {
      lastActivityAt = Math.max(
        lastActivityAt,
        getTaskListRowActivity(task)?.lastActivityAt ?? 0,
        task.updatedAt ?? 0,
      );
    }
  }
  return {
    running,
    waiting,
    ratio: ratios.reduce((best, ratio) => Math.max(best, ratio), 0),
    lastActivityAt,
  };
}

export type ZaicodeProjectSectionGroup = ZaicodeSlotGroup | "LIVE";

/**
 * Orders project keys into sidebar sections. Pure: the sidebar passes keys in
 * their manual order plus each key's slot and live state.
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
    >;
    liveOf: (key: K) => ZaicodeProjectLive | undefined;
  },
): { group: ZaicodeProjectSectionGroup | null; keys: K[] }[] {
  const { prefs, liveOf } = options;
  const isLive = (key: K) => {
    const live = liveOf(key);
    if (!live) return false;
    return live.running > 0 || (prefs.liveIncludeWaiting && live.waiting > 0);
  };
  const liveRank = (key: K): number => {
    const live = liveOf(key);
    if (!live) return 0;
    switch (prefs.liveOrder) {
      case "furthest":
        return 1 - live.ratio;
      case "recent":
        return live.lastActivityAt;
      default:
        return live.ratio;
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
    const groupKeys = rest.filter((key) => slotGroupOf(prefs.groups, key, prefs.defaultSlot) === group);
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
): ZaicodeRunningSession[] {
  return tasks.filter(isTaskListRowActive).map((task) => {
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

function sameSessions(left: readonly ZaicodeRunningSession[], right: readonly ZaicodeRunningSession[]) {
  return (
    left.length === right.length &&
    left.every(
      (session, index) =>
        session.sessionId === right[index]!.sessionId &&
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
