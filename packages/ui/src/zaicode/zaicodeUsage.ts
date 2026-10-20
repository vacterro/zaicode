import { create } from "zustand";
import { ZAICODE_ROUTER_DEFAULT_URL, zaicodeSubscriptionConnectionOf } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";

export const ZAICODE_USAGE_PERIODS = ["today", "24h", "7d", "30d", "60d", "all"] as const;
export type ZaicodeUsagePeriod = (typeof ZAICODE_USAGE_PERIODS)[number];
export type ZaicodeUsageMode = "closed" | "page" | "sidebar";

/** Live meter refresh choices, in seconds. 10s keeps the default gentle; 1s is the floor a user who watches a token stream can ask for. */
export const ZAICODE_USAGE_REFRESH_SECONDS = [10, 5, 3, 2, 1] as const;
export type ZaicodeUsageRefreshSeconds = (typeof ZAICODE_USAGE_REFRESH_SECONDS)[number];
export const ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS: ZaicodeUsageRefreshSeconds = 10;

/** The name column is draggable between these shares of the table width; below 12% nothing fits, above 70% the metric columns do not. */
export const ZAICODE_USAGE_NAME_COLUMN_MIN_PERCENT = 12;
export const ZAICODE_USAGE_NAME_COLUMN_MAX_PERCENT = 70;

/** Pointer x -> the name column's share of the table, clamped. A table of zero width keeps the current width rather than jumping to a clamp edge. */
export function zaicodeUsageNameColumnPercent(params: {
  clientX: number;
  tableLeft: number;
  tableWidth: number;
  current: number;
}): number {
  if (!(params.tableWidth > 0)) return params.current;
  const share = Math.round(((params.clientX - params.tableLeft) / params.tableWidth) * 100);
  return Math.max(
    ZAICODE_USAGE_NAME_COLUMN_MIN_PERCENT,
    Math.min(ZAICODE_USAGE_NAME_COLUMN_MAX_PERCENT, share),
  );
}

export type ZaicodeRecentTimeFormat = "time" | "ago";
export const ZAICODE_USAGE_RECENT_TIME_KEY = "zaicode-usage-recent-time-format";
export const ZAICODE_USAGE_DIAGNOSTICS_KEY = "zaicode-usage-detailed-diagnostics";

export function readStoredRecentTimeFormat(): ZaicodeRecentTimeFormat {
  try {
    const storage = typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : typeof globalThis !== "undefined" && globalThis.localStorage
        ? globalThis.localStorage
        : null;
    const val = storage ? storage.getItem(ZAICODE_USAGE_RECENT_TIME_KEY) : null;
    return val === "ago" ? "ago" : "time";
  } catch {
    return "time";
  }
}

export function writeStoredRecentTimeFormat(format: ZaicodeRecentTimeFormat): void {
  try {
    const storage = typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : typeof globalThis !== "undefined" && globalThis.localStorage
        ? globalThis.localStorage
        : null;
    if (storage) {
      storage.setItem(ZAICODE_USAGE_RECENT_TIME_KEY, format);
    }
  } catch {}
}

/** Detailed per-request diagnostics, default OFF, persisted as user pref. */
export function readStoredUsageDiagnostics(): boolean {
  try {
    const storage = typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : typeof globalThis !== "undefined" && globalThis.localStorage
        ? globalThis.localStorage
        : null;
    return storage ? storage.getItem(ZAICODE_USAGE_DIAGNOSTICS_KEY) === "on" : false;
  } catch {
    return false;
  }
}

export function writeStoredUsageDiagnostics(on: boolean): void {
  try {
    const storage = typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : typeof globalThis !== "undefined" && globalThis.localStorage
        ? globalThis.localStorage
        : null;
    if (storage) {
      storage.setItem(ZAICODE_USAGE_DIAGNOSTICS_KEY, on ? "on" : "off");
    }
  } catch {}
}

/** Actionable failure only: whole request failed, fallback exhausted, or route rejected. Missing upstream attribution alone is not failure. */
export function zaicodeUsageRowNeedsWarning(row: {
  status: string;
  failure?: string | null;
  fallbackReason?: string | null;
}): boolean {
  const s = row.status.toLowerCase();
  if (s === "error" || s === "failed") return true;
  if (row.failure && row.failure.trim()) return true;
  return false;
}

/** Formats timestamp as local timezone HH:mm:ss (24-hour zero-padded). */
export function formatRecentTime(timestamp: string | number | Date): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** Formats elapsed duration relative to now (e.g. 12s ago, 3m ago, 2h ago, 1d ago). */
export function formatRecentAgo(timestamp: string | number | Date, now = Date.now()): string {
  const date = new Date(timestamp);
  const time = date.getTime();
  if (Number.isNaN(time)) return "—";
  const elapsed = Math.max(0, now - time);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) {
    return `${Math.max(0, seconds)}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const useZaicodeUsage = create<{
  mode: ZaicodeUsageMode;
  period: ZaicodeUsagePeriod;
  scope: "global" | "project" | "session";
  nameColumnPercent: number;
  setNameColumnPercent: (percent: number) => void;
  recentTimeFormat: ZaicodeRecentTimeFormat;
  setRecentTimeFormat: (format: ZaicodeRecentTimeFormat) => void;
  detailedDiagnostics: boolean;
  setDetailedDiagnostics: (on: boolean) => void;
}>((set) => ({
  mode: "closed",
  period: "today",
  scope: "global",
  // 页面与侧栏切换会重新挂载面板；列宽由已有 Usage 状态持有，不能随组件卸载丢失。
  nameColumnPercent: 34,
  setNameColumnPercent: (percent) => {
    if (!Number.isFinite(percent)) return;
    set({
      nameColumnPercent: Math.max(
        ZAICODE_USAGE_NAME_COLUMN_MIN_PERCENT,
        Math.min(ZAICODE_USAGE_NAME_COLUMN_MAX_PERCENT, percent),
      ),
    });
  },
  recentTimeFormat: readStoredRecentTimeFormat(),
  setRecentTimeFormat: (format) => {
    writeStoredRecentTimeFormat(format);
    set({ recentTimeFormat: format });
  },
  detailedDiagnostics: readStoredUsageDiagnostics(),
  setDetailedDiagnostics: (on) => {
    writeStoredUsageDiagnostics(on);
    set({ detailedDiagnostics: on });
  },
}));

export function zaicodeUsageSince(period: ZaicodeUsagePeriod, now: number): number {
  if (period === "all") return 0;
  if (period === "today") { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime(); }
  const days = period === "24h" ? 1 : Number(period.slice(0, -1));
  return Math.max(0, now - days * 86_400_000);
}

/**
 * How fresh the last successful reading is (T-319). The live meter shows this
 * as a small dot instead of swapping its status text on every poll, so routine
 * background refreshes cannot flash the header. `unknown` = nothing read yet.
 */
export const ZAICODE_USAGE_STALE_MS = 90_000;
export type ZaicodeUsageFreshness = "unknown" | "fresh" | "stale";

export function zaicodeUsageFreshness(updatedAt: number, now: number): ZaicodeUsageFreshness {
  if (!updatedAt) return "unknown";
  return now - updatedAt <= ZAICODE_USAGE_STALE_MS ? "fresh" : "stale";
}

/** The "Updated" label, to the minute: a 1s poll must not rewrite the text every second. */
export function formatZaicodeUsageUpdated(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Matches router origin directly or across loopback aliases (localhost, 127.0.0.1, [::1]) with the same port. */
export function isZaicodeRouterEndpoint(candidateUrl: string, routerUrl = ZAICODE_ROUTER_DEFAULT_URL): boolean {
  if (zaicodeSubscriptionConnectionOf(candidateUrl)) return true;
  try {
    const candidate = new URL(candidateUrl);
    const router = new URL(routerUrl);
    if (candidate.origin === router.origin) return true;
    const candidatePort = candidate.port || (candidate.protocol === "https:" ? "443" : "80");
    const routerPort = router.port || (router.protocol === "https:" ? "443" : "80");
    if (candidatePort === routerPort && candidate.protocol === router.protocol) {
      const isLoopback = (host: string) =>
        host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
      return isLoopback(candidate.hostname) && isLoopback(router.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

/** Exact configured router endpoints; a provider name alone cannot attribute its traffic. */
export function zaicodeUsageRouterProviderIds(view: ProviderSettingsView, routerUrl = ZAICODE_ROUTER_DEFAULT_URL): string[] {
  return view.providers.filter((provider) => {
    const baseUrl = provider.effectiveConfig.api?.baseUrl;
    if (typeof baseUrl !== "string") return false;
    return isZaicodeRouterEndpoint(baseUrl, routerUrl);
  }).map((provider) => provider.providerId);
}

export function openZaicodeUsage(mode: ZaicodeUsageMode = "page"): void {
  useZaicodeUsage.setState({ mode });
}

/** Which host draws the reading: the visible workspace, or the global portal. */
export type ZaicodeUsageSurface = "none" | "page" | "sidebar" | "global";

/**
 * REQ-020 surface contract. Exactly one host draws a reading, and the two
 * hosts are complementary: the workspace layout answers `ownsSurfaces` only
 * while it is visible and owns its panes, the global portal only while no
 * workspace does. So a click can never reach a second, hidden copy of the
 * panel, and a reading is never left with no host at all (which is what made
 * "Full page" and "Close" look dead).
 */
export function zaicodeUsageSurface(mode: ZaicodeUsageMode, ownsSurfaces: boolean): ZaicodeUsageSurface {
  if (mode === "closed") return "none";
  return ownsSurfaces ? mode : "global";
}

export function toggleZaicodeUsageSidebar(): void {
  openZaicodeUsage(zaicodeUsageLeftClickTarget(useZaicodeUsage.getState().mode));
}

/** REQ-013 click contract: left click opens/closes the usage sidebar. */
export function zaicodeUsageLeftClickTarget(mode: ZaicodeUsageMode): ZaicodeUsageMode {
  return mode === "sidebar" ? "closed" : "sidebar";
}

/** REQ-013 click contract: right click opens/closes the complete usage page. */
export function zaicodeUsageRightClickTarget(mode: ZaicodeUsageMode): ZaicodeUsageMode {
  return mode === "page" ? "closed" : "page";
}

export interface UsageCount {
  name: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
}

export interface UsageRecent extends UsageCount {
  id?: string;
  sessionId?: string;
  provider: string;
  timestamp: string;
  status: string;
  startedAt?: string | number | null;
  completedAt?: string | number | null;
  durationMs?: number;
  failure?: string | null;
  fallbackReason?: string | null;
  comboId?: string | null;
  upstreamModel?: string | null;
  upstreamProvider?: string | null;
  routerRequestId?: string | null;
  attributionStatus?: "verified" | "fallback" | "unattributed" | "attributed" | "missing_upstream";
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const str = (value: unknown): string => (typeof value === "string" ? value.slice(0, 256) : "");
const nullableStr = (value: unknown): string | null | undefined =>
  typeof value === "string" ? value.slice(0, 256) : value === null ? null : undefined;

function count(name: string, value: unknown): UsageCount {
  const v = object(value);
  return {
    name,
    requests: num(v.requests),
    input: num(v.promptTokens),
    output: num(v.completionTokens),
    cached: num(v.cachedTokens),
    cost: num(v.cost),
  };
}

/** Only metrics enter the view: request bodies, credentials and cumulative logs stay out. */
export function normalizeZaicodeUsage(raw: unknown) {
  const v = object(raw);
  const breakdown = (field: string) =>
    Object.entries(object(v[field]))
      .map(([name, value]) => count(name.slice(0, 256), value))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 200);
  const recent: UsageRecent[] = (Array.isArray(v.recentRequests) ? v.recentRequests : [])
    .slice(0, 100)
    .map((entry) => {
      const row = object(entry);
      const attributionStatus =
        row.attributionStatus === "verified" ||
        row.attributionStatus === "fallback" ||
        row.attributionStatus === "unattributed" ||
        row.attributionStatus === "attributed" ||
        row.attributionStatus === "missing_upstream"
          ? row.attributionStatus
          : undefined;
      return {
        ...count(str(row.model), row),
        id: typeof row.id === "string" ? row.id : undefined,
        sessionId: typeof row.sessionId === "string" ? row.sessionId : undefined,
        provider: str(row.provider),
        timestamp: str(row.timestamp),
        status: str(row.status),
        startedAt: typeof row.startedAt === "string" || typeof row.startedAt === "number" ? row.startedAt : undefined,
        completedAt: typeof row.completedAt === "string" || typeof row.completedAt === "number" ? row.completedAt : undefined,
        durationMs: typeof row.durationMs === "number" ? row.durationMs : undefined,
        failure: nullableStr(row.failure),
        fallbackReason: nullableStr(row.fallbackReason),
        comboId: nullableStr(row.comboId),
        upstreamModel: nullableStr(row.upstreamModel),
        upstreamProvider: nullableStr(row.upstreamProvider),
        routerRequestId: nullableStr(row.routerRequestId),
        attributionStatus,
      };
    });
  const active = (Array.isArray(v.activeRequests) ? v.activeRequests : [])
    .slice(0, 100)
    .map((entry) => {
      const row = object(entry);
      return { name: str(row.model), provider: str(row.provider), requests: num(row.count) };
    });
  return {
    totals: count("Total", {
      requests: v.totalRequests,
      promptTokens: v.totalPromptTokens,
      completionTokens: v.totalCompletionTokens,
      cachedTokens: v.totalCachedTokens,
      cost: v.totalCost,
    }),
    providers: breakdown("byProvider"),
    models: breakdown("byModel"),
    accounts: breakdown("byAccount"),
    recent,
    active,
  };
}

export function normalizeZaicodeUsageChart(raw: unknown) {
  return (Array.isArray(raw) ? raw : []).slice(-120).map((entry) => {
    const row = object(entry);
    return { label: str(row.label), tokens: num(row.tokens), cost: num(row.cost) };
  });
}
