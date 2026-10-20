import { ServiceChannels } from "@zcode/shared";
import type {
  ZaicodeOptimizationFindingDto,
  ZaicodeOptimizationPolicy,
  ZaicodeOptimizationSummaryDto,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IZaicodeOptimizationService {
  getSummary(filter?: {
    project?: string | null;
    sessionId?: string | null;
    days?: number;
  }): Promise<ZaicodeOptimizationSummaryDto>;
  getFindings(filter?: {
    project?: string | null;
    sessionId?: string | null;
  }): Promise<ZaicodeOptimizationFindingDto[]>;
  getPolicy(): ZaicodeOptimizationPolicy;
  updatePolicy(patch: Partial<ZaicodeOptimizationPolicy>): ZaicodeOptimizationPolicy;
}

export const IZaicodeOptimizationService = createServiceDescriptor<IZaicodeOptimizationService>(
  ServiceChannels.ZaicodeOptimization,
);
