import { ServiceChannels } from "@zcode/shared";
import type {
  ZaicodeAuditLoopReviewerMode,
  ZaicodeAuditLoopRun,
  ZaicodeAuditLoopState,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * ZAICODE Audit Loop service (T-289, SRC-202).
 *
 * The orchestration layer around the existing A3/Quick3 audit machinery: one
 * durable run per finished executor job, its own evidence package, one
 * reviewer step, one authorized remediation dispatched back to the original
 * execution context, one verification step, and a bounded number of cycles.
 *
 * The service never audits. It uses the existing auditor/implementer agents and
 * the existing durable queue; a wave, a campaign and a job stay owned by the
 * services that already own them.
 */

export type ZaicodeAuditLoopRefusalCode =
  | "AUDIT_MODE_DISABLED"
  | "EXECUTOR_NOT_TERMINAL"
  | "EXECUTOR_UNKNOWN"
  | "MISMATCHED_TASK_IDENTITY"
  | "ACTIVE_OVERLAPPING_WORKER"
  | "WORKER_INVENTORY_UNKNOWN"
  | "CONFLICTING_LOOP"
  | "ADMISSION_LOCK_UNAVAILABLE"
  | "ADMISSION_RESERVATION_FAILED"
  | "SOURCE_EVIDENCE_UNSTABLE"
  | "NO_TERMINAL_DISPOSITION";

export interface ZaicodeAuditLoopAdmitInput {
  /** Stable project identity: the workspace key, not the open tab. */
  workspaceKey: string;
  workspacePath: string;
  projectName: string;
  /** The terminal execution completion this run is admitted from. */
  executor: {
    agentId: string;
    jobId: string;
    sessionId: string | null;
  };
  /** The task whose completion admitted the run. */
  taskId: string;
  /** The human goal the audit belongs to, so feedback is never read as new intent. */
  goalId: string | null;
  /** The terminal job disposition that admitted this run; prose is never enough. */
  terminalDisposition: string;
  /** `saipen:<SRC-###>` / host evidence reference, when one exists. */
  authorityRef?: string | null;
  /** The project's permission to audit automatically (the existing A3 switch). */
  autoAudits: boolean;
}

export type ZaicodeAuditLoopAdmitResult =
  | { ok: true; run: ZaicodeAuditLoopRun }
  | { ok: false; code: ZaicodeAuditLoopRefusalCode; reason: string };

export interface ZaicodeAuditLoopSettings {
  /** Master admission switch for the loop layer itself. */
  enabled: boolean;
  maxCycles: number;
  reviewerMode: ZaicodeAuditLoopReviewerMode;
  /** Consent to transmit sanitized source evidence to an external reviewer. */
  externalTransmissionConsent: { granted: boolean; scope: string | null; grantedAt: string | null };
  /** What happens when the configured reviewer is unavailable. */
  externalFallback: "self" | "none";
}

export interface IZaicodeAuditLoopService {
  /** Durable runs plus the operator-visible settings; reconciles first. */
  getState(): Promise<{ runs: ZaicodeAuditLoopRun[]; settings: ZaicodeAuditLoopSettings }>;
  getRun(loopId: string): Promise<ZaicodeAuditLoopRun | null>;
  /**
   * Admit a run from an authoritative terminal executor event. Refuses prose,
   * a non-terminal job, an overlapping worker, a conflicting loop and an
   * unavailable source identity.
   */
  admit(input: ZaicodeAuditLoopAdmitInput): Promise<ZaicodeAuditLoopAdmitResult>;
  /** Manual "audit now": the same path, admitted without the automatic switch. */
  auditNow(input: ZaicodeAuditLoopAdmitInput): Promise<ZaicodeAuditLoopAdmitResult>;
  /**
   * Drive one run forward until it parks or finishes. Idempotent: a reload, a
   * restart or a repeated call never produces a second reviewer or a second fix.
   */
  advance(loopId: string): Promise<ZaicodeAuditLoopRun | null>;
  /**
   * The terminal event of a review or fix job THIS loop dispatched. The run is
   * located by its durable pending/remediation job id, never by title text, and
   * only the queue's own terminal status moves it; an unknown or still-running
   * id is a no-op. This is what makes the loop advance without a poller.
   */
  resumeFromTerminalJob(input: {
    workspaceKey: string;
    jobId: string;
    terminalDisposition: string;
  }): Promise<ZaicodeAuditLoopRun | null>;

  /** Recovery after a restart: advance every non-terminal run once. */
  reconcile(): Promise<{ advanced: string[]; parked: string[] }>;
  cancel(loopId: string): Promise<ZaicodeAuditLoopRun | null>;
  /** Explicit operator resume; the only path that refills the step retry budget. */
  resume(loopId: string): Promise<ZaicodeAuditLoopRun | null>;
  setEnabled(enabled: boolean): Promise<ZaicodeAuditLoopSettings>;
  setMaxCycles(maxCycles: number): Promise<ZaicodeAuditLoopSettings>;
  setReviewerMode(mode: ZaicodeAuditLoopReviewerMode): Promise<ZaicodeAuditLoopSettings>;
  setExternalConsent(input: {
    granted: boolean;
    scope: string;
  }): Promise<ZaicodeAuditLoopSettings>;
  /** The sanitized evidence package a reviewer was given, when it exists. */
  readEvidence(loopId: string, cycle?: number): Promise<string | null>;
  /** The reviewer's immutable artifact for one cycle. */
  readReviewArtifact(loopId: string, cycle: number): Promise<string | null>;
  /** How a run would be described right now, without mutating it. */
  describe(loopId: string): Promise<{ state: ZaicodeAuditLoopState; label: string; openFindings: number } | null>;
  dispose(): void;
}

export const IZaicodeAuditLoopService = createServiceDescriptor<IZaicodeAuditLoopService>(
  ServiceChannels.ZaicodeAuditLoops,
);
