/**
 * Drift capture truth contract.
 *
 * The capture center must never turn a failed discovery or a missing/corrupt
 * evidence file into a green "saved" badge. These pure resolvers keep that
 * decision out of the React layer so it can be tested directly.
 */

export type DriftProjectDiscoveryState =
  | "EMPTY_PROJECT"
  | "DISCOVERY_SUCCESS"
  | "DISCOVERY_FAILED"
  | "DISCOVERY_PARTIAL"
  | "HOST_UNAVAILABLE";

export interface DriftProjectRef {
  path: string;
  identity?: string;
  name?: string;
}

export interface DriftProjectDiscoveryReceipt {
  projectPath: string;
  projectIdentity?: string;
  projectName: string;
  status: DriftProjectDiscoveryState;
  discoveredSessions: number;
  rejectedSessions: number;
  /** Sessions left out by policy (helper sessions); never counted as a failure. */
  skippedSessions: number;
  error?: string;
}

/** A project that was deliberately left out of the capture by a settings policy. */
export interface DriftProjectSkip {
  projectPath: string;
  projectName: string;
  reason: "project-disabled";
}

export interface DriftDiscoverySummary {
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  receipts: readonly DriftProjectDiscoveryReceipt[];
  selectedProjects: readonly string[];
  totalSessions: number;
  failedProjects: number;
  partialProjects: number;
  emptyProjects: number;
  /** Projects excluded by policy: not a failure, and they do not break COMPLETE. */
  skippedProjects: readonly DriftProjectSkip[];
}

const HOST_UNAVAILABLE_PATTERN =
  /(?:host|service|provider)[^\n]{0,40}(?:unavailable|not available|disconnected|not connected)|ECONNREFUSED|ENOTCONN|EHOSTUNREACH|channel\s+closed|rpc\s+disconnected/i;

export function isHostUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  return HOST_UNAVAILABLE_PATTERN.test(message);
}

export function classifyProjectDiscovery(input: {
  project: DriftProjectRef;
  sessions?: readonly unknown[] | null;
  rejectedSessions?: number;
  /** Sessions excluded by policy (helper sessions). Not a failure. */
  skippedSessions?: number;
  error?: unknown;
}): DriftProjectDiscoveryReceipt {
  const base = {
    projectPath: input.project.path,
    projectIdentity: input.project.identity,
    projectName: input.project.name || input.project.path,
  };
  if (input.error !== undefined) {
    return {
      ...base,
      status: isHostUnavailableError(input.error) ? "HOST_UNAVAILABLE" : "DISCOVERY_FAILED",
      discoveredSessions: 0,
      rejectedSessions: 0,
      skippedSessions: 0,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    };
  }
  const sessions = input.sessions ?? [];
  const rejected = Math.max(0, input.rejectedSessions ?? 0);
  const skipped = Math.max(0, Math.min(input.skippedSessions ?? 0, sessions.length));
  const discovered = sessions.length - skipped;
  if (discovered === 0 && rejected === 0) {
    return {
      ...base,
      status: "EMPTY_PROJECT",
      discoveredSessions: 0,
      rejectedSessions: 0,
      skippedSessions: skipped,
    };
  }
  if (discovered === 0) {
    return {
      ...base,
      status: "DISCOVERY_PARTIAL",
      discoveredSessions: 0,
      rejectedSessions: rejected,
      skippedSessions: skipped,
      error: `${rejected} session(s) could not be read`,
    };
  }
  return {
    ...base,
    status: rejected > 0 ? "DISCOVERY_PARTIAL" : "DISCOVERY_SUCCESS",
    discoveredSessions: discovered,
    rejectedSessions: rejected,
    skippedSessions: skipped,
    ...(rejected > 0 ? { error: `${rejected} session(s) could not be read` } : {}),
  };
}

export function summarizeDiscovery(
  receipts: readonly DriftProjectDiscoveryReceipt[],
  skippedProjects: readonly DriftProjectSkip[] = [],
): DriftDiscoverySummary {
  const failedProjects = receipts.filter(
    (r) => r.status === "DISCOVERY_FAILED" || r.status === "HOST_UNAVAILABLE",
  ).length;
  const partialProjects = receipts.filter((r) => r.status === "DISCOVERY_PARTIAL").length;
  const emptyProjects = receipts.filter((r) => r.status === "EMPTY_PROJECT").length;
  const totalSessions = receipts.reduce((sum, r) => sum + r.discoveredSessions, 0);
  // A single failed required project invalidates COMPLETE: partial evidence
  // cannot be presented as a full capture.
  const status =
    receipts.length > 0 && failedProjects === receipts.length
      ? "FAILED"
      : failedProjects > 0 || partialProjects > 0
        ? "PARTIAL"
        : "COMPLETE";
  return {
    status,
    receipts,
    selectedProjects: receipts.map((r) => r.projectPath),
    totalSessions,
    failedProjects,
    partialProjects,
    emptyProjects,
    skippedProjects,
  };
}

/** Protocol session kinds that an agent spawned, not the operator's own session. */
export const DRIFT_HELPER_SESSION_KINDS = [
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;

export interface DriftSessionScope {
  sessionId: string;
  sessionKind?: string;
}

/**
 * A helper session is an agent-spawned child session, or any session of a
 * project other than that project's MAIN ("iron slot") session. When the MAIN
 * session is unknown only the protocol child kinds count as helpers.
 */
export function isHelperDriftSession(
  session: DriftSessionScope,
  mainSessionId?: string,
): boolean {
  const kind = session.sessionKind?.trim();
  if (kind && (DRIFT_HELPER_SESSION_KINDS as readonly string[]).includes(kind)) return true;
  const main = mainSessionId?.trim();
  if (!main) return false;
  return session.sessionId !== main;
}

export type DriftEvidenceState =
  | "NOT_CAPTURED"
  | "CAPTURING"
  | "SAVED_VERIFIED"
  | "SAVED_WITH_NEW_ACTIVITY"
  | "FILE_MISSING"
  | "INTEGRITY_FAILED"
  | "CAPTURE_FAILED"
  /** Persisted by an older build that never recorded a filesystem check. */
  | "UNVERIFIED";

export interface DriftEvidenceFacts {
  capturing: boolean;
  receipt?: {
    sha256?: string;
    captureFailed?: boolean;
    verification?: DriftEvidenceState;
    watermarkUpdatedAt?: number;
  };
  file?: { exists: boolean; sha256?: string };
  sessionUpdatedAt?: number;
}

export function resolveDriftEvidenceState(facts: DriftEvidenceFacts): DriftEvidenceState {
  if (facts.capturing) return "CAPTURING";
  const receipt = facts.receipt;
  if (!receipt) return "NOT_CAPTURED";
  if (receipt.captureFailed) return "CAPTURE_FAILED";
  if (receipt.verification === "UNVERIFIED") return "UNVERIFIED";
  if (!facts.file || !facts.file.exists) return "FILE_MISSING";
  if (!facts.file.sha256 || !receipt.sha256 || facts.file.sha256 !== receipt.sha256)
    return "INTEGRITY_FAILED";
  if (
    facts.sessionUpdatedAt !== undefined &&
    receipt.watermarkUpdatedAt !== undefined &&
    facts.sessionUpdatedAt > receipt.watermarkUpdatedAt
  )
    return "SAVED_WITH_NEW_ACTIVITY";
  return "SAVED_VERIFIED";
}

export function isVerifiedDriftState(state: DriftEvidenceState): boolean {
  return state === "SAVED_VERIFIED" || state === "SAVED_WITH_NEW_ACTIVITY";
}

export interface DriftReceiptLike {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  verification?: DriftEvidenceState;
  captureFailed?: boolean;
}

export interface DriftProjectTotals {
  projectKey: string;
  sessions: number;
  verified: number;
  changed: number;
  failed: number;
  unverified: number;
}

/**
 * Per-project sidebar totals. `failed` covers missing, corrupt and failed
 * captures; an unverified legacy receipt is counted separately so it never
 * inflates either the verified or the failed column.
 */
export function summarizeProjectTotals(
  receipts: readonly DriftReceiptLike[],
): DriftProjectTotals[] {
  const byProject = new Map<string, DriftProjectTotals>();
  for (const receipt of receipts) {
    const projectKey = (receipt.workspaceIdentity ?? receipt.workspacePath).toLowerCase();
    const totals = byProject.get(projectKey) ?? {
      projectKey,
      sessions: 0,
      verified: 0,
      changed: 0,
      failed: 0,
      unverified: 0,
    };
    totals.sessions += 1;
    const state = receipt.captureFailed ? "CAPTURE_FAILED" : (receipt.verification ?? "UNVERIFIED");
    if (state === "SAVED_VERIFIED") totals.verified += 1;
    else if (state === "SAVED_WITH_NEW_ACTIVITY") totals.changed += 1;
    else if (state === "UNVERIFIED") totals.unverified += 1;
    else if (state !== "CAPTURING" && state !== "NOT_CAPTURED") totals.failed += 1;
    byProject.set(projectKey, totals);
  }
  return [...byProject.values()].sort((a, b) => a.projectKey.localeCompare(b.projectKey));
}

/** Split sessions into bounded parts by evidence size; never emit an empty part. */
export function partitionSessionsForParts<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  maxPartBytes: number,
): T[][] {
  const limit = Math.max(1, Math.trunc(maxPartBytes));
  const parts: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = Math.max(0, Math.trunc(sizeOf(item)));
    if (current.length > 0 && currentBytes + size > limit) {
      parts.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    "[REDACTED_TOKEN]",
  ],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{10,}/g, "$1 [REDACTED]"],
  [
    /\b(api[_-]?key|secret|token|password|passwd|authorization)(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
];

/** Best-effort credential scrub for exported copies. Never applied in place. */
export function redactSecrets(text: string): string {
  let output = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * A storage destination must be an absolute path. An empty value means "the
 * default vault next to the workspace", which is chosen explicitly at capture
 * time; a relative path is refused instead of silently resolving somewhere
 * else after an I/O failure.
 */
export function validateDriftStorageRoot(value: string): { ok: boolean; reason?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return { ok: true };
  if (trimmed.startsWith("\\\\")) return { ok: true };
  if (trimmed.startsWith("/")) return { ok: true };
  return {
    ok: false,
    reason: "Use an absolute path (C:\\vault, \\\\server\\share or /vault).",
  };
}

/**
 * A receipt is retired only when every evidence file behind it is really gone
 * from disk. A failed delete keeps the marker, so the operator still sees the
 * archive and can retry instead of losing the pointer to live evidence.
 */
export function driftReceiptRetirement(
  entries: readonly { paths: readonly string[] }[],
  result: { deleted: readonly string[]; missing: readonly string[] },
): { retired: readonly boolean[]; retiredCount: number; keptCount: number } {
  const gone = new Set([...result.deleted, ...result.missing]);
  const retired = entries.map(
    (entry) => entry.paths.length === 0 || entry.paths.every((value) => gone.has(value)),
  );
  const retiredCount = retired.filter(Boolean).length;
  return { retired, retiredCount, keptCount: entries.length - retiredCount };
}
