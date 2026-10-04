import { create } from "zustand";

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

export const useZaicodeUsage = create<{
  mode: ZaicodeUsageMode;
  period: ZaicodeUsagePeriod;
}>(() => ({ mode: "closed", period: "today" }));

export function openZaicodeUsage(mode: ZaicodeUsageMode = "page"): void {
  useZaicodeUsage.setState({ mode });
}

export function toggleZaicodeUsageSidebar(): void {
  openZaicodeUsage(useZaicodeUsage.getState().mode === "sidebar" ? "closed" : "sidebar");
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
  provider: string;
  timestamp: string;
  status: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const str = (value: unknown): string => (typeof value === "string" ? value.slice(0, 256) : "");

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
      return {
        ...count(str(row.model), row),
        provider: str(row.provider),
        timestamp: str(row.timestamp),
        status: str(row.status),
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
