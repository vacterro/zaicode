/**
 * ZAICODE Optimization Subsystem Contract (SRC-206)
 *
 * Integrates optimAIzr's analytical primitives as a local-first efficiency
 * engine while preserving ZAICODE authority over execution, credentials,
 * and user preferences.
 */

export type ZaicodeOptimizationEvidenceKind = "measured" | "inferred" | "estimated";
export type ZaicodeOptimizationSeverity = "high" | "medium" | "low";
export type ZaicodeOptimizationRisk = "safe" | "needs-verification";

export type ZaicodeOptimizationStatus =
  | "observed"
  | "analyzed"
  | "recommended"
  | "simulated"
  | "verified"
  | "approved"
  | "applied"
  | "monitoring"
  | "rolled_back"
  | "rejected";

export interface ZaicodeOptimizationFindingDto {
  rule: string;
  category: string;
  title: string;
  detail: string;
  why: string;
  severity: ZaicodeOptimizationSeverity;
  risk: ZaicodeOptimizationRisk;
  impact: string;
  savingsWindowUsd: number;
  savingsMonthlyUsd: number;
  confidence: "high" | "medium" | "low";
  confidenceBasis: string;
  evidenceKind: ZaicodeOptimizationEvidenceKind;
  affectedCalls: number;
  affectedModels: string[];
  fix: string;
}

export interface ZaicodeOptimizationBreakdownItem {
  key: string;
  calls: number;
  tokens: number;
  costUsd: number;
  cacheHitRate: number;
}

export interface ZaicodeOptimizationSummaryDto {
  calls: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  avgTokensPerCall: number;
  avgCostPerCall: number;
  totalCostUsd: number;
  apiEquivalentCostUsd: number;
  /** Calls whose model id is absent from the pricing catalogue: money unknown, not zero. */
  unpricedCalls: number;
  potentialSavingsMonthlyUsd: number;
  findingsCount: number;
  windowDays: number;
  byModel: ZaicodeOptimizationBreakdownItem[];
  byProvider: ZaicodeOptimizationBreakdownItem[];
  byProject: ZaicodeOptimizationBreakdownItem[];
  topWasteRules: Array<{
    rule: string;
    title: string;
    count: number;
    savingsMonthlyUsd: number;
  }>;
}

export interface ZaicodeOptimizationPolicy {
  /** Master switch for local optimization observability. Default: true */
  enabled: boolean;
  /** Observe without generating recommendation alerts. Default: false */
  observeOnly: boolean;
  /** Generate actionable read-only recommendations. Default: true */
  recommend: boolean;
  /** Automatic verified optimization mutations (opt-in only). Default: false */
  autoOptimize: boolean;
  /** Guardrail preventing runtime model or effort rewrites. Default: true */
  preventMutations: boolean;
  /** Guardrail strictly forbidding prompt content capture. Default: false */
  allowPromptCapture: boolean;
}

export const DEFAULT_ZAICODE_OPTIMIZATION_POLICY: Readonly<ZaicodeOptimizationPolicy> = {
  enabled: true,
  observeOnly: false,
  recommend: true,
  autoOptimize: false,
  preventMutations: true,
  allowPromptCapture: false,
};
