import {
  costOf,
  type Dataset,
  type UsageEvent,
  type UsageLike,
} from "./optimaizr/index.js";
import type { ZaicodeStatsEventRow } from "./zaicodeStatsRepo.js";
import type {
  ZaicodeOptimizationBreakdownItem,
  ZaicodeOptimizationFindingDto,
  ZaicodeOptimizationSummaryDto,
} from "@zcode/shared";

/**
 * Known subscription or pool providers where costs represent API-equivalent
 * consumption rather than direct billing invoices.
 */
export const ZAICODE_SUBSCRIPTION_PROVIDERS = new Set<string>([
  "sairoute",
  "sairoute-free",
  "claude-subscription",
  "codex-subscription",
  "chatgpt-subscription",
  "zcode-subscription",
]);

export interface AdaptedUsageEvent extends UsageEvent {
  /** True when usage corresponds to a flat-rate subscription rather than metered API billing */
  isApiEquivalentSubscription: boolean;
  /** True when the id is absent from the pricing catalogue: cost is unknown, never zero. */
  costUnpriced: boolean;
}

export function isSubscriptionProvider(providerId?: string | null): boolean {
  if (!providerId) return false;
  const normalized = providerId.toLowerCase().trim();
  if (ZAICODE_SUBSCRIPTION_PROVIDERS.has(normalized)) return true;
  return (
    normalized.startsWith("sairoute") ||
    normalized.includes("subscription") ||
    normalized.includes("pool")
  );
}

/**
 * Strip only what is presentation, never what is identity: a routed id such as
 * `anthropic/claude-opus-4-6` becomes `claude-opus-4-6`. A model the catalogue
 * does not carry stays itself, so `costOf` reports it unpriced instead of a
 * family guess billing a version the operator never ran (SRC-206 M1: unknown
 * stays unknown).
 *
 * ponytail: no alias table for vendor spellings; add one only with a citable
 * price source and effective date per alias.
 */
export function normalizeModelForPricing(rawModel: string): string {
  const trimmed = rawModel.toLowerCase().trim();
  const slash = trimmed.lastIndexOf("/");
  const bare = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return bare || trimmed;
}

/**
 * Converts a stored ZAICODE statistics event into a normalized optimAIzr UsageEvent.
 * Adheres strictly to truthfulness: does not fabricate tokens or cost estimates when unmeasured.
 */
export function adaptZaicodeStatsRowToUsageEvent(
  row: ZaicodeStatsEventRow,
  options?: {
    subscriptionProviders?: ReadonlySet<string>;
  },
): AdaptedUsageEvent | null {
  // Only model request events report authoritative token consumption
  if (row.kind !== "model.request") return null;

  // Unknown values remain 0 / unmeasured, never fabricated from characters
  const inputTokens = Math.max(0, row.inputTokens ?? 0);
  const outputTokens = Math.max(0, row.outputTokens ?? 0);
  const thinkingTokens = Math.max(0, row.reasoningTokens ?? 0);
  const cacheReadTokens = Math.max(0, row.cacheReadTokens ?? 0);
  const cacheWrite5mTokens = Math.max(0, row.cacheWriteTokens ?? 0);

  const modelId = row.model || "unknown";
  const provider = row.provider || "unknown";
  const ts = new Date(row.at).toISOString();

  const isSub =
    options?.subscriptionProviders?.has(provider.toLowerCase()) ??
    isSubscriptionProvider(provider);

  const usageLike: UsageLike = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    completion_tokens_details: {
      reasoning_tokens: thinkingTokens,
    },
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWrite5mTokens,
  };

  const calculatedCost = costOf(usageLike, normalizeModelForPricing(modelId), { at: ts });

  return {
    id: row.id,
    source: "sdk",
    provider,
    model: modelId,
    ts,
    sessionId: row.sessionId || "",
    project: row.project || "",
    turnId: row.jobId || undefined,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens: 0,
    latencyMs: row.durationMs ?? undefined,
    tools: [],
    isApiEquivalentSubscription: isSub,
    costUnpriced: calculatedCost.unpriced,
    cost: {
      ...calculatedCost,
    },
  };
}

/**
 * Packages rows into an optimAIzr Dataset without duplicate counting.
 */
export function adaptStatsEventsToOptimizationDataset(
  events: readonly ZaicodeStatsEventRow[],
  options?: {
    subscriptionProviders?: ReadonlySet<string>;
    windowDays?: number;
    sources?: string[];
  },
): Dataset {
  const seenIds = new Set<string>();
  const adaptedEvents: UsageEvent[] = [];

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);

    const adapted = adaptZaicodeStatsRowToUsageEvent(event, options);
    if (!adapted) continue;

    adaptedEvents.push(adapted);
    const time = event.at;
    if (time < minTs) minTs = time;
    if (time > maxTs) maxTs = time;
  }

  const now = Date.now();
  const fromTime = Number.isFinite(minTs) ? minTs : now;
  const toTime = Number.isFinite(maxTs) ? maxTs : now;
  const spanMs = Math.max(1000, toTime - fromTime);
  const days = options?.windowDays ?? Math.max(1, Math.ceil(spanMs / (24 * 60 * 60 * 1000)));

  return {
    events: adaptedEvents,
    window: {
      from: new Date(fromTime).toISOString(),
      to: new Date(toTime).toISOString(),
      days,
    },
    sources: options?.sources ?? ["agent-db"],
    warnings: [],
  };
}

/**
 * Builds the comprehensive DTO summary for UI consumption.
 */
export function buildOptimizationSummaryDto(
  dataset: Dataset,
  findings: readonly ZaicodeOptimizationFindingDto[],
): ZaicodeOptimizationSummaryDto {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalCostUsd = 0;
  let apiEquivalentCostUsd = 0;
  let unpricedCalls = 0;

  const modelMap = new Map<string, { calls: number; tokens: number; costUsd: number; cacheRead: number; input: number }>();
  const providerMap = new Map<string, { calls: number; tokens: number; costUsd: number; cacheRead: number; input: number }>();
  const projectMap = new Map<string, { calls: number; tokens: number; costUsd: number; cacheRead: number; input: number }>();

  for (const e of dataset.events) {
    calls += 1;
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    thinkingTokens += e.thinkingTokens;
    cacheReadTokens += e.cacheReadTokens;
    cacheWriteTokens += e.cacheWrite5mTokens + e.cacheWrite1hTokens;

    const eventCost = e.cost.total;
    const isSub = (e as AdaptedUsageEvent).isApiEquivalentSubscription;
    if ((e as AdaptedUsageEvent).costUnpriced) unpricedCalls += 1;

    if (isSub) {
      apiEquivalentCostUsd += eventCost;
    } else {
      totalCostUsd += eventCost;
    }

    const totalEventTokens =
      e.inputTokens + e.outputTokens + e.thinkingTokens + e.cacheReadTokens + e.cacheWrite5mTokens;

    const updateGroup = (
      map: Map<string, { calls: number; tokens: number; costUsd: number; cacheRead: number; input: number }>,
      key: string,
    ) => {
      const existing = map.get(key) ?? { calls: 0, tokens: 0, costUsd: 0, cacheRead: 0, input: 0 };
      existing.calls += 1;
      existing.tokens += totalEventTokens;
      existing.costUsd += eventCost;
      existing.cacheRead += e.cacheReadTokens;
      existing.input += e.inputTokens + e.cacheReadTokens;
      map.set(key, existing);
    };

    updateGroup(modelMap, e.model || "unknown");
    updateGroup(providerMap, e.provider || "unknown");
    updateGroup(projectMap, e.project || "default");
  }

  const toBreakdown = (
    map: Map<string, { calls: number; tokens: number; costUsd: number; cacheRead: number; input: number }>,
  ): ZaicodeOptimizationBreakdownItem[] =>
    [...map.entries()]
      .map(([key, v]) => ({
        key,
        calls: v.calls,
        tokens: v.tokens,
        costUsd: v.costUsd,
        cacheHitRate: v.input > 0 ? Math.min(1, v.cacheRead / v.input) : 0,
      }))
      .sort((a, b) => b.tokens - a.tokens);

  const totalTokens = inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheWriteTokens;
  const billableInput = inputTokens + cacheReadTokens;
  const cacheHitRate = billableInput > 0 ? Math.min(1, cacheReadTokens / billableInput) : 0;

  const potentialSavingsMonthlyUsd = findings.reduce(
    (sum, f) => sum + (Number.isFinite(f.savingsMonthlyUsd) ? f.savingsMonthlyUsd : 0),
    0,
  );

  const ruleMap = new Map<string, { title: string; count: number; savingsMonthlyUsd: number }>();
  for (const f of findings) {
    const existing = ruleMap.get(f.rule) ?? { title: f.title, count: 0, savingsMonthlyUsd: 0 };
    existing.count += 1;
    existing.savingsMonthlyUsd += f.savingsMonthlyUsd;
    ruleMap.set(f.rule, existing);
  }

  const topWasteRules = [...ruleMap.entries()]
    .map(([rule, val]) => ({ rule, ...val }))
    .sort((a, b) => b.savingsMonthlyUsd - a.savingsMonthlyUsd)
    .slice(0, 5);

  return {
    calls,
    totalTokens,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRate,
    avgTokensPerCall: calls > 0 ? Math.round(totalTokens / calls) : 0,
    avgCostPerCall: calls > 0 ? (totalCostUsd + apiEquivalentCostUsd) / calls : 0,
    totalCostUsd,
    apiEquivalentCostUsd,
    unpricedCalls,
    potentialSavingsMonthlyUsd,
    findingsCount: findings.length,
    windowDays: dataset.window.days,
    byModel: toBreakdown(modelMap),
    byProvider: toBreakdown(providerMap),
    byProject: toBreakdown(projectMap),
    topWasteRules,
  };
}
