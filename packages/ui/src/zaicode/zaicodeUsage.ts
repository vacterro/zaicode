import { create } from "zustand";

export const ZAICODE_USAGE_PERIODS = ["today", "24h", "7d", "30d", "60d", "all"] as const;
export type ZaicodeUsagePeriod = (typeof ZAICODE_USAGE_PERIODS)[number];
export type ZaicodeUsageMode = "closed" | "page" | "sidebar";

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
