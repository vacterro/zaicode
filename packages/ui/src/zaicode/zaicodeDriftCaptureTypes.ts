import type { IFileService, IZCodeSessionService } from "@zcode/services";
import type { SessionDriftEvidence } from "./zaicodeSessionDriftFormat.js";
import type { DriftEvidenceState } from "./zaicodeDriftCaptureContract.js";
import type { DriftCaptureMetrics } from "./zaicodeDriftCaptureMetrics.js";
import type { CaptureFiles, PackFiles } from "./zaicodeDriftCaptureSupport.js";

/**
 * Shared types for the drift capture center.
 *
 * Kept apart from the implementation modules so the capture batch, the review
 * pack exporter and the tests agree on one vocabulary.
 */

export interface SessionDriftCaptureResult {
  projectId: string;
  projectPath: string;
  sessionId: string;
  outputPath: string;
  messages: number;
  characters: number;
  sha256?: string;
  skipped?: boolean;
  error?: string;
  state?: "COMMITTED" | "UNCHANGED" | "STAGED" | "CAPTURE_FAILED";
}

export interface CaptureAllSessionDriftParams {
  fileService: CaptureFiles;
  sessionService: Pick<IZCodeSessionService, "listSessions" | "readSession">;
  vaultRoot: string;
  concurrency?: number;
  skipUnchanged?: boolean;
  forceRecapture?: boolean;
  includeProtocolContext?: boolean;
  includeHistorical?: boolean;
  /** Capture agent-spawned helper sessions too (default: on). */
  includeHelperSessions?: boolean;
  /** Capture projects that were switched off in the sidebar (default: on). */
  includeDisabledProjects?: boolean;
  /** Keep the attachment reference block in the evidence text (default: on). */
  captureAttachmentsByReference?: boolean;
  /** MAIN ("iron slot") session id per project key, to tell helpers apart. */
  mainSessionIds?: Readonly<Record<string, string>>;
  /** Resume an interrupted batch instead of starting a new one. */
  resumeBatchId?: string;
  /** Window identity; defaults to a per-window random id. */
  ownerId?: string;
  leaseStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Test seam for the double-acquire confirmation delay. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  app?: SessionDriftEvidence["app"];
  onProgress?: (done: number, total: number, current?: string) => void;
}

export interface DriftCaptureBatchSummary {
  batchId: string;
  batchDir: string;
  discovery: import("./zaicodeDriftCaptureContract.js").DriftDiscoverySummary;
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  total: number;
  committed: number;
  skipped: number;
  failed: number;
  results: readonly SessionDriftCaptureResult[];
  /** What the run cost: bytes, throughput, renderer long tasks, input latency. */
  metrics: DriftCaptureMetrics;
}

export interface DriftPackAttachment {
  /** Path of the copy inside the pack, relative to the pack folder. */
  name: string;
  sha256?: string;
  size?: number;
  /** Why there is no copy: the bytes stay in the source session. */
  note?: string;
}

/**
 * How the evidence copy in the pack relates to the vault bytes.
 *
 * `SCANNED_UNCHANGED` is not the same as `DISABLED`: the first proves the scan
 * ran and found nothing, the second says nobody looked.
 */
export type DriftPackRedactionState =
  | "REDACTED"
  | "SCANNED_UNCHANGED"
  | "UNREDACTED_AUTHORIZED"
  | "DISABLED";

/** Why a verified source never reached the pack. */
export type DriftPackExclusionReason = "REDACTION_FAILED" | "REDACTION_SKIPPED_OVERSIZE";

export interface DriftReviewPackRedactionPolicy {
  requested: boolean;
  mode: "pattern-scan" | "disabled";
  maxScannedBytes: number;
  /** What happens to a source that cannot be scanned. */
  unscannedCopies: "excluded" | "operator-authorized";
}

export interface DriftReviewPackSession {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  capturedAt: string;
  messages: number;
  characters: number;
  sourceSha256: string;
  sha256: string;
  size: number;
  evidence: string;
  metadata?: string;
  redaction: DriftPackRedactionState;
  verification: DriftEvidenceState;
  /** Only filled when the binary export opt-in is on. */
  attachments?: DriftPackAttachment[];
}

export interface DriftReviewPackProblem {
  sessionId: string;
  workspacePath: string;
  sourcePath?: string;
  reason:
    | "FILE_MISSING"
    | "INTEGRITY_FAILED"
    | "CAPTURE_FAILED"
    | "UNVERIFIED"
    | DriftPackExclusionReason;
  expectedSha256?: string;
  actualSha256?: string;
}

export interface DriftReviewPackResult {
  exportDir: string;
  indexPath: string;
  manifestPath: string;
  zipPaths: string[];
  parts: number;
  sessions: number;
  problems: number;
}

export interface ExportDriftReviewPackParams {
  fileService: PackFiles;
  vaultRoot: string;
  batchId?: string;
  scope?: "all" | "changed" | "failed";
  format?: "folder" | "zip";
  splitPartBytes?: number;
  redactCredentials?: boolean;
  /**
   * Explicit operator authorization to ship a source that could not be scanned
   * (over the scan budget or unreadable). Default false: such a source is
   * excluded and listed as a problem instead of being copied unscanned.
   */
  allowUnredactedSources?: boolean;
  /** Copy local attachment files into the pack (default: off, references only). */
  exportBinaryAttachments?: boolean;
  now?: () => number;
}

export type DriftFileService = Pick<
  IFileService,
  "writeTextFile" | "writeTextFileAtomic" | "sha256File" | "stat" | "readTextFile" | "readFileRange"
>;
