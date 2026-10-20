import {
  findWaste,
  type OptimizationFinding,
} from "./optimaizr/index.js";
import {
  adaptStatsEventsToOptimizationDataset,
  buildOptimizationSummaryDto,
} from "./zaicodeOptimizationAdapter.js";
import type { ZaicodeStatsRepo, ZaicodeStatsEventRow } from "./zaicodeStatsRepo.js";
import type { IZaicodeOptimizationService } from "./zaicodeOptimization.js";
import {
  DEFAULT_ZAICODE_OPTIMIZATION_POLICY,
  type ZaicodeOptimizationFindingDto,
  type ZaicodeOptimizationPolicy,
  type ZaicodeOptimizationSummaryDto,
} from "@zcode/shared";

export interface ZaicodeOptimizationServiceDeps {
  repo: ZaicodeStatsRepo;
  subscriptionProviders?: ReadonlySet<string>;
  logger?: {
    warn(message: string, error?: unknown): void;
    info(message: string): void;
  };
}

export class ZaicodeOptimizationService implements IZaicodeOptimizationService {
  private policy: ZaicodeOptimizationPolicy = { ...DEFAULT_ZAICODE_OPTIMIZATION_POLICY };

  constructor(private readonly deps: ZaicodeOptimizationServiceDeps) {}

  getPolicy(): ZaicodeOptimizationPolicy {
    return { ...this.policy };
  }

  updatePolicy(patch: Partial<ZaicodeOptimizationPolicy>): ZaicodeOptimizationPolicy {
    // High-risk mutations remain clamped to preventMutations by default
    this.policy = {
      ...this.policy,
      ...patch,
      // If autoOptimize is enabled, it must be an explicit opt-in
      preventMutations: patch.preventMutations ?? !patch.autoOptimize,
      allowPromptCapture: false, // strictly forbidden in local telemetry
    };
    return this.getPolicy();
  }

  private async fetchRows(filter?: {
    project?: string | null;
    sessionId?: string | null;
  }): Promise<ZaicodeStatsEventRow[]> {
    await this.deps.repo.ensureReady();
    // Use repo.all() as authoritative source, filtering in-memory
    const all = this.deps.repo.all();
    return all.filter((row) => {
      if (filter?.project && row.project !== filter.project) return false;
      if (filter?.sessionId && row.sessionId !== filter.sessionId) return false;
      return true;
    });
  }

  async getFindings(filter?: {
    project?: string | null;
    sessionId?: string | null;
  }): Promise<ZaicodeOptimizationFindingDto[]> {
    if (!this.policy.enabled) return [];

    try {
      const rows = await this.fetchRows(filter);
      const dataset = adaptStatsEventsToOptimizationDataset(rows, {
        subscriptionProviders: this.deps.subscriptionProviders,
      });

      if (dataset.events.length === 0) return [];

      const rawFindings = findWaste(dataset);
      return rawFindings.map((finding) => this.mapFindingToDto(finding));
    } catch (error) {
      this.deps.logger?.warn("Optimization findings analysis failed gracefully", error);
      return [];
    }
  }

  async getSummary(filter?: {
    project?: string | null;
    sessionId?: string | null;
    days?: number;
  }): Promise<ZaicodeOptimizationSummaryDto> {
    try {
      const rows = await this.fetchRows(filter);
      const dataset = adaptStatsEventsToOptimizationDataset(rows, {
        subscriptionProviders: this.deps.subscriptionProviders,
        windowDays: filter?.days,
      });

      let findingsDto: ZaicodeOptimizationFindingDto[] = [];
      if (this.policy.enabled && dataset.events.length > 0) {
        try {
          const rawFindings = findWaste(dataset);
          findingsDto = rawFindings.map((f) => this.mapFindingToDto(f));
        } catch (error) {
          this.deps.logger?.warn("Waste detection within summary failed gracefully", error);
        }
      }

      return buildOptimizationSummaryDto(dataset, findingsDto);
    } catch (error) {
      this.deps.logger?.warn("Optimization summary generation failed gracefully", error);
      // A failed read is an empty window, never a half-filled one.
      const now = new Date().toISOString();
      return buildOptimizationSummaryDto(
        { events: [], window: { from: now, to: now, days: filter?.days ?? 1 }, sources: [], warnings: [] },
        [],
      );
    }
  }

  private mapFindingToDto(finding: OptimizationFinding): ZaicodeOptimizationFindingDto {
    return {
      rule: finding.rule,
      category: finding.category,
      title: finding.title,
      detail: finding.detail,
      why: finding.why,
      severity: finding.severity,
      risk: finding.risk,
      impact: String(finding.impact),
      savingsWindowUsd: finding.savings.windowUsd,
      savingsMonthlyUsd: finding.savings.monthlyUsd,
      confidence: finding.savings.confidence,
      confidenceBasis: finding.savings.confidenceBasis,
      evidenceKind: finding.savings.evidence.kind,
      affectedCalls: finding.affected.calls,
      affectedModels: [...finding.affected.models],
      fix: finding.fix,
    };
  }
}
