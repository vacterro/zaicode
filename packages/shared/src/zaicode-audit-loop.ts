/* oxlint-disable eslint(max-lines) -- T-289: one durable run contract. Its state set,
   transition table, stop policy, provenance rule and reviewer-result validator are all
   read together when deciding whether a cycle may advance; splitting them across modules
   would let one half of the contract be changed without the other, which is the exact
   drift this file exists to prevent. */
/**
 * ZAICODE Audit Loop — the durable run contract (T-289, SRC-202).
 *
 * The loop is an orchestration layer AROUND the existing A3/Quick3 audit
 * machinery, not a second audit engine. This module owns what one loop run IS:
 * its state set, the transitions allowed between those states, the stop policy,
 * and the shape a reviewer's structured result must have before the loop may
 * act on it. It is pure -- no clock, no IO, no store -- so every rule here is
 * directly testable and the durable owner in services only wires it up.
 *
 * Four rules the whole module exists to keep:
 *
 * 1. One durable authority. A run is identified by its own loop id plus the
 *    original executor/task/goal identity. The open workspace, the selected
 *    chat tab and the newest chat bubble are never run identity.
 * 2. Progress is proven, never asserted. A cycle advances only on a durable
 *    evidence snapshot, a validated reviewer result, and recorded verification
 *    evidence. "The reviewer said it is clean" is not clean.
 * 3. Review text is data. Nothing a reviewer writes can authorize work,
 *    broaden permissions or replace the original executor; findings carry no
 *    authority, only claims the executor must verify itself.
 * 4. Bounded by construction. Cycles, retry budget and the no-progress and
 *    invalid-reviewer guards are all persisted, and a crash never resets them.
 */

/** A loop run's maximum cycle count; the operator may lower it, never raise it past this. */
export const ZAICODE_AUDIT_LOOP_MAX_CYCLES = 10;
export const ZAICODE_AUDIT_LOOP_MIN_CYCLES = 1;

/** Two consecutive cycles whose open findings are identical are no progress. */
export const ZAICODE_AUDIT_LOOP_NO_PROGRESS_CYCLES = 2;
/** Consecutive malformed reviewer results the loop tolerates before it asks a human. */
export const ZAICODE_AUDIT_LOOP_INVALID_REVIEW_LIMIT = 3;
/** A per-step retry budget; exhausted means FAILED_RECOVERABLE, never a silent extra run. */
export const ZAICODE_AUDIT_LOOP_RETRY_BUDGET = 3;

export type ZaicodeAuditLoopState =
  | "DISABLED"
  | "WAITING_FOR_EXECUTOR"
  | "SNAPSHOTTING"
  | "READY_FOR_REVIEW"
  | "REVIEWING"
  | "VALIDATING_REVIEW"
  | "WAITING_FOR_REMEDIATION"
  | "REMEDIATING"
  | "VERIFYING_FIX"
  | "READY_FOR_NEXT_CYCLE"
  | "CLEAN_CONFIRMED"
  | "WAITING_OPERATOR"
  | "FAILED_RECOVERABLE"
  | "STOPPED_LIMIT"
  | "CANCELLED";

/**
 * The explicit transition table. Anything absent here is illegal, so a bug
 * cannot walk a run into a state its predecessors never authorized.
 */
export const ZAICODE_AUDIT_LOOP_TRANSITIONS: Readonly<Record<ZaicodeAuditLoopState, readonly ZaicodeAuditLoopState[]>> = {
  DISABLED: ["WAITING_FOR_EXECUTOR"],
  WAITING_FOR_EXECUTOR: ["SNAPSHOTTING", "CANCELLED", "WAITING_OPERATOR", "DISABLED"],
  SNAPSHOTTING: ["READY_FOR_REVIEW", "FAILED_RECOVERABLE", "CANCELLED", "STOPPED_LIMIT"],
  READY_FOR_REVIEW: ["REVIEWING", "CANCELLED", "WAITING_OPERATOR", "STOPPED_LIMIT"],
  REVIEWING: ["VALIDATING_REVIEW", "FAILED_RECOVERABLE", "CANCELLED", "WAITING_OPERATOR"],
  VALIDATING_REVIEW: [
    "WAITING_FOR_REMEDIATION",
    "READY_FOR_REVIEW",
    "CLEAN_CONFIRMED",
    "WAITING_OPERATOR",
    "FAILED_RECOVERABLE",
    "CANCELLED",
    "READY_FOR_NEXT_CYCLE",
  ],
  WAITING_FOR_REMEDIATION: ["REMEDIATING", "WAITING_OPERATOR", "CANCELLED", "FAILED_RECOVERABLE"],
  REMEDIATING: ["VERIFYING_FIX", "FAILED_RECOVERABLE", "CANCELLED", "WAITING_OPERATOR"],
  VERIFYING_FIX: [
    "READY_FOR_NEXT_CYCLE",
    "READY_FOR_REVIEW",
    "WAITING_OPERATOR",
    "FAILED_RECOVERABLE",
    "CANCELLED",
    "STOPPED_LIMIT",
  ],
  READY_FOR_NEXT_CYCLE: ["SNAPSHOTTING", "STOPPED_LIMIT", "CANCELLED", "WAITING_OPERATOR"],
  CLEAN_CONFIRMED: [],
  WAITING_OPERATOR: ["READY_FOR_REVIEW", "SNAPSHOTTING", "REMEDIATING", "CANCELLED", "DISABLED"],
  FAILED_RECOVERABLE: ["WAITING_FOR_EXECUTOR", "SNAPSHOTTING", "READY_FOR_REVIEW", "REMEDIATING", "VERIFYING_FIX", "CANCELLED", "WAITING_OPERATOR"],
  STOPPED_LIMIT: ["WAITING_FOR_EXECUTOR", "CANCELLED"],
  CANCELLED: [],
};

export function zaicodeAuditLoopCanTransition(from: ZaicodeAuditLoopState, to: ZaicodeAuditLoopState): boolean {
  if (from === to) return true;
  return (ZAICODE_AUDIT_LOOP_TRANSITIONS[from] ?? []).includes(to);
}

/** Terminal states never advance again without an explicit new run. */
export function zaicodeAuditLoopIsTerminal(state: ZaicodeAuditLoopState): boolean {
  return state === "CLEAN_CONFIRMED" || state === "CANCELLED";
}

/** A state where the loop is waiting on something other than its own next step. */
export function zaicodeAuditLoopIsParked(state: ZaicodeAuditLoopState): boolean {
  return state === "WAITING_OPERATOR" || state === "FAILED_RECOVERABLE" || state === "STOPPED_LIMIT";
}

export function clampZaicodeAuditLoopMaxCycles(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric)) return ZAICODE_AUDIT_LOOP_MAX_CYCLES;
  return Math.max(ZAICODE_AUDIT_LOOP_MIN_CYCLES, Math.min(ZAICODE_AUDIT_LOOP_MAX_CYCLES, numeric));
}

export type ZaicodeAuditLoopReviewerMode = "self" | "external";
export type ZaicodeAuditLoopReviewerIdentity = string;

export type ZaicodeAuditFindingSeverity = "critical" | "high" | "medium" | "low";

/**
 * The disposition a finding carries after remediation and verification. It is
 * decided by the loop's verification layer from the remediation executor's own
 * reported evidence -- never merely because a job completed or a generic gate
 * passed. A finding is only closed by a disposition that PROVES closure.
 */
export const ZAICODE_AUDIT_LOOP_FINDING_DISPOSITIONS = [
  "open",
  "FIXED_VERIFIED",
  "REJECTED_WITH_EVIDENCE",
  "STILL_OPEN",
  "UNVERIFIED",
  "DEFERRED_WITH_REASON",
] as const;

export type ZaicodeAuditLoopFindingDisposition = (typeof ZAICODE_AUDIT_LOOP_FINDING_DISPOSITIONS)[number];

/** Only these two dispositions close a finding; everything else stays actionable. */
export function zaicodeAuditLoopFindingIsResolved(disposition: ZaicodeAuditLoopFindingDisposition): boolean {
  return disposition === "FIXED_VERIFIED" || disposition === "REJECTED_WITH_EVIDENCE";
}

/** One reviewer claim. A claim is never a fact and never an authorization. */
export interface ZaicodeAuditLoopFinding {
  id: string;
  severity: ZaicodeAuditFindingSeverity;
  /** File:line, or the verified component when no single file owns the defect. */
  location: string;
  evidence: string;
  expected: string;
  observed: string;
  reproduction: string;
  /** What would make this finding closed: the acceptance condition. */
  acceptance: string;
  disposition: ZaicodeAuditLoopFindingDisposition;
  /** The remediation executor's own reported evidence, preserved for review. */
  resolution?: string;
}

/** One reviewer verdict, immutable once written. */
export interface ZaicodeAuditLoopReviewReceipt {
  cycle: number;
  reviewerMode: ZaicodeAuditLoopReviewerMode;
  /** Which provider/model/agent actually produced this verdict. */
  reviewerIdentity: ZaicodeAuditLoopReviewerIdentity;
  verdict: "findings" | "clean" | "unverified";
  /** sha256 of the exact artifact the verdict was read from. */
  artifactSha256: string;
  /** Deterministic checks the reviewer ran, with their real exit codes. */
  deterministicChecks: { command: string; exitCode: number }[];
  unknowns: string[];
  requiredValidation: string[];
  remainingRisks: string[];
  stopRecommendation: string | null;
  findings: ZaicodeAuditLoopFinding[];
  receivedAt: string;
}

/** The single outstanding durable operation of a run; exactly one may exist. */
export interface ZaicodeAuditLoopPendingOperation {
  kind: "review" | "remediation" | "verification";
  /** Null while the intent is durable but the queue write has not returned. */
  jobId: string | null;
  /** Deterministic per (loop, cycle, step) so recovery adopts instead of duplicating. */
  idempotencyKey: string;
  attempt: number;
  startedAt: string;
}

export interface ZaicodeAuditLoopRun {
  schemaVersion: 1;
  loopId: string;
  /** The project this run belongs to; frozen at admission. */
  projectName: string;
  workspaceKey: string;
  workspacePath: string;
  /** The executor that finished the work being audited. Never replaced silently. */
  originalExecutor: {
    agentId: string;
    /** The exact agent session/job, when the queue still knows it. */
    jobId: string;
    sessionId: string | null;
  };
  /** The task whose completion admitted this run. */
  originalTaskId: string;
  /** The human goal this audit belongs to, so feedback can never look like new intent. */
  originalGoalId: string | null;
  /** Who the run was admitted by: an operator ingress or a runtime terminal event. */
  admission: {
    mode: "auto" | "manual";
    /** `saipen:<SRC-###>` or the host's own terminal event reference. */
    authorityRef: string | null;
    admittedAt: string;
    /** The terminal disposition that admitted it. Prose is never enough. */
    terminalDisposition: string;
  };

  state: ZaicodeAuditLoopState;
  cycle: number;
  maxCycles: number;

  reviewerMode: ZaicodeAuditLoopReviewerMode;
  /** The reviewer that actually produced the latest verdict, not the configured one. */
  activeReviewerIdentity: ZaicodeAuditLoopReviewerIdentity | null;
  /** Ordered `mode:identity` history, so a self-audit is never read as external. */
  reviewerHistory: string[];

  /** Content-based identity of the audited source: changes when bytes change. */
  sourceFingerprint: string;
  /** git HEAD at admission, when the project is a repository; informational only. */
  sourceHead: string | null;
  /** The cycle's evidence package, when the loop has written one. */
  evidence: {
    cycle: number;
    manifestFile: string;
    packageFile: string;
    digest: string;
    fileCount: number;
    excludedCount: number;
    sourceFingerprint: string;
    /** False when the bounded scan could not read the whole source (SRC-202 Phase 5). */
    coverageComplete: boolean;
    /** Why the scan was incomplete: unreadable, oversized, truncated, escaping files. */
    limitations: string[];
    writtenAt: string;
  } | null;

  /** One immutable verdict per cycle. */
  reviews: ZaicodeAuditLoopReviewReceipt[];
  /**
   * Every finding the run has not proven closed, across cycles (SRC-202 Phase 6).
   * A later clean verdict is refused while this still holds an unresolved entry.
   */
  unresolvedFindings: ZaicodeAuditLoopFinding[];
  /** Cycle -> sha256 of the open finding id set, for the no-progress guard. */
  progressFingerprints: Record<string, string>;

  pending: ZaicodeAuditLoopPendingOperation | null;
  /** The implementer job that consumed the last validated findings. */
  remediation: {
    cycle: number;
    jobId: string;
    agentId: string;
    /**
     * Whether the original executor actually received the findings, or an
     * authorized fallback did. A fallback is never described as continuation.
     */
    route: "original_executor" | "authorized_fallback";
    dispatchedAt: string;
    completedAt: string | null;
    outcome: string | null;
  } | null;
  /** The evidence that closed the last VERIFYING_FIX step. */
  lastVerification: {
    cycle: number;
    jobId: string | null;
    checks: { command: string; exitCode: number }[];
    acceptedAt: string;
    detail: string;
  } | null;

  /** Closed vocabulary: why the loop is where it is. */
  blocker: { code: string; reason: string; since: string } | null;
  /** Persisted, never reset by a crash. */
  retryBudget: number;
  /** Consecutive malformed reviewer results. */
  invalidReviewStreak: number;

  settings: {
    /** The project's automatic audit admission (the existing A3 switch). */
    autoAudits: boolean;
    /** Operator consent to transmit sanitized evidence to an EXTERNAL reviewer. */
    externalTransmissionConsent: { granted: boolean; scope: string | null; grantedAt: string | null };
    /** Fallback policy when the external reviewer is unavailable. */
    externalFallback: "self" | "none";
  };

  createdAt: string;
  updatedAt: string;
}

export interface ZaicodeAuditLoopAdmissionInput {
  loopId: string;
  projectName: string;
  workspaceKey: string;
  workspacePath: string;
  executor: { agentId: string; jobId: string; sessionId: string | null };
  taskId: string;
  goalId: string | null;
  authorityRef: string | null;
  mode: "auto" | "manual";
  terminalDisposition: string;
  sourceFingerprint: string;
  sourceHead: string | null;
  maxCycles: number;
  reviewerMode: ZaicodeAuditLoopReviewerMode;
  autoAudits: boolean;
  externalTransmissionConsent: { granted: boolean; scope: string | null; grantedAt: string | null };
  externalFallback: "self" | "none";
  now: string;
}

export function zaicodeAuditLoopNewRun(input: ZaicodeAuditLoopAdmissionInput): ZaicodeAuditLoopRun {
  return {
    schemaVersion: 1,
    loopId: input.loopId,
    projectName: input.projectName,
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    originalExecutor: { ...input.executor },
    originalTaskId: input.taskId,
    originalGoalId: input.goalId,
    admission: {
      mode: input.mode,
      authorityRef: input.authorityRef,
      admittedAt: input.now,
      terminalDisposition: input.terminalDisposition,
    },
    state: input.autoAudits ? "WAITING_FOR_EXECUTOR" : "DISABLED",
    cycle: 0,
    maxCycles: clampZaicodeAuditLoopMaxCycles(input.maxCycles),
    reviewerMode: input.reviewerMode,
    activeReviewerIdentity: null,
    reviewerHistory: [],
    sourceFingerprint: input.sourceFingerprint,
    sourceHead: input.sourceHead,
    evidence: null,
    reviews: [],
    unresolvedFindings: [],
    progressFingerprints: {},
    pending: null,
    remediation: null,
    lastVerification: null,
    blocker: null,
    retryBudget: ZAICODE_AUDIT_LOOP_RETRY_BUDGET,
    invalidReviewStreak: 0,
    settings: {
      autoAudits: input.autoAudits,
      externalTransmissionConsent: { ...input.externalTransmissionConsent },
      externalFallback: input.externalFallback,
    },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * T-283 provenance, stated where the loop's own feedback originates. An audit
 * finding is agent/runtime-originated: it must never masquerade as a new human
 * instruction and it grants no additional human authorization. It keeps the
 * original goal association so the executor can tell why the work arrived.
 */
export interface ZaicodeAuditLoopFeedbackProvenance {
  origin: "agent_runtime";
  kind: "audit_findings";
  humanAuthored: false;
  humanAuthorizationGranted: false;
  originalUserIntentId: string | null;
  loopId: string;
  cycle: number;
  sourceFingerprint: string;
}

export function zaicodeAuditLoopFeedbackProvenance(run: ZaicodeAuditLoopRun): ZaicodeAuditLoopFeedbackProvenance {
  return {
    origin: "agent_runtime",
    kind: "audit_findings",
    humanAuthored: false,
    humanAuthorizationGranted: false,
    originalUserIntentId: run.originalGoalId,
    loopId: run.loopId,
    cycle: run.cycle,
    sourceFingerprint: run.sourceFingerprint,
  };
}

/** The disposition of a finding, applied only by the executor -- never by the reviewer. */
export function zaicodeAuditLoopOpenFindings(run: ZaicodeAuditLoopRun): ZaicodeAuditLoopFinding[] {
  const latest = run.reviews[run.reviews.length - 1];
  if (!latest) return [];
  return latest.findings.filter((finding) => !zaicodeAuditLoopFindingIsResolved(finding.disposition));
}

/**
 * Every finding the run has not proven closed yet, across cycles. A finding
 * reported in cycle 0 and never verified stays here, so a later clean verdict
 * cannot silently drop it.
 */
export function zaicodeAuditLoopUnresolvedFindings(run: ZaicodeAuditLoopRun): ZaicodeAuditLoopFinding[] {
  return run.unresolvedFindings.filter((finding) => !zaicodeAuditLoopFindingIsResolved(finding.disposition));
}

/** Fold a cycle's review findings into the run's unresolved ledger, keyed by stable id. */
export function zaicodeAuditLoopMergeFindings(
  ledger: readonly ZaicodeAuditLoopFinding[],
  incoming: readonly ZaicodeAuditLoopFinding[],
): ZaicodeAuditLoopFinding[] {
  const byId = new Map(ledger.map((finding) => [finding.id, finding]));
  for (const finding of incoming) {
    // A re-reported finding reopens: the reviewer observed it again, so a prior
    // FIXED_VERIFIED no longer holds for the current source.
    byId.set(finding.id, { ...finding, disposition: "open", resolution: undefined });
  }
  return [...byId.values()];
}

/**
 * A finding id is derived from where and what it is, so the same defect
 * re-reported in a later cycle keeps its identity and the no-progress guard can
 * see that nothing moved.
 */
export function zaicodeAuditLoopFindingId(input: {
  severity: string;
  location: string;
  observed: string;
}): string {
  const canonical = `${input.severity.trim().toLowerCase()}|${input.location.trim().toLowerCase()}|${input.observed.trim().toLowerCase().replace(/\s+/g, " ")}`;
  // FNV-1a offset basis: written as a BigInt literal so the exact value is not
  // rounded at parse time; it is folded to a Number exactly once, as before.
  let hash = Number(0xcbf29ce484222325n);
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x100000001b3);
  }
  return `F-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** The same identity set, for a receipt that is not yet attached to the run. */
export function zaicodeAuditLoopFindingsFingerprintFor(findings: readonly ZaicodeAuditLoopFinding[]): string {
  const canonical = findings
    .filter((finding) => !zaicodeAuditLoopFindingIsResolved(finding.disposition))
    .map((finding) => finding.id)
    .sort()
    .join(",");
  let hash = Number(0xcbf29ce484222325n);
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x100000001b3);
  }
  return `fnv1a64:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** The open-finding identity set, sorted, so two cycles are comparable. */
export function zaicodeAuditLoopProgressFingerprint(run: ZaicodeAuditLoopRun): string {
  const ids = zaicodeAuditLoopUnresolvedFindings(run).map((finding) => finding.id).sort();
  let hash = Number(0xcbf29ce484222325n);
  const canonical = ids.join(",");
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x100000001b3);
  }
  return `fnv1a64:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Structured reviewer result
// ---------------------------------------------------------------------------

/**
 * Markers the reviewer artifact must carry. Plain JSON with explicit fences
 * rather than a fenced ```json block on purpose: a fenced block is common in
 * prose, so the boundary would not be the artifact's own statement.
 */
export const ZAICODE_AUDIT_LOOP_REVIEW_BEGIN = "AUDIT_LOOP_REVIEW_BEGIN";
export const ZAICODE_AUDIT_LOOP_REVIEW_END = "AUDIT_LOOP_REVIEW_END";
export const ZAICODE_AUDIT_LOOP_REVIEW_TERMINAL_LINE = "STATUS: AUDIT_LOOP_REVIEW: COMPLETE";

export type ZaicodeAuditReviewRejectReason =
  | "empty"
  | "missing-terminal-line"
  | "terminal-line-not-last"
  | "missing-structured-block"
  | "unparseable-structured-block"
  | "malformed-verdict"
  | "finding-missing-field"
  | "finding-bad-severity"
  | "clean-without-deterministic-checks"
  | "clean-with-failing-check"
  | "clean-with-open-questions";

export type ZaicodeAuditReviewParse =
  | { ok: true; verdict: "findings" | "clean"; findings: ZaicodeAuditLoopFinding[]; payload: ParsedReviewPayload }
  | { ok: false; reason: ZaicodeAuditReviewRejectReason; detail: string };

interface ParsedReviewPayload {
  verdict: string;
  findings: unknown[];
  deterministicChecks: { command: string; exitCode: number }[];
  unknowns: string[];
  requiredValidation: string[];
  remainingRisks: string[];
  stopRecommendation: string | null;
}

const SEVERITIES: readonly ZaicodeAuditFindingSeverity[] = ["critical", "high", "medium", "low"];
const FINDING_FIELDS = ["severity", "location", "evidence", "expected", "observed", "reproduction", "acceptance"] as const;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function asChecks(value: unknown): { command: string; exitCode: number }[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const checks: { command: string; exitCode: number }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : Number(record.exitCode);
    if (!command || !Number.isInteger(exitCode)) return null;
    checks.push({ command, exitCode });
  }
  return checks;
}

function extractBlock(text: string): string | null {
  const begin = text.indexOf(ZAICODE_AUDIT_LOOP_REVIEW_BEGIN);
  const end = text.indexOf(ZAICODE_AUDIT_LOOP_REVIEW_END);
  if (begin < 0 || end < 0 || end <= begin) return null;
  return text.slice(begin + ZAICODE_AUDIT_LOOP_REVIEW_BEGIN.length, end).trim();
}

/**
 * Read one reviewer artifact. It never repairs: a missing terminal line or a
 * malformed finding is a rejection with a reason, and clean demands real
 * deterministic evidence with passing exit codes.
 */
export function normalizeZaicodeAuditReview(text: string): ZaicodeAuditReviewParse {
  const reject = (reason: ZaicodeAuditReviewRejectReason, detail: string): ZaicodeAuditReviewParse => ({
    ok: false,
    reason,
    detail,
  });
  if (!text || !text.trim()) return reject("empty", "the review artifact is empty");

  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  if (!trimmed.includes(ZAICODE_AUDIT_LOOP_REVIEW_TERMINAL_LINE)) {
    return reject("missing-terminal-line", `the review artifact does not contain "${ZAICODE_AUDIT_LOOP_REVIEW_TERMINAL_LINE}"`);
  }
  const lastMeaningful = [...lines].reverse().find((line) => line.length > 0) ?? "";
  if (lastMeaningful !== ZAICODE_AUDIT_LOOP_REVIEW_TERMINAL_LINE) {
    return reject("terminal-line-not-last", "the terminal line is present but is not the last line of the artifact");
  }

  const block = extractBlock(trimmed);
  if (block === null) {
    return reject(
      "missing-structured-block",
      `the artifact has no ${ZAICODE_AUDIT_LOOP_REVIEW_BEGIN} / ${ZAICODE_AUDIT_LOOP_REVIEW_END} block`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return reject("unparseable-structured-block", `the structured block is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject("unparseable-structured-block", "the structured block is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const verdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
  if (verdict !== "findings" && verdict !== "clean" && verdict !== "unverified") {
    return reject("malformed-verdict", `verdict must be one of clean|findings|unverified, got "${String(record.verdict)}"`);
  }
  const checks = asChecks(record.deterministicChecks);
  if (checks === null) return reject("clean-without-deterministic-checks", "deterministicChecks must be a list of {command, exitCode}");
  const unknowns = asStringArray(record.unknowns);
  const requiredValidation = asStringArray(record.requiredValidation);
  const remainingRisks = asStringArray(record.remainingRisks);
  const stopRecommendation =
    typeof record.stopRecommendation === "string" && record.stopRecommendation.trim()
      ? record.stopRecommendation.trim()
      : null;

  const findings: ZaicodeAuditLoopFinding[] = [];
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  if (verdict === "findings" && rawFindings.length === 0) {
    return reject("malformed-verdict", "verdict findings requires at least one finding");
  }
  for (const entry of rawFindings) {
    if (!entry || typeof entry !== "object") return reject("finding-missing-field", "a finding is not an object");
    const finding = entry as Record<string, unknown>;
    for (const field of FINDING_FIELDS) {
      const value = finding[field];
      if (typeof value !== "string" || !value.trim()) {
        return reject("finding-missing-field", `a finding is missing the required field ${field}`);
      }
    }
    const severity = String(finding.severity).trim().toLowerCase() as ZaicodeAuditFindingSeverity;
    if (!SEVERITIES.includes(severity)) {
      return reject("finding-bad-severity", `severity must be one of ${SEVERITIES.join("|")}, got "${String(finding.severity)}"`);
    }
    const location = String(finding.location).trim();
    const observed = String(finding.observed).trim();
    findings.push({
      id: typeof finding.id === "string" && finding.id.trim() ? finding.id.trim() : zaicodeAuditLoopFindingId({ severity, location, observed }),
      severity,
      location,
      evidence: String(finding.evidence).trim(),
      expected: String(finding.expected).trim(),
      observed,
      reproduction: String(finding.reproduction).trim(),
      acceptance: String(finding.acceptance).trim(),
      disposition: "open",
    });
  }

  if (verdict === "clean") {
    // Clean prose is not clean work: a clean verdict has to carry its own
    // deterministic evidence, and every one of those checks has to have passed.
    if (checks.length === 0) {
      return reject("clean-without-deterministic-checks", "a clean verdict must carry at least one deterministic check with its real exit code");
    }
    const failing = checks.filter((check) => check.exitCode !== 0);
    if (failing.length > 0) {
      return reject("clean-with-failing-check", `a clean verdict carries a failing check: ${failing[0]!.command} exited ${failing[0]!.exitCode}`);
    }
    if (unknowns.length > 0 || requiredValidation.length > 0) {
      return reject("clean-with-open-questions", "a clean verdict cannot carry unresolved unknowns or required validation");
    }
  }

  return {
    ok: true,
    verdict: verdict === "clean" ? "clean" : "findings",
    findings,
    payload: {
      verdict,
      findings: rawFindings,
      deterministicChecks: checks,
      unknowns,
      requiredValidation,
      remainingRisks,
      stopRecommendation,
    },
  };
}

/** What a `unverified` verdict looks like once normalized: a bounded, non-advancing result. */
export function zaicodeAuditReviewIsUnverified(text: string): boolean {
  const block = extractBlock(text ?? "");
  if (block === null) return false;
  try {
    const parsed = JSON.parse(block) as { verdict?: unknown };
    return typeof parsed.verdict === "string" && parsed.verdict.trim().toLowerCase() === "unverified";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Structured remediation report (finding-level verification)
// ---------------------------------------------------------------------------

/**
 * The remediation executor's own per-finding report. It is the ONLY input to
 * finding-level verification besides the deterministic gates: a completed job
 * with no report leaves every finding STILL_OPEN, and a report entry claiming a
 * fix without evidence is UNVERIFIED. Neither closes a finding.
 */
export const ZAICODE_AUDIT_LOOP_FIX_BEGIN = "AUDIT_LOOP_FIX_BEGIN";
export const ZAICODE_AUDIT_LOOP_FIX_END = "AUDIT_LOOP_FIX_END";
export const ZAICODE_AUDIT_LOOP_FIX_TERMINAL_LINE = "STATUS: AUDIT_LOOP_FIX: COMPLETE";
/** The identity line the loop stamps into the remediation prompt and expects back. */
export const ZAICODE_AUDIT_LOOP_FIX_IDENTITY_PREFIX = "AUDIT_LOOP_FIX_IDENTITY:";

export type ZaicodeAuditLoopFixClaim = "fixed" | "rejected" | "deferred";

export interface ZaicodeAuditLoopFixEntry {
  id: string;
  claim: ZaicodeAuditLoopFixClaim;
  /** What the executor actually did or observed; empty means no proof. */
  evidence: string;
  /** A deterministic command the executor ran, when there is one. */
  command?: string;
  /** Its real exit code; a non-zero code cannot support a `fixed` claim. */
  exitCode?: number;
}

export interface ZaicodeAuditLoopFixReport {
  entries: ZaicodeAuditLoopFixEntry[];
  /** Findings the reviewer reported that the fix report did not mention at all. */
  unreported: string[];
}

/** Read one remediation report; an unparseable report yields no entries, never a guess. */
export function normalizeZaicodeAuditLoopFixReport(
  text: string,
  expectedFindingIds: readonly string[],
): { ok: true; report: ZaicodeAuditLoopFixReport } | { ok: false; reason: string; report: ZaicodeAuditLoopFixReport } {
  const empty: ZaicodeAuditLoopFixReport = { entries: [], unreported: [...expectedFindingIds] };
  if (!text || !text.trim()) return { ok: false, reason: "the remediation report is empty", report: empty };
  const trimmed = text.trim();
  if (!trimmed.includes(ZAICODE_AUDIT_LOOP_FIX_TERMINAL_LINE)) {
    return { ok: false, reason: `the report does not end with "${ZAICODE_AUDIT_LOOP_FIX_TERMINAL_LINE}"`, report: empty };
  }
  const begin = trimmed.indexOf(ZAICODE_AUDIT_LOOP_FIX_BEGIN);
  const end = trimmed.indexOf(ZAICODE_AUDIT_LOOP_FIX_END);
  if (begin < 0 || end < 0 || end <= begin) {
    return { ok: false, reason: "the report has no AUDIT_LOOP_FIX_BEGIN / AUDIT_LOOP_FIX_END block", report: empty };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(begin + ZAICODE_AUDIT_LOOP_FIX_BEGIN.length, end).trim());
  } catch (error) {
    return { ok: false, reason: `the report block is not JSON: ${error instanceof Error ? error.message : String(error)}`, report: empty };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "the report block is not a JSON object", report: empty };
  }
  const raw = (parsed as Record<string, unknown>).findings;
  const list = Array.isArray(raw) ? raw : [];
  const entries: ZaicodeAuditLoopFixEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const claim = typeof record.claim === "string" ? record.claim.trim().toLowerCase() : "";
    if (!id || (claim !== "fixed" && claim !== "rejected" && claim !== "deferred")) continue;
    const entry: ZaicodeAuditLoopFixEntry = {
      id,
      claim,
      evidence: typeof record.evidence === "string" ? record.evidence.trim() : "",
    };
    if (typeof record.command === "string" && record.command.trim()) entry.command = record.command.trim();
    if (typeof record.exitCode === "number" && Number.isInteger(record.exitCode)) entry.exitCode = record.exitCode;
    entries.push(entry);
  }
  const reported = new Set(entries.map((entry) => entry.id));
  return {
    ok: true,
    report: { entries, unreported: expectedFindingIds.filter((id) => !reported.has(id)) },
  };
}

/**
 * The verification layer's own decision for one finding. It converts a
 * remediation CLAIM into a disposition, and it is deliberately conservative: a
 * fix without evidence, or with a failed command, is UNVERIFIED, not closed.
 */
export function zaicodeAuditLoopVerifyFindingClaim(
  finding: ZaicodeAuditLoopFinding,
  entry: ZaicodeAuditLoopFixEntry | undefined,
): ZaicodeAuditLoopFindingDisposition {
  if (!entry) return "STILL_OPEN";
  if (!entry.evidence) return "UNVERIFIED";
  if (entry.command && entry.exitCode !== 0) return "UNVERIFIED";
  switch (entry.claim) {
    case "fixed":
      // A fix is proven by evidence the executor actually produced; a bare
      // assertion is not.
      return entry.exitCode === 0 || !entry.command ? "FIXED_VERIFIED" : "UNVERIFIED";
    case "rejected":
      return "REJECTED_WITH_EVIDENCE";
    case "deferred":
      return "DEFERRED_WITH_REASON";
    default:
      return "UNVERIFIED";
  }
}

// ---------------------------------------------------------------------------
// Stop policy and gates
// ---------------------------------------------------------------------------

export type ZaicodeAuditLoopStopCode =
  | "CYCLE_LIMIT"
  | "NO_PROGRESS"
  | "REVIEWER_INVALID"
  | "OPERATOR_DECISION"
  | "RETRY_EXHAUSTED";

export interface ZaicodeAuditLoopStopDecision {
  stop: boolean;
  state: ZaicodeAuditLoopState | null;
  code: ZaicodeAuditLoopStopCode | null;
  reason: string | null;
}

const CONTINUE: ZaicodeAuditLoopStopDecision = { stop: false, state: null, code: null, reason: null };

/**
 * The one place that decides whether the loop may take another cycle. A crash
 * cannot reset any of it because every input is persisted on the run.
 */
export function zaicodeAuditLoopStopDecision(run: ZaicodeAuditLoopRun): ZaicodeAuditLoopStopDecision {
  if (zaicodeAuditLoopIsTerminal(run.state)) return CONTINUE;
  if (run.invalidReviewStreak >= ZAICODE_AUDIT_LOOP_INVALID_REVIEW_LIMIT) {
    return {
      stop: true,
      state: "WAITING_OPERATOR",
      code: "REVIEWER_INVALID",
      reason: `${run.invalidReviewStreak} consecutive reviewer results were malformed`,
    };
  }
  if (run.retryBudget <= 0) {
    return {
      stop: true,
      state: "FAILED_RECOVERABLE",
      code: "RETRY_EXHAUSTED",
      reason: "the step retry budget is exhausted; nothing more is attempted automatically",
    };
  }
  const historyKeys = Object.keys(run.progressFingerprints).sort((a, b) => Number(a) - Number(b));
  if (historyKeys.length >= ZAICODE_AUDIT_LOOP_NO_PROGRESS_CYCLES) {
    const tail = historyKeys.slice(-ZAICODE_AUDIT_LOOP_NO_PROGRESS_CYCLES).map((key) => run.progressFingerprints[key]!);
    if (tail.length === ZAICODE_AUDIT_LOOP_NO_PROGRESS_CYCLES && tail.every((value) => value === tail[0] && value.length > 0)) {
      return {
        stop: true,
        state: "WAITING_OPERATOR",
        code: "NO_PROGRESS",
        reason: `${ZAICODE_AUDIT_LOOP_NO_PROGRESS_CYCLES} consecutive cycles reported exactly the same open findings`,
      };
    }
  }
  if (run.cycle >= run.maxCycles) {
    return {
      stop: true,
      state: "STOPPED_LIMIT",
      code: "CYCLE_LIMIT",
      reason: `the configured maximum of ${run.maxCycles} cycles is reached`,
    };
  }
  return CONTINUE;
}

export interface ZaicodeAuditLoopCleanGateInput {
  run: ZaicodeAuditLoopRun;
  /** The reviewer's own verdict for the cycle being closed. */
  review: ZaicodeAuditLoopReviewReceipt;
  /** Deterministic gates the orchestrator itself ran, with real exit codes. */
  gates: { command: string; exitCode: number }[];
  /** The source fingerprint observed when the review was requested. */
  reviewedSourceFingerprint: string;
}

/**
 * CLEAN_CONFIRMED is a gate, not a compliment. All of it must hold: a clean
 * verdict, no unresolved actionable finding, passing deterministic tests, no
 * unresolved mandatory safety gate, and no source/evidence identity drift.
 */
export function zaicodeAuditLoopCleanConfirmed(input: ZaicodeAuditLoopCleanGateInput): { confirmed: boolean; reason: string } {
  const { run, review, gates } = input;
  if (review.verdict !== "clean") return { confirmed: false, reason: `the cycle verdict is ${review.verdict}, not clean` };
  // Findings reported in ANY cycle that were never proven closed keep the loop
  // open: a clean verdict about the current source does not retract an earlier
  // finding that is still unresolved.
  const unresolved = zaicodeAuditLoopUnresolvedFindings(run);
  if (unresolved.length > 0) {
    return { confirmed: false, reason: `${unresolved.length} finding(s) from earlier cycles are still unresolved: ${unresolved.map((finding) => finding.id).join(", ")}` };
  }
  const cycleUnresolved = review.findings.filter((finding) => !zaicodeAuditLoopFindingIsResolved(finding.disposition));
  if (cycleUnresolved.length > 0) {
    return { confirmed: false, reason: `${cycleUnresolved.length} validated finding(s) are still unresolved` };
  }
  if (run.evidence && !run.evidence.coverageComplete) {
    // An incomplete source scan cannot prove a clean tree.
    return { confirmed: false, reason: `the evidence scan was incomplete: ${run.evidence.limitations.join("; ") || "coverage not proven"}` };
  }
  if (gates.length === 0) return { confirmed: false, reason: "no deterministic acceptance gate was run for this cycle" };
  const failing = gates.filter((gate) => gate.exitCode !== 0);
  if (failing.length > 0) {
    return { confirmed: false, reason: `acceptance gate failed: ${failing[0]!.command} exited ${failing[0]!.exitCode}` };
  }
  if (review.unknowns.length > 0 || review.requiredValidation.length > 0) {
    return { confirmed: false, reason: "the clean verdict still carries unknowns or required validation" };
  }
  if (input.reviewedSourceFingerprint !== run.sourceFingerprint) {
    return {
      confirmed: false,
      reason: `the source changed during the audit (reviewed ${input.reviewedSourceFingerprint}, now ${run.sourceFingerprint})`,
    };
  }
  if (run.blocker) return { confirmed: false, reason: `an unresolved blocker remains: ${run.blocker.code}` };
  return { confirmed: true, reason: "a clean validated verdict, passing gates and an unchanged source identity" };
}

/** A step may advance only when the loop is not parked and the step is not already outstanding. */
export function zaicodeAuditLoopMayDispatch(run: ZaicodeAuditLoopRun, kind: ZaicodeAuditLoopPendingOperation["kind"]): boolean {
  if (zaicodeAuditLoopIsTerminal(run.state)) return false;
  if (run.pending && run.pending.kind === kind && run.pending.jobId) return false;
  return true;
}

/** One-line operator summary; the Audit Center renders richer detail from the same run. */
export function describeZaicodeAuditLoopState(state: ZaicodeAuditLoopState): string {
  switch (state) {
    case "DISABLED":
      return "automatic auditing is off for this project";
    case "WAITING_FOR_EXECUTOR":
      return "waiting for a terminal executor completion";
    case "SNAPSHOTTING":
      return "building the sanitized evidence package";
    case "READY_FOR_REVIEW":
      return "evidence is ready and no reviewer has been dispatched";
    case "REVIEWING":
      return "the reviewer is working the evidence";
    case "VALIDATING_REVIEW":
      return "reading the reviewer's structured result";
    case "WAITING_FOR_REMEDIATION":
      return "findings are validated and no fix has been dispatched";
    case "REMEDIATING":
      return "the original executor is working the findings";
    case "VERIFYING_FIX":
      return "checking the fix against the recorded evidence";
    case "READY_FOR_NEXT_CYCLE":
      return "the fix verified; the next cycle has not started";
    case "CLEAN_CONFIRMED":
      return "clean, verified and closed";
    case "WAITING_OPERATOR":
      return "stopped for a human decision";
    case "FAILED_RECOVERABLE":
      return "a step failed; the durable state is preserved for recovery";
    case "STOPPED_LIMIT":
      return "the configured cycle limit is reached";
    case "CANCELLED":
      return "cancelled";
    default:
      return state;
  }
}
