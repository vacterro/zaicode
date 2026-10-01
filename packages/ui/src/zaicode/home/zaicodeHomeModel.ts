import {
  effectiveZaicodeWindows,
  isZaicodeRouterErrorRecent,
  zaicodeNextRefillAt,
  zaicodeWindowShowsLiveCountdown,
  type ZaicodeEngineAccount,
  type ZaicodeJob,
  type ZaicodeLimitSnapshot,
  type ZaicodeProjectRuntimeState,
  type ZaicodeRouterCombo,
  type ZaicodeRouterConnection,
  type ZaicodeStatsSourceState,
} from "@zcode/shared";
import { isZaicodeEngineShown, type ZaicodeMeterPrefs } from "../zaicodeMeterPrefs.js";
import type { ZaicodeRouterHostInfo } from "../zaicodeRouterSetup.js";
import type { ZaicodeRouterStatus } from "../zaicodeRouter.js";

/**
 * SAIHOME read model (T-56): pure functions from the owners' state to what
 * each module shows. Every value carries where it came from and how fresh it
 * is; "not known" stays null and is never shown as 0.
 */

export type ZaicodeHomeTruth = "authoritative" | "derived" | "estimated" | "stale" | "unavailable";

// ---------------------------------------------------------------------------
// Limits wall
// ---------------------------------------------------------------------------

/** A quota reading older than this is shown as stale. */
export const ZAICODE_HOME_QUOTA_STALE_MS = 30 * 60_000;

export interface ZaicodeHomeLimitRow {
  account: ZaicodeEngineAccount;
  snapshot: ZaicodeLimitSnapshot | undefined;
  truth: ZaicodeHomeTruth;
  /** Sign-in needed / CLI missing: the tile says so instead of a number. */
  needsAttention: string | null;
  nextResetAt: number | null;
}

/**
 * Engines in the wall: the operator's hidden accounts never; the meter's
 * filters apply unless `showAll` (a temporary view that does not touch the
 * saved filters). Accounts that need sign-in always stay visible.
 */
export function zaicodeHomeLimitRows(input: {
  accounts: readonly ZaicodeEngineAccount[];
  hiddenAccounts: readonly string[];
  limits: Record<string, ZaicodeLimitSnapshot>;
  meterPrefs: Pick<ZaicodeMeterPrefs, "hideZeroUsage" | "onlyUsable5h" | "filterMeter" | "filterTiles" | "meterHidden">;
  showAll: boolean;
  now: number;
}): { rows: ZaicodeHomeLimitRow[]; filtered: number } {
  const rows: ZaicodeHomeLimitRow[] = [];
  let filtered = 0;
  for (const account of input.accounts) {
    if (input.hiddenAccounts.includes(account.id)) continue;
    const snapshot = input.limits[account.id];
    // T-134: a login never set up on this machine is an offer, not a problem (no "needs you", no red HEALTH).
    const needsAttention = account.optional
      ? null
      : account.status === "login-required"
        ? "sign-in required"
        : account.status === "cli-missing"
          ? "CLI missing"
          : null;
    if (!input.showAll && !needsAttention && !isZaicodeEngineShown(account, snapshot, input.meterPrefs, "meter", input.now)) {
      filtered += 1;
      continue;
    }
    const truth: ZaicodeHomeTruth =
      !snapshot || snapshot.fetchedAt === null
        ? "unavailable"
        : snapshot.error || input.now - snapshot.fetchedAt > ZAICODE_HOME_QUOTA_STALE_MS
          ? "stale"
          : "authoritative";
    rows.push({ account, snapshot, truth, needsAttention, nextResetAt: zaicodeNextResetOf(snapshot, input.now) });
  }
  return { rows, filtered };
}

/** Nearest future reset of a window that is not full. */
export function zaicodeNextResetOf(snapshot: ZaicodeLimitSnapshot | undefined, now: number): number | null {
  if (!snapshot) return null;
  let best: number | null = null;
  for (const window of effectiveZaicodeWindows(snapshot.windows, now)) {
    // Idle (starts on first use) and gated windows have no coming refill (SRC-048).
    // SRC-116: same 100% trap as the topbar clock -- a rolling window must reach SAIHOME.
    if (window.resetsAt === null) continue;
    if (!zaicodeWindowShowsLiveCountdown(window, now)) continue;
    if (best === null || window.resetsAt < best) best = window.resetsAt;
  }
  return best ?? zaicodeNextRefillAt(snapshot, now) ?? null;
}

// ---------------------------------------------------------------------------
// Queue / agents
// ---------------------------------------------------------------------------

export interface ZaicodeHomeQueueCounts {
  running: number;
  ready: number;
  waiting: number;
  blocked: number;
  /** Finished today (local midnight) as the queue rows say. */
  doneToday: number;
  failedToday: number;
}

const READY = new Set(["queued", "ready"]);

export function zaicodeHomeQueueCounts(jobs: readonly ZaicodeJob[] | null, startOfToday: number): ZaicodeHomeQueueCounts | null {
  if (!jobs) return null;
  const counts: ZaicodeHomeQueueCounts = { running: 0, ready: 0, waiting: 0, blocked: 0, doneToday: 0, failedToday: 0 };
  for (const job of jobs) {
    if (job.status === "running") counts.running += 1;
    else if (READY.has(job.status)) counts.ready += 1;
    else if (job.status === "waiting" || job.status === "draft") counts.waiting += 1;
    else if (job.status === "blocked") counts.blocked += 1;
    else if (job.finishedAt !== undefined && job.finishedAt >= startOfToday) {
      if (job.status === "completed") counts.doneToday += 1;
      else if (job.status === "failed") counts.failedToday += 1;
    }
  }
  return counts;
}

export function zaicodeStartOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface ZaicodeHomeRouting {
  state: "healthy" | "degraded" | "down" | "unavailable" | "checking";
  headline: string;
  mode: string | null;
  pools: { name: string; models: number }[];
  providers: { total: number; active: number; failing: ZaicodeRouterConnection[] };
  restarts: number;
  lastError: string | null;
  lastScanAt: number | null;
  truth: ZaicodeHomeTruth;
}

/** Active connections whose last error is recent (T-133), the newest first. */
export function zaicodeRecentRouterFailures(
  connections: readonly ZaicodeRouterConnection[],
  now: number,
): ZaicodeRouterConnection[] {
  const at = (connection: ZaicodeRouterConnection) => {
    const time = connection.lastErrorAt ? Date.parse(connection.lastErrorAt) : Number.NaN;
    return Number.isNaN(time) ? 0 : time;
  };
  return connections
    .filter((connection) => connection.isActive && isZaicodeRouterErrorRecent(connection, now))
    .sort((left, right) => at(right) - at(left));
}

export function zaicodeHomeRouting(input: {
  status: ZaicodeRouterStatus;
  message: string;
  host: ZaicodeRouterHostInfo | null;
  combos: readonly ZaicodeRouterCombo[];
  connections: readonly ZaicodeRouterConnection[];
  lastScanAt: number | null;
  now?: number;
}): ZaicodeHomeRouting {
  const pools = input.combos
    .filter((combo) => /^(saifren|saiopp)$/i.test(combo.name))
    .map((combo) => ({ name: combo.name.toUpperCase(), models: combo.models.length }));
  const failing = zaicodeRecentRouterFailures(input.connections, input.now ?? Date.now());
  const active = input.connections.filter((connection) => connection.isActive).length;
  const base = {
    mode: input.host ? `${input.host.mode}${input.host.requestedMode === "auto" ? " (auto)" : ""}` : null,
    pools,
    providers: { total: input.connections.length, active, failing },
    restarts: input.host?.restarts ?? 0,
    lastError: input.host?.lastError ?? null,
    lastScanAt: input.lastScanAt,
  };
  if (input.status === "unavailable") return { ...base, state: "unavailable", headline: "Router needs the desktop app", truth: "unavailable" };
  if (input.status === "idle" || input.status === "loading") {
    return { ...base, state: "checking", headline: "Checking the router…", truth: "unavailable" };
  }
  if (input.status === "down") {
    return { ...base, state: "down", headline: `Router down${input.message ? `: ${input.message}` : ""}`, truth: "authoritative" };
  }
  // SAIFREN (free) must have a model; SAIOPP (paid) is empty until a subscription is added, which is no fault.
  const free = pools.find((pool) => pool.name === "SAIFREN");
  const emptyFree = free !== undefined && free.models === 0;
  // A pool routes around a provider that erred: one or two out of dozens are no fault of the router. A real share is.
  const manyFailing = failing.length > 0 && failing.length >= Math.max(3, Math.ceil(active * 0.25));
  if (manyFailing || emptyFree || !free) {
    const why = emptyFree
      ? "SAIFREN has no model"
      : !free
        ? "no SAIFREN pool"
        : `${failing.length} of ${active} provider(s) failed in the last hour`;
    return { ...base, state: "degraded", headline: `Router up · ${why}`, truth: "authoritative" };
  }
  return {
    ...base,
    state: "healthy",
    headline: failing.length > 0 ? `Router healthy · ${failing.length} provider(s) erred in the last hour` : "Router healthy",
    truth: "authoritative",
  };
}

// ---------------------------------------------------------------------------
// Action Center: WHAT / WHY / IMPACT / ONE NEXT ACTION
// ---------------------------------------------------------------------------

export type ZaicodeHomeActionKind =
  | "open-router"
  | "troubleshoot-router"
  | "open-engines"
  | "read-engine"
  | "open-project"
  | "open-waiting"
  | "open-scheduler"
  | "open-home-settings";

export interface ZaicodeHomeActionItem {
  id: string;
  severity: "blocking" | "warning";
  what: string;
  why: string;
  impact: string;
  action: { label: string; kind: ZaicodeHomeActionKind; target?: string };
}

export interface ZaicodeHomeProjectFact {
  path: string;
  name: string;
  state: ZaicodeProjectRuntimeState | null;
  reason: string | null;
  disabled: boolean;
}

export function zaicodeHomeActionItems(input: {
  routing: ZaicodeHomeRouting;
  limitRows: readonly ZaicodeHomeLimitRow[];
  projects: readonly ZaicodeHomeProjectFact[];
  waitingSessions: number;
  schedules: readonly { id: string; name: string; problem: string | null }[];
  statsSources: readonly ZaicodeStatsSourceState[];
  statsError: string | null;
  /** Events recorded so far (null = not read yet). */
  statsEventCount?: number | null;
}): ZaicodeHomeActionItem[] {
  const items: ZaicodeHomeActionItem[] = [];
  if (input.routing.state === "down") {
    items.push({
      id: "router-down",
      severity: "blocking",
      what: "Router down",
      why: input.routing.lastError ?? "the SAIRoute router does not answer",
      impact: "SAIFREN / SAIOPP chats and pool agents fail until it is back",
      action: { label: "Autotroubleshoot", kind: "troubleshoot-router" },
    });
  } else if (input.routing.state === "degraded") {
    items.push({
      id: "router-degraded",
      severity: "warning",
      what: input.routing.headline,
      why: input.routing.providers.failing[0]?.lastError ?? "a model pool is incomplete",
      impact: "fewer fallbacks: requests fail sooner",
      action: { label: "Open Router", kind: "open-router" },
    });
  }
  if (input.waitingSessions > 0) {
    items.push({
      id: "sessions-waiting",
      severity: "blocking",
      what: `${input.waitingSessions} session(s) wait for you`,
      why: "a question or a permission request",
      impact: "that work is paused until you answer",
      action: { label: "Open", kind: "open-waiting" },
    });
  }
  for (const project of input.projects) {
    if (project.disabled || project.state !== "blocked") continue;
    items.push({
      id: `project-${project.path}`,
      severity: "blocking",
      what: `${project.name} is blocked`,
      why: project.reason ?? "SAIPEN reports a blocker",
      impact: "no agent can continue this project",
      action: { label: "Open project", kind: "open-project", target: project.path },
    });
  }
  for (const row of input.limitRows) {
    if (row.needsAttention) {
      items.push({
        id: `engine-${row.account.id}`,
        severity: "warning",
        what: `${row.account.label}: ${row.needsAttention}`,
        why: row.account.statusDetail || row.needsAttention,
        impact: "this subscription cannot start workers or scheduled runs",
        action: { label: "Engines & limits", kind: "open-engines" },
      });
    } else if (row.truth === "stale" && row.snapshot?.error) {
      items.push({
        id: `engine-stale-${row.account.id}`,
        severity: "warning",
        what: `${row.account.label}: quota reading is stale`,
        why: row.snapshot.error,
        impact: "the shown quota may be out of date",
        action: { label: "Read again", kind: "read-engine", target: row.account.id },
      });
    }
  }
  for (const schedule of input.schedules) {
    if (!schedule.problem) continue;
    items.push({
      id: `schedule-${schedule.id}`,
      severity: "warning",
      what: `Schedule "${schedule.name}": ${schedule.problem}`,
      why: schedule.problem,
      impact: "the prepared work will not start",
      action: { label: "Open Scheduler", kind: "open-scheduler" },
    });
  }
  const agentDb = input.statsSources.find((source) => source.source === "agent-db" && source.state === "unavailable");
  // A new profile has no agent usage store until the agent's first run: nothing
  // is missing yet (like a pool without a subscription), so no red HEALTH on the
  // first launch. A store that goes missing after statistics exist is a fault.
  const notCreatedYet = input.statsEventCount === 0 && /usage store not found/.test(agentDb?.detail ?? "");
  const statsDown = input.statsError ?? (notCreatedYet ? undefined : agentDb?.detail);
  if (statsDown && !/not read yet/.test(statsDown)) {
    items.push({
      id: "stats-source",
      severity: "warning",
      what: "Statistics source unavailable",
      why: statsDown,
      impact: "token totals miss what this source would add",
      action: { label: "SAIHOME settings", kind: "open-home-settings" },
    });
  }
  return items.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === "blocking" ? -1 : 1));
}

/** "4.2 s", "3m 10s", "2h 05m", "3d 4h": short, exact enough, no rounding to zero. */
export function formatZaicodeRuntime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "×1.8", "−40%" style comparison text; null ratio -> "not enough data". */
export function formatZaicodeRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "not enough data";
  if (ratio >= 1) return `×${ratio.toFixed(ratio >= 10 ? 0 : 1)}`;
  return `−${Math.round((1 - ratio) * 100)}%`;
}

export function formatZaicodePercent(share: number | null): string {
  return share === null || !Number.isFinite(share) ? "not enough data" : `${Math.round(share * 100)}%`;
}
