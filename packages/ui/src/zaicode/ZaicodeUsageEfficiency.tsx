import type {
  ZaicodeOptimizationFindingDto,
  ZaicodeOptimizationSummaryDto,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { formatZaicodeUsageCount as number, formatZaicodeUsageCost as cost } from "./zaicodeUsageLabels.js";

/**
 * SRC-206 Milestone 1 — read-only optimization visibility.
 *
 * Presentation only: the summary and the findings arrive already computed by
 * `IZaicodeOptimizationService`, so this panel can be rendered (and asserted)
 * with plain data, and a missing or failing host service cannot break the
 * usage page — `null` simply reads as "not measured yet".
 */
export interface ZaicodeUsageEfficiencyProps {
  summary: ZaicodeOptimizationSummaryDto | null;
  findings: readonly ZaicodeOptimizationFindingDto[];
  loading: boolean;
}

export function ZaicodeUsageEfficiency({ summary, findings, loading }: ZaicodeUsageEfficiencyProps) {
  return (
    <div
      className="space-y-3 border border-border p-3 text-ui-base"
      role="tabpanel"
      aria-label="Optimization & Efficiency"
      data-testid="zaicode-optimization-efficiency"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div>
          <strong className="text-ui-sm flex items-center gap-1.5">
            optimAIzr Engine
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-subtle border border-border">
              v0.10.2 · MIT
            </span>
          </strong>
          <p className="text-foreground-subtle">
            Built-in local token optimization, context waste detection, and cache efficiency analytics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded border border-border bg-surface px-2 py-0.5 font-medium text-foreground">
            OBSERVE &amp; RECOMMEND
          </span>
          <span className="text-[10px] text-foreground-subtle">Safe default · Mutations locked</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="border border-border p-2">
          <span className="block text-foreground-subtle">Cache Hit Rate</span>
          <strong className="text-ui-sm tabular-nums">
            {summary ? `${(summary.cacheHitRate * 100).toFixed(1)}%` : "—"}
          </strong>
          <span className="block text-[10px] text-foreground-subtle">
            {summary
              ? `${number(summary.cacheReadTokens)} read / ${number(summary.cacheWriteTokens)} written`
              : "No cache events"}
          </span>
        </div>
        <div className="border border-border p-2">
          <span className="block text-foreground-subtle">Billed API Spend</span>
          <strong className="text-ui-sm tabular-nums">{summary ? cost(summary.totalCostUsd) : "—"}</strong>
          <span className="block text-[10px] text-foreground-subtle">
            {summary && summary.unpricedCalls > 0
              ? `${number(summary.unpricedCalls)} calls unpriced`
              : "Direct provider invoices"}
          </span>
        </div>
        <div className="border border-border p-2">
          <span className="block text-foreground-subtle">Subscription Value</span>
          <strong className="text-ui-sm tabular-nums text-foreground-subtle">
            {summary ? cost(summary.apiEquivalentCostUsd) : "—"}
          </strong>
          <span className="block text-[10px] text-foreground-subtle">API-equivalent · Not a bill</span>
        </div>
        <div className="border border-border p-2">
          <span className="block text-foreground-subtle">Potential Monthly Savings</span>
          <strong className="text-ui-sm tabular-nums text-[var(--color-brand)]">
            {summary ? cost(summary.potentialSavingsMonthlyUsd) : "—"}
          </strong>
          <span className="block text-[10px] text-foreground-subtle">Identified waste rules</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <strong>Findings &amp; Waste Recommendations ({findings.length})</strong>
          {loading ? <span className="text-foreground-subtle">Analyzing…</span> : null}
        </div>

        {findings.length > 0 ? (
          <div className="space-y-2">
            {findings.map((finding, idx) => (
              <div
                key={`${finding.rule}:${idx}`}
                className="border border-border p-2.5 bg-surface/30 space-y-1.5"
                data-optimization-finding={finding.rule}
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] uppercase font-semibold",
                        finding.severity === "high"
                          ? "bg-destructive/15 text-destructive border border-destructive/30"
                          : finding.severity === "medium"
                            ? "bg-warning/15 text-warning border border-warning/30"
                            : "bg-surface text-foreground-subtle border border-border",
                      )}
                    >
                      {finding.severity}
                    </span>
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] border border-border text-foreground-subtle">
                      {finding.evidenceKind}
                    </span>
                    <strong className="text-ui-xs">{finding.title}</strong>
                  </div>
                  <div className="text-[11px] tabular-nums">
                    <span className="text-foreground-subtle">Potential: </span>
                    <strong className="text-[var(--color-brand)]">
                      {cost(finding.savingsMonthlyUsd)}/mo
                    </strong>
                    <span className="text-foreground-subtle ml-1">({finding.confidence} conf)</span>
                  </div>
                </div>

                <p className="text-foreground-subtle">{finding.detail}</p>
                <p className="text-[11px] text-foreground-subtle italic">{finding.why}</p>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/50 text-[11px]">
                  <span className="text-foreground-subtle">
                    Affected: {finding.affectedCalls} calls ·{" "}
                    {finding.affectedModels.join(", ") || "all models"}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-foreground-subtle">Recommended action:</span>
                    <span className="font-medium text-foreground">{finding.fix}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="border border-dashed border-border p-6 text-center text-foreground-subtle">
            {loading
              ? "Evaluating usage with optimAIzr analytics…"
              : "No efficiency waste detected. Context growth, cache usage, and model allocations are within recommended thresholds."}
          </div>
        )}
      </div>
    </div>
  );
}
