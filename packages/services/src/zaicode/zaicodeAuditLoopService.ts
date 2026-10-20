/* oxlint-disable eslint(max-lines) -- T-289: the durable run, its evidence, its
   reviewer step, its remediation dispatch and its recovery all share one
   persistence boundary (the run file). Splitting them would let one step write
   a state another step cannot read back after a crash, which is the failure
   this file exists to prevent. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  ZAICODE_AUDIT_LOOP_FIX_BEGIN,
  ZAICODE_AUDIT_LOOP_FIX_END,
  ZAICODE_AUDIT_LOOP_FIX_IDENTITY_PREFIX,
  ZAICODE_AUDIT_LOOP_FIX_TERMINAL_LINE,
  ZAICODE_AUDIT_LOOP_MAX_CYCLES,
  ZAICODE_AUDIT_LOOP_REVIEW_BEGIN,
  ZAICODE_AUDIT_LOOP_REVIEW_END,
  ZAICODE_AUDIT_LOOP_REVIEW_TERMINAL_LINE,
  ZAICODE_AUDIT_LOOP_RETRY_BUDGET,
  buildZaicodeAuditEvidencePackage,
  buildZaicodeAuditLoopRemediationProtocol,
  buildZaicodeAuditLoopReviewProtocol,
  classifyZaicodeAuditEvidencePath,
  clampZaicodeAuditLoopMaxCycles,
  describeZaicodeAuditLoopState,
  normalizeZaicodeAuditLoopFixReport,
  normalizeZaicodeAuditReview,
  zaicodeAuditLoopCleanConfirmed,
  zaicodeAuditLoopFeedbackProvenance,
  zaicodeAuditLoopFindingIsResolved,
  zaicodeAuditLoopFindingsFingerprintFor,
  zaicodeAuditLoopIsTerminal,
  zaicodeAuditLoopMergeFindings,
  zaicodeAuditLoopNewRun,
  zaicodeAuditLoopStopDecision,
  zaicodeAuditLoopUnresolvedFindings,
  zaicodeAuditLoopVerifyFindingClaim,
  type ZaicodeAuditEvidenceExclusion,
  type ZaicodeAuditEvidenceManifest,
  type ZaicodeAuditLoopFinding,
  type ZaicodeAuditLoopReviewReceipt,
  type ZaicodeAuditLoopReviewerMode,
  type ZaicodeAuditLoopRun,
  type ZaicodeAuditLoopState,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import type { IZaicodeAgentService } from "./zaicodeAgents.js";
import type { IZaicodeJobService } from "./zaicodeJobs.js";
import type {
  IZaicodeAuditLoopService,
  ZaicodeAuditLoopAdmitInput,
  ZaicodeAuditLoopAdmitResult,
  ZaicodeAuditLoopSettings,
} from "./zaicodeAuditLoops.js";

const execFileAsync = promisify(execFile);

/** How many state steps one `advance` may take before it returns for air. */
const ADVANCE_STEP_LIMIT = 14;
/** A review artifact must echo this so yesterday's report cannot satisfy today's run. */
const REVIEW_IDENTITY_PREFIX = "AUDIT_LOOP_REVIEW_IDENTITY:";
/** Bounded workspace scan: the same walk that feeds the evidence package. */
const SCAN_MAX_FILES = 4000;
const SCAN_MAX_DEPTH = 8;
/** A durable per-workspace admission reservation older than this is abandoned. */
const ADMISSION_LOCK_STALE_MS = 30_000;

const STOP_STATES: readonly ZaicodeAuditLoopState[] = [
  "DISABLED",
  "CLEAN_CONFIRMED",
  "WAITING_OPERATOR",
  "FAILED_RECOVERABLE",
  "STOPPED_LIMIT",
  "CANCELLED",
];

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface ScannedFile {
  /** Workspace-relative, forward slashes. */
  path: string;
  text: string;
}

/** What the bounded walk saw, and what it could not (so coverage is never a guess). */
interface WorkspaceScan {
  files: ScannedFile[];
  exclusions: ZaicodeAuditEvidenceExclusion[];
  unreadable: string[];
  oversized: string[];
  truncated: boolean;
}

/** An authoritative answer to "may this run mutate the source right now?". */
export interface ZaicodeAuditLoopOwnershipAnswer {
  /** False when the caller could not consult the canonical SAIPEN interface. */
  authoritative: boolean;
  /** True only when another live owner holds this project's source. */
  foreign: boolean;
  detail: string;
}

export interface ZaicodeAuditLoopDeps {
  jobService: IZaicodeJobService;
  agentService: IZaicodeAgentService;
  /** Test/host hook: where runs, evidence and receipts live. */
  rootDir?: () => string;
  /** Test hook for the SAIPEN board reader used by the ownership gate. */
  readBoard?: (workspacePath: string) => string | null;
  /**
   * The canonical SAIPEN ownership/admission answer for a workspace. The loop
   * NEVER compares a BOARD owner name with a ZAICODE agent id itself: that
   * spans two identity domains and would either always refuse or always allow.
   * When this is absent and the workspace has a `.saipen/`, source mutation is
   * refused and the missing capability is recorded (SRC-202 Phase 7).
   */
  queryOwnership?: (workspacePath: string) => Promise<ZaicodeAuditLoopOwnershipAnswer | null>;
  /**
   * Test/host hook: the bounded workspace scan. The default walks the tree and
   * applies the same allowlist/denylist the evidence package uses.
   */
  listFiles?: (workspacePath: string) => Promise<ScannedFile[]>;
  /** Test/host hook: content-based source identity of the workspace. */
  sourceFingerprint?: (workspacePath: string) => Promise<{ fingerprint: string; head: string | null }>;
  /**
   * The deterministic acceptance gates the host runs for a cycle. The default
   * runs none, and a clean verdict without gates is refused rather than
   * promoted -- a milestone is never green because a model said so.
   */
  runGates?: (run: ZaicodeAuditLoopRun) => Promise<{ command: string; exitCode: number }[]>;
  now?: () => number;
  logger?: { warn(message: string, error?: unknown): void; info?(message: string): void };
}

export class ZaicodeAuditLoopService implements IZaicodeAuditLoopService {
  private readonly writeLocks = new Map<string, Promise<void>>();
  /** One admission may be in flight per workspace, in this process. */
  private readonly admissionLocks = new Map<string, Promise<void>>();
  private auditAgentId: string | null = null;
  private remediationAgentId: string | null = null;

  constructor(private readonly deps: ZaicodeAuditLoopDeps) {}

  // -------------------------------------------------------------------------
  // Paths and durable IO
  // -------------------------------------------------------------------------

  private root(): string {
    return this.deps.rootDir?.() ?? join(getAppConfigDir(), "zaicode-audit-loops");
  }

  private loopDir(loopId: string): string {
    return join(this.root(), loopId);
  }

  private runFile(loopId: string): string {
    return join(this.loopDir(loopId), "run.json");
  }

  private settingsPath(): string {
    return join(this.root(), "settings.json");
  }

  private cycleDir(loopId: string, cycle: number): string {
    return join(this.loopDir(loopId), `cycle-${cycle}`);
  }

  private evidenceFile(loopId: string, cycle: number): string {
    return join(this.cycleDir(loopId, cycle), "evidence.md");
  }

  private manifestFile(loopId: string, cycle: number): string {
    return join(this.cycleDir(loopId, cycle), "evidence.json");
  }

  private reviewPath(loopId: string, cycle: number): string {
    return join(this.cycleDir(loopId, cycle), "review.md");
  }

  private receiptPath(loopId: string, cycle: number): string {
    return join(this.cycleDir(loopId, cycle), "review-receipt.json");
  }

  /** Where a remediation job's own per-finding report is expected (Phase 6). */
  private fixReportPath(loopId: string, cycle: number): string {
    return join(this.cycleDir(loopId, cycle), "fix-report.md");
  }

  private now(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  private static writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  }

  private static writeTextAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  }

  private static readJson<T>(path: string): T | null {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private findRun(loopId: string): ZaicodeAuditLoopRun | null {
    return ZaicodeAuditLoopService.readJson<ZaicodeAuditLoopRun>(this.runFile(loopId));
  }

  private loadRuns(): ZaicodeAuditLoopRun[] {
    const dir = this.root();
    if (!existsSync(dir)) return [];
    const runs: ZaicodeAuditLoopRun[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const run = this.findRun(entry.name);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  private saveRun(run: ZaicodeAuditLoopRun): void {
    run.updatedAt = this.now();
    ZaicodeAuditLoopService.writeJsonAtomic(this.runFile(run.loopId), run);
  }

  /** Serialize every step of one loop, so two renderers cannot advance it at once. */
  private withRun<T>(loopId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(loopId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.writeLocks.set(
      loopId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private readSettings(): ZaicodeAuditLoopSettings {
    const raw = ZaicodeAuditLoopService.readJson<Partial<ZaicodeAuditLoopSettings>>(this.settingsPath());
    const consent = raw?.externalTransmissionConsent;
    return {
      enabled: raw?.enabled !== false,
      maxCycles: clampZaicodeAuditLoopMaxCycles(raw?.maxCycles ?? ZAICODE_AUDIT_LOOP_MAX_CYCLES),
      reviewerMode: raw?.reviewerMode === "external" ? "external" : "self",
      externalTransmissionConsent: {
        granted: consent?.granted === true,
        scope: typeof consent?.scope === "string" && consent.scope ? consent.scope : null,
        grantedAt: typeof consent?.grantedAt === "string" ? consent.grantedAt : null,
      },
      externalFallback: raw?.externalFallback === "none" ? "none" : "self",
    };
  }

  private writeSettings(patch: Partial<ZaicodeAuditLoopSettings>): ZaicodeAuditLoopSettings {
    const next = { ...this.readSettings(), ...patch };
    ZaicodeAuditLoopService.writeJsonAtomic(this.settingsPath(), next);
    return next;
  }

  async setEnabled(enabled: boolean): Promise<ZaicodeAuditLoopSettings> {
    return this.writeSettings({ enabled });
  }

  async setMaxCycles(maxCycles: number): Promise<ZaicodeAuditLoopSettings> {
    if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > ZAICODE_AUDIT_LOOP_MAX_CYCLES) {
      throw new Error(`audit loop cycles must be between 1 and ${ZAICODE_AUDIT_LOOP_MAX_CYCLES}`);
    }
    return this.writeSettings({ maxCycles });
  }

  async setReviewerMode(mode: ZaicodeAuditLoopReviewerMode): Promise<ZaicodeAuditLoopSettings> {
    return this.writeSettings({ reviewerMode: mode === "external" ? "external" : "self" });
  }

  async setExternalConsent(input: { granted: boolean; scope: string }): Promise<ZaicodeAuditLoopSettings> {
    return this.writeSettings({
      externalTransmissionConsent: {
        granted: input.granted,
        scope: input.scope,
        grantedAt: input.granted ? this.now() : null,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Workspace scan and source identity
  // -------------------------------------------------------------------------

  /**
   * The bounded scan. Directory decisions come from the same policy the
   * evidence package uses, so the walk and the package can never disagree about
   * what the workspace contains.
   */
  private walkWorkspace(workspacePath: string): WorkspaceScan {
    const files: ScannedFile[] = [];
    const exclusions: ZaicodeAuditEvidenceExclusion[] = [];
    const unreadable: string[] = [];
    const oversized: string[] = [];
    let truncated = false;
    const rootPath = resolve(workspacePath);
    const readEntries = (absoluteDir: string) => {
      try {
        return readdirSync(absoluteDir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        // An unreadable directory is recorded as an incomplete-coverage reason,
        // never silently dropped: the manifest must say what it could not see.
        unreadable.push(`${relative(rootPath, absoluteDir).split(sep).join("/")}/`);
        return null;
      }
    };
    const visit = (absoluteDir: string, depth: number): void => {
      if (depth > SCAN_MAX_DEPTH || files.length >= SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      const entries = readEntries(absoluteDir);
      if (!entries) return;
      for (const entry of entries) {
        if (files.length >= SCAN_MAX_FILES) {
          truncated = true;
          return;
        }
        const absolute = join(absoluteDir, entry.name);
        const relativePath = relative(rootPath, absolute).split(sep).join("/");
        if (entry.isDirectory()) {
          const decision = classifyZaicodeAuditEvidencePath(relativePath, "dir");
          if (decision.decision !== "include") {
            exclusions.push({ path: `${relativePath}/`, ruleId: decision.ruleId, reason: decision.reason });
            continue;
          }
          visit(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const decision = classifyZaicodeAuditEvidencePath(relativePath, "file");
        if (decision.decision !== "include") {
          // Refused by name, so the file is never opened: the manifest records
          // WHY it is not in the package, and the bytes never enter memory.
          exclusions.push({ path: relativePath, ruleId: decision.ruleId, reason: decision.reason });
          continue;
        }
        try {
          if (statSync(absolute).size > 512 * 1024) {
            oversized.push(relativePath);
            continue;
          }
          files.push({ path: relativePath, text: readFileSync(absolute, "utf8") });
        } catch {
          unreadable.push(relativePath);
        }
      }
    };
    visit(rootPath, 0);
    return { files, exclusions, unreadable, oversized, truncated };
  }

  private async scanWorkspace(workspacePath: string): Promise<WorkspaceScan> {
    if (this.deps.listFiles) {
      // A supplied scan is assumed to be its own complete view of the workspace;
      // it reports no partial coverage of its own.
      return { files: await this.deps.listFiles(workspacePath), exclusions: [], unreadable: [], oversized: [], truncated: false };
    }
    return this.walkWorkspace(workspacePath);
  }

  private async listFiles(workspacePath: string): Promise<ScannedFile[]> {
    return (await this.scanWorkspace(workspacePath)).files;
  }

  private async gitHead(workspacePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        timeout: 5000,
        windowsHide: true,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async sourceFingerprintOf(workspacePath: string): Promise<{ fingerprint: string; head: string | null }> {
    if (this.deps.sourceFingerprint) return this.deps.sourceFingerprint(workspacePath);
    const files = await this.listFiles(workspacePath);
    const fingerprint = zaicodeAuditLoopSourceFingerprintOf(files);
    return { fingerprint, head: await this.gitHead(workspacePath) };
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  private lockDirOf(workspaceKey: string): string {
    return join(this.root(), "admission-locks", sha256Of(workspaceKey).slice(0, 32));
  }

  /**
   * Serialize admission for one workspace: an in-process chain, then a durable
   * reservation directory shared across hosts. Two terminal events, or two
   * hosts, cannot observe "no active loop" at the same time and each create one.
   */
  private async withAdmissionLock<T>(workspaceKey: string, work: () => Promise<T>, busy: () => T): Promise<T> {
    const previous = this.admissionLocks.get(workspaceKey) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const queued = previous.then(() => held);
    this.admissionLocks.set(workspaceKey, queued);
    await previous.catch(() => undefined);
    try {
      const dir = this.lockDirOf(workspaceKey);
      mkdirSync(dirname(dir), { recursive: true });
      let acquired = false;
      try {
        mkdirSync(dir, { recursive: false });
        acquired = true;
      } catch {
        // Held by another host. Steal only a clearly abandoned reservation; a
        // live one means another admission is in flight and this one defers.
        try {
          if (Date.now() - statSync(dir).mtimeMs > ADMISSION_LOCK_STALE_MS) {
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: false });
            acquired = true;
          }
        } catch {
          acquired = false;
        }
      }
      if (!acquired) return busy();
      try {
        return await work();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      open();
      if (this.admissionLocks.get(workspaceKey) === queued) this.admissionLocks.delete(workspaceKey);
    }
  }

  private async admitInternal(
    input: ZaicodeAuditLoopAdmitInput,
    mode: "auto" | "manual",
  ): Promise<ZaicodeAuditLoopAdmitResult> {
    return this.withAdmissionLock(
      input.workspaceKey,
      () => this.admitLocked(input, mode),
      () => ({ ok: false, code: "ADMISSION_LOCK_UNAVAILABLE", reason: "another admission is already in flight for this workspace" }),
    );
  }

  private async admitLocked(input: ZaicodeAuditLoopAdmitInput, mode: "auto" | "manual"): Promise<ZaicodeAuditLoopAdmitResult> {
    const settings = this.readSettings();
    if (!settings.enabled) return { ok: false, code: "AUDIT_MODE_DISABLED", reason: "the audit loop layer is switched off" };
    // Automatic admission additionally needs the project's own audit mode. Manual
    // "audit now" is independent of it, which is what makes it usable on demand.
    if (mode === "auto" && !input.autoAudits) {
      return { ok: false, code: "AUDIT_MODE_DISABLED", reason: "this project's automatic audit mode is off" };
    }
    if (!input.terminalDisposition || !input.terminalDisposition.trim()) {
      return { ok: false, code: "NO_TERMINAL_DISPOSITION", reason: "admission requires a terminal job disposition, not prose" };
    }
    const job = await this.deps.jobService.get(input.executor.jobId).catch(() => null);
    if (!job) return { ok: false, code: "EXECUTOR_UNKNOWN", reason: `no queue job ${input.executor.jobId} exists` };
    if (job.workspaceKey !== input.workspaceKey) {
      return { ok: false, code: "MISMATCHED_TASK_IDENTITY", reason: "the executor job belongs to another workspace" };
    }
    if (!["completed", "failed", "cancelled", "blocked"].includes(job.status)) {
      return { ok: false, code: "EXECUTOR_NOT_TERMINAL", reason: `the executor job is still ${job.status}` };
    }
    if (job.status !== "completed") {
      return { ok: false, code: "EXECUTOR_NOT_TERMINAL", reason: `the executor job ended as ${job.status}, which is not a completion` };
    }
    // No second worker may be mutating the same source while the audit reads it.
    // A failed inventory read is UNKNOWN, never SAFE: an unreadable worker list
    // is not evidence that no worker is running.
    const running = await this.deps.jobService.list({ workspaceKey: input.workspaceKey, status: "running" }).catch(() => null);
    if (running === null) {
      return { ok: false, code: "WORKER_INVENTORY_UNKNOWN", reason: "the running-worker inventory could not be read; the source is not proven stable" };
    }
    if (running.jobs.some((candidate) => candidate.id !== input.executor.jobId)) {
      return {
        ok: false,
        code: "ACTIVE_OVERLAPPING_WORKER",
        reason: "another worker is still running in this workspace; the source is not stable",
      };
    }
    const conflict = this.loadRuns().find(
      (run) => run.workspaceKey === input.workspaceKey && !zaicodeAuditLoopIsTerminal(run.state) && run.state !== "DISABLED",
    );
    if (conflict) {
      return { ok: false, code: "CONFLICTING_LOOP", reason: `loop ${conflict.loopId} is already running for this workspace` };
    }

    const source = await this.sourceFingerprintOf(input.workspacePath).catch(() => null);
    if (!source?.fingerprint || source.fingerprint.length < 16) {
      return { ok: false, code: "SOURCE_EVIDENCE_UNSTABLE", reason: "the workspace produced no stable content identity" };
    }

    const run = zaicodeAuditLoopNewRun({
      loopId: randomUUID(),
      projectName: input.projectName,
      workspaceKey: input.workspaceKey,
      workspacePath: input.workspacePath,
      executor: { ...input.executor },
      taskId: input.taskId,
      goalId: input.goalId,
      authorityRef: input.authorityRef ?? null,
      mode,
      terminalDisposition: input.terminalDisposition.trim(),
      sourceFingerprint: source.fingerprint,
      sourceHead: source.head,
      maxCycles: settings.maxCycles,
      reviewerMode: settings.reviewerMode,
      autoAudits: input.autoAudits,
      externalTransmissionConsent: { ...settings.externalTransmissionConsent },
      externalFallback: settings.externalFallback,
      now: this.now(),
    });
    try {
      mkdirSync(this.loopDir(run.loopId), { recursive: true });
      this.saveRun(run);
    } catch (error) {
      // A reservation that cannot be persisted must not launch an auditor: the
      // half-written loop directory is removed and the admission is refused.
      try {
        rmSync(this.loopDir(run.loopId), { recursive: true, force: true });
      } catch {
        /* the run file was never written; nothing else to clean */
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn(`ZAICODE audit loop: could not persist the admitted run: ${detail}`);
      return { ok: false, code: "ADMISSION_RESERVATION_FAILED", reason: `the durable run could not be persisted: ${detail}` };
    }
    this.deps.logger?.info?.(`ZAICODE audit loop admitted ${run.loopId} for ${input.projectName}`);
    return { ok: true, run };
  }

  async admit(input: ZaicodeAuditLoopAdmitInput): Promise<ZaicodeAuditLoopAdmitResult> {
    return this.admitInternal(input, "auto");
  }

  async auditNow(input: ZaicodeAuditLoopAdmitInput): Promise<ZaicodeAuditLoopAdmitResult> {
    return this.admitInternal(input, "manual");
  }

  /**
   * The terminal event for a review or fix job the loop itself dispatched. It
   * is resolved from the DURABLE job id, never from title text: the run whose
   * pending or remediation job is this id, in this workspace, advances; nothing
   * else does. A stale or duplicate notification finds no match and is a no-op.
   */
  async resumeFromTerminalJob(input: {
    workspaceKey: string;
    jobId: string;
    terminalDisposition: string;
  }): Promise<ZaicodeAuditLoopRun | null> {
    const run = this.loadRuns().find(
      (candidate) =>
        candidate.workspaceKey === input.workspaceKey &&
        !zaicodeAuditLoopIsTerminal(candidate.state) &&
        (candidate.pending?.jobId === input.jobId || candidate.remediation?.jobId === input.jobId),
    );
    if (!run) return null;
    // The job's own state is re-read from the durable queue, so a notification
    // claiming success for a job that failed (or is still running) cannot move
    // the loop: only the queue's terminal outcome is evidence.
    const job = await this.deps.jobService.get(input.jobId).catch(() => null);
    if (!job || !["completed", "failed", "cancelled"].includes(job.status)) return null;
    return this.advance(run.loopId);
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  private async ensureAgent(role: "auditor" | "implementer"): Promise<string | null> {
    const cached = role === "auditor" ? this.auditAgentId : this.remediationAgentId;
    if (cached) return cached;
    try {
      const { agents } = await this.deps.agentService.list();
      const existing = agents.find((agent) => agent.role === role);
      const agent = existing ?? (await this.deps.agentService.createFromTemplate(`zaicode-template:${role}`));
      if (role === "auditor") this.auditAgentId = agent.id;
      else this.remediationAgentId = agent.id;
      return agent.id;
    } catch (error) {
      this.deps.logger?.warn(`ZAICODE audit loop: no ${role} agent is available`, error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // SAIPEN ownership gate
  // -------------------------------------------------------------------------

  private boardOf(workspacePath: string): string | null {
    if (this.deps.readBoard) return this.deps.readBoard(workspacePath);
    const path = join(workspacePath, ".saipen", "BOARD.md");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  private hasSaipen(workspacePath: string): boolean {
    return existsSync(join(workspacePath, ".saipen"));
  }

  /**
   * May this run mutate the source right now? The answer comes from the
   * canonical SAIPEN ownership interface, never from comparing a BOARD owner
   * name with a ZAICODE agent id -- those are two identity domains, and a text
   * comparison would either always refuse or always allow. When the interface
   * is unavailable and the project is SAIPEN-governed, mutation is refused and
   * the missing capability is the recorded reason (SRC-202 Phase 7). A project
   * with no `.saipen/` has no ownership domain to consult.
   */
  private async ownershipRefusal(workspacePath: string): Promise<{ code: string; reason: string } | null> {
    if (!this.deps.queryOwnership) {
      return this.hasSaipen(workspacePath)
        ? {
            code: "OWNERSHIP_QUERY_UNAVAILABLE",
            reason: "no canonical SAIPEN ownership query is wired, so this governed project's source cannot be proven unowned",
          }
        : null;
    }
    let answer: ZaicodeAuditLoopOwnershipAnswer | null = null;
    try {
      answer = await this.deps.queryOwnership(workspacePath);
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audit loop: ownership query failed", error);
      return { code: "OWNERSHIP_QUERY_UNAVAILABLE", reason: "the SAIPEN ownership query failed; ownership is UNKNOWN, not free" };
    }
    if (!answer || !answer.authoritative) {
      return this.hasSaipen(workspacePath)
        ? {
            code: "OWNERSHIP_QUERY_UNAVAILABLE",
            reason: `SAIPEN ownership is not authoritatively known (${answer?.detail ?? "no answer"})`,
          }
        : null;
    }
    return answer.foreign
      ? { code: "SAIPEN_OWNERSHIP_REJECTED", reason: `SAIPEN ownership of this project's source is held elsewhere: ${answer.detail}` }
      : null;
  }

  /**
   * Is the evidence package the reviewer was given still exactly what is on
   * disk, and still about the revision the run is judging (Phase 5)?
   */
  private verifyEvidence(run: ZaicodeAuditLoopRun): { ok: true } | { ok: false; code: string; detail: string } {
    const evidence = run.evidence;
    if (!evidence) return { ok: false, code: "EVIDENCE_MISSING", detail: "no durable evidence package exists for this cycle" };
    if (!existsSync(evidence.packageFile) || !existsSync(evidence.manifestFile)) {
      return { ok: false, code: "EVIDENCE_MISSING", detail: "the evidence package is no longer on disk" };
    }
    const manifest = ZaicodeAuditLoopService.readJson<{ digest: string; sourceFingerprint: string }>(evidence.manifestFile);
    if (!manifest) return { ok: false, code: "EVIDENCE_MANIFEST_UNREADABLE", detail: "the evidence manifest cannot be read" };
    if (manifest.digest !== evidence.digest || manifest.sourceFingerprint !== evidence.sourceFingerprint) {
      return { ok: false, code: "EVIDENCE_MANIFEST_DRIFT", detail: "the evidence manifest no longer matches the run's recorded package" };
    }
    const body = readFileSync(evidence.packageFile, "utf8");
    if (sha256Of(body) !== evidence.digest) {
      // A package altered after packaging is not the artifact the review is
      // judged against, so nothing derived from it may be acted on.
      return { ok: false, code: "EVIDENCE_PACKAGE_DRIFT", detail: "the evidence package digest does not match its own manifest" };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Dispatch helpers (find-then-create, so a crash adopts instead of duplicating)
  // -------------------------------------------------------------------------

  private async dispatchOnce(input: {
    workspaceKey: string;
    workspacePath: string;
    agentId: string;
    title: string;
    instructions: string;
  }): Promise<{ id: string; agentId: string } | null> {
    const existing = await this.deps.jobService.list({ workspaceKey: input.workspaceKey }).catch(() => null);
    const found = existing?.jobs.find((candidate) => candidate.title === input.title) ?? null;
    if (found) return { id: found.id, agentId: found.agentId };
    try {
      const created = await this.deps.jobService.create({
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        agentId: input.agentId,
        title: input.title,
        instructions: input.instructions,
      });
      return { id: created.id, agentId: created.agentId };
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audit loop: dispatch failed", error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // The step engine
  // -------------------------------------------------------------------------

  async advance(loopId: string): Promise<ZaicodeAuditLoopRun | null> {
    return this.withRun(loopId, async () => {
      let run = this.findRun(loopId);
      if (!run) return null;
      for (let index = 0; index < ADVANCE_STEP_LIMIT; index += 1) {
        const before = `${run.state}|${run.cycle}|${run.pending?.jobId ?? "-"}|${run.evidence?.cycle ?? -1}|${run.reviewerHistory.length}`;
        run = (await this.step(run)) ?? run;
        this.saveRun(run);
        const after = `${run.state}|${run.cycle}|${run.pending?.jobId ?? "-"}|${run.evidence?.cycle ?? -1}|${run.reviewerHistory.length}`;
        if (before === after || STOP_STATES.includes(run.state)) break;
      }
      return this.findRun(loopId) ?? run;
    });
  }

  private park(run: ZaicodeAuditLoopRun, state: ZaicodeAuditLoopState, code: string, reason: string): ZaicodeAuditLoopRun {
    run.state = state;
    run.blocker = { code, reason, since: this.now() };
    run.pending = null;
    return run;
  }

  private async step(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    switch (run.state) {
      case "WAITING_FOR_EXECUTOR":
        return this.stepWaitForExecutor(run);
      case "SNAPSHOTTING":
        return this.stepSnapshot(run);
      case "READY_FOR_REVIEW":
        return this.stepDispatchReview(run);
      case "REVIEWING":
        return this.stepAwaitReview(run);
      case "VALIDATING_REVIEW":
        return this.stepValidateReview(run);
      case "WAITING_FOR_REMEDIATION":
        return this.stepDispatchRemediation(run);
      case "REMEDIATING":
        return this.stepAwaitRemediation(run);
      case "VERIFYING_FIX":
        return this.stepVerifyFix(run);
      case "READY_FOR_NEXT_CYCLE":
        return this.stepNextCycle(run);
      default:
        return run;
    }
  }

  private async stepWaitForExecutor(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const job = await this.deps.jobService.get(run.originalExecutor.jobId).catch(() => null);
    if (!job) return this.park(run, "FAILED_RECOVERABLE", "EXECUTOR_UNKNOWN", "the admitted executor job no longer exists");
    if (!["completed", "failed", "cancelled", "blocked"].includes(job.status)) return run;
    if (job.status !== "completed") {
      return this.park(run, "WAITING_OPERATOR", "EXECUTOR_NOT_COMPLETED", `the executor ended as ${job.status}`);
    }
    run.state = "SNAPSHOTTING";
    return run;
  }

  private async stepSnapshot(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const source = await this.sourceFingerprintOf(run.workspacePath).catch(() => null);
    if (!source?.fingerprint) {
      return this.fail(run, "SOURCE_EVIDENCE_UNSTABLE", "the workspace produced no stable content identity");
    }
    // The cycle's own frozen identity. A later clean verdict is judged against
    // THIS value, never against whatever the tree looks like when it arrives.
    run.sourceFingerprint = source.fingerprint;
    run.sourceHead = source.head;

    const scan = await this.scanWorkspace(run.workspacePath);
    const board = this.boardOf(run.workspacePath);
    const acceptance: ZaicodeAuditEvidenceManifest["acceptance"] = {
      requirements: [`The audited task ${run.originalTaskId} reached a terminal completion.`],
      tests: [],
      receipts: run.admission.authorityRef ? [run.admission.authorityRef] : [],
      reproduction: [
        `Open ${run.workspacePath}.`,
        `Read the evidence package at ${this.evidenceFile(run.loopId, run.cycle)}.`,
        `Verify each finding against the files named in it; the package digest is the artifact's identity.`,
      ],
    };
    if (board) acceptance.receipts.push(`saipen:BOARD (${run.workspacePath}/.saipen/BOARD.md)`);

    let built;
    try {
      built = buildZaicodeAuditEvidencePackage({
        projectName: run.projectName,
        workspaceKey: run.workspaceKey,
        taskId: run.originalTaskId,
        goalId: run.originalGoalId,
        executorIdentity: `${run.originalExecutor.agentId} job=${run.originalExecutor.jobId}`,
        loopId: run.loopId,
        cycle: run.cycle,
        sourceFingerprint: run.sourceFingerprint,
        sourceHead: run.sourceHead,
        generatedAt: this.now(),
        candidates: scan.files,
        directoryExclusions: scan.exclusions,
        scan: { unreadable: scan.unreadable, oversized: scan.oversized, truncated: scan.truncated },
        acceptance,
        hash: sha256Of,
      });
    } catch (error) {
      return this.fail(run, "EVIDENCE_BUILD_FAILED", error instanceof Error ? error.message : String(error));
    }

    try {
      ZaicodeAuditLoopService.writeTextAtomic(this.evidenceFile(run.loopId, run.cycle), built.body);
      ZaicodeAuditLoopService.writeJsonAtomic(this.manifestFile(run.loopId, run.cycle), built.manifest);
    } catch (error) {
      // No evidence on disk means no reviewer: a package that cannot be written
      // is not a review input, and dispatching anyway would ask a model to
      // audit nothing.
      return this.fail(run, "EVIDENCE_WRITE_FAILED", error instanceof Error ? error.message : String(error));
    }

    run.evidence = {
      cycle: run.cycle,
      manifestFile: this.manifestFile(run.loopId, run.cycle),
      packageFile: this.evidenceFile(run.loopId, run.cycle),
      digest: built.manifest.digest,
      fileCount: built.manifest.included.length,
      excludedCount: built.manifest.exclusionSummary.total,
      sourceFingerprint: run.sourceFingerprint,
      coverageComplete: built.manifest.coverage.complete,
      limitations: built.manifest.coverage.limitations,
      writtenAt: this.now(),
    };
    run.state = "READY_FOR_REVIEW";
    return run;
  }

  private async stepDispatchReview(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    if (!run.evidence) return this.fail(run, "EVIDENCE_MISSING", "no durable evidence package exists for this cycle");

    const stop = zaicodeAuditLoopStopDecision(run);
    if (stop.stop && stop.code === "CYCLE_LIMIT") return this.park(run, "STOPPED_LIMIT", stop.code, stop.reason!);
    if (stop.stop) return this.park(run, stop.state!, stop.code!, stop.reason!);

    // External mode is consent-gated and never silently substituted. The mode
    // is read live so the operator's "change reviewer" takes effect on the next
    // cycle, and the mode actually used is written onto the run and the receipt
    // -- a fallback is never presented as independent external verification.
    const live = this.readSettings();
    run.reviewerMode = live.reviewerMode;
    run.settings.externalFallback = live.externalFallback;
    run.settings.externalTransmissionConsent = { ...live.externalTransmissionConsent };
    let effectiveMode = run.reviewerMode;
    if (run.reviewerMode === "external") {
      if (!run.settings.externalTransmissionConsent.granted) {
        return this.park(
          run,
          "WAITING_OPERATOR",
          "REVIEWER_CONSENT_REQUIRED",
          "an external reviewer needs the operator's consent to transmit sanitized source evidence",
        );
      }
      if (run.settings.externalFallback !== "self") {
        return this.park(
          run,
          "WAITING_OPERATOR",
          "REVIEWER_UNAVAILABLE",
          "no external reviewer adapter is configured and the fallback policy is 'none'",
        );
      }
      effectiveMode = "self";
    }

    const agentId = await this.ensureAgent("auditor");
    if (!agentId) {
      return this.fail(run, "REVIEWER_AGENT_UNAVAILABLE", "no auditor agent could be resolved for the self-audit");
    }

    const identity = `self:${agentId}`;
    const reviewFile = this.reviewPath(run.loopId, run.cycle);
    const title = auditLoopJobTitle(run.loopId, run.cycle, "review");
    const instructions = [
      ...buildZaicodeAuditLoopReviewProtocol(),
      "",
      "## This cycle",
      `- Project: ${run.projectName} (${run.workspacePath})`,
      `- Audited task: ${run.originalTaskId}`,
      `- Loop: ${run.loopId}`,
      `- Cycle: ${run.cycle} of ${run.maxCycles}`,
      `- Source identity: ${run.sourceFingerprint}`,
      `- Evidence package digest: ${run.evidence.digest}`,
      run.sourceHead ? `- Source HEAD at packaging: ${run.sourceHead}` : "- Source HEAD: not a git work tree",
      "",
      "## The evidence package",
      `Read this file: ${run.evidence.packageFile}`,
      `Its manifest is: ${run.evidence.manifestFile}`,
      ...(effectiveMode !== run.reviewerMode
        ? ["", `NOTE: the configured external reviewer is unavailable; this verdict is a SELF-audit and is recorded as one.`]
        : []),
      "",
      "## Where the review goes",
      "Write the review artifact to this exact file, creating it:",
      reviewFile,
      "The file must carry this identity line verbatim, or the loop rejects it as the wrong run:",
      `${REVIEW_IDENTITY_PREFIX} ${run.loopId}#${run.cycle} ${run.sourceFingerprint}`,
      `The artifact must contain one ${ZAICODE_AUDIT_LOOP_REVIEW_BEGIN} ... ${ZAICODE_AUDIT_LOOP_REVIEW_END} block.`,
      `The artifact must end with exactly: ${ZAICODE_AUDIT_LOOP_REVIEW_TERMINAL_LINE}`,
    ].join("\n");

    const view = this.deps.logger;
    // Intent first, queue second: a crash in between leaves a durable pending
    // step whose title lookup adopts the job instead of sending a second one.
    run.pending = {
      kind: "review",
      jobId: null,
      idempotencyKey: `${run.loopId}:${run.cycle}:review`,
      attempt: (run.pending?.attempt ?? 0) + 1,
      startedAt: this.now(),
    };
    run.state = "REVIEWING";
    this.saveRun(run);
    const dispatched = await this.dispatchOnce({
      workspaceKey: run.workspaceKey,
      workspacePath: run.workspacePath,
      agentId,
      title,
      instructions,
    });
    if (!dispatched) {
      return this.fail(run, "REVIEWER_DISPATCH_FAILED", "the reviewer job could not be queued");
    }
    run.pending.jobId = dispatched.id;
    run.activeReviewerIdentity = identity;
    if (!run.reviewerHistory.includes(identity)) run.reviewerHistory.push(identity);
    view?.info?.(`ZAICODE audit loop ${run.loopId} cycle ${run.cycle}: review dispatched to ${identity}`);
    return run;
  }

  private async stepAwaitReview(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const jobId = run.pending?.jobId;
    if (!jobId) {
      // The intent survived but the queue write did not: adopt or create it.
      return this.stepDispatchReviewAfterCrash(run);
    }
    const job = await this.deps.jobService.get(jobId).catch(() => null);
    if (!job) return this.fail(run, "REVIEW_JOB_LOST", "the reviewer job vanished from the durable queue");
    if (!["completed", "failed", "cancelled", "blocked"].includes(job.status)) return run;
    if (job.status !== "completed") {
      return this.fail(run, "REVIEW_JOB_FAILED", `the reviewer job ended as ${job.status}`);
    }
    run.state = "VALIDATING_REVIEW";
    return run;
  }

  private async stepDispatchReviewAfterCrash(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const title = auditLoopJobTitle(run.loopId, run.cycle, "review");
    const existing = await this.deps.jobService.list({ workspaceKey: run.workspaceKey }).catch(() => null);
    const found = existing?.jobs.find((candidate) => candidate.title === title) ?? null;
    if (found && ["queued", "ready", "running", "waiting"].includes(found.status)) {
      run.pending = { ...(run.pending ?? { kind: "review", idempotencyKey: `${run.loopId}:${run.cycle}:review`, attempt: 1, startedAt: this.now() }), jobId: found.id };
      run.state = "REVIEWING";
      return run;
    }
    run.state = "READY_FOR_REVIEW";
    return run;
  }

  private async stepValidateReview(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const cycle = run.cycle;
    const file = this.reviewPath(run.loopId, cycle);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const identityLine = `${REVIEW_IDENTITY_PREFIX} ${run.loopId}#${cycle} ${run.sourceFingerprint}`;
    const reviewerIdentity = run.activeReviewerIdentity ?? "self:unknown";

    if (!text.trim()) {
      return this.reviewRejected(run, "REVIEW_ARTIFACT_MISSING", "the reviewer wrote no artifact for this cycle");
    }
    if (!text.includes(identityLine)) {
      // A previous run's report, or a report from another source revision. It is
      // not this run's evidence, so it is refused rather than reconciled.
      return this.reviewRejected(run, "STALE_REVIEW_ARTIFACT", "the review artifact does not carry this loop, cycle and source identity");
    }

    const parsed = normalizeZaicodeAuditReview(text);
    if (!parsed.ok) {
      const claimsClean = /"verdict"\s*:\s*"clean"/.test(text) || /\bverdict[:\s]+clean\b/i.test(text);
      if (claimsClean) {
        // Clean prose without the deterministic evidence it promised. The claim
        // is preserved as UNVERIFIED; it never advances the loop.
        this.writeReceipt(run, {
          cycle,
          reviewerMode: reviewerIdentity.startsWith("external:") ? "external" : "self",
          reviewerIdentity,
          verdict: "unverified",
          artifactSha256: sha256Of(text),
          deterministicChecks: [],
          unknowns: [parsed.detail],
          requiredValidation: ["deterministic checks with real exit codes"],
          remainingRisks: [],
          stopRecommendation: null,
          findings: [],
          receivedAt: this.now(),
        });
        return this.park(run, "WAITING_OPERATOR", "REVIEW_UNVERIFIED", `the reviewer claimed clean without evidence: ${parsed.detail}`);
      }
      return this.reviewRejected(run, `REVIEW_MALFORMED:${parsed.reason}`, parsed.detail);
    }

    const receipt: ZaicodeAuditLoopReviewReceipt = {
      cycle,
      reviewerMode: reviewerIdentity.startsWith("external:") ? "external" : "self",
      reviewerIdentity,
      verdict: parsed.verdict,
      artifactSha256: sha256Of(text),
      deterministicChecks: parsed.payload.deterministicChecks,
      unknowns: parsed.payload.unknowns,
      requiredValidation: parsed.payload.requiredValidation,
      remainingRisks: parsed.payload.remainingRisks,
      stopRecommendation: parsed.payload.stopRecommendation,
      findings: parsed.findings,
      receivedAt: this.now(),
    };
    this.writeReceipt(run, receipt);
    run.invalidReviewStreak = 0;

    // Before the verdict becomes actionable: the package the reviewer read must
    // still be the package on disk, and the source must still be the revision
    // the review is about. Otherwise the findings describe a different tree and
    // nothing derived from them may be applied (SRC-202 Phase 5).
    const integrity = this.verifyEvidence(run);
    if (!integrity.ok) return this.park(run, "WAITING_OPERATOR", integrity.code, integrity.detail);
    const current = await this.sourceFingerprintOf(run.workspacePath).catch(() => null);
    if (!current || current.fingerprint !== run.sourceFingerprint) {
      // Identity is re-read here on purpose: a verdict about a tree that moved
      // while the reviewer read it is a verdict about some other tree.
      return this.park(
        run,
        "WAITING_OPERATOR",
        "SOURCE_DRIFTED_DURING_REVIEW",
        `the source changed while the reviewer read it (${run.sourceFingerprint} -> ${current?.fingerprint ?? "unreadable"})`,
      );
    }

    if (parsed.verdict === "clean") {
      const gates = await this.runGates(run);
      const gate = zaicodeAuditLoopCleanConfirmed({ run, review: receipt, gates, reviewedSourceFingerprint: run.evidence?.sourceFingerprint ?? run.sourceFingerprint });
      if (!gate.confirmed) {
        return this.park(run, "WAITING_OPERATOR", "CLEAN_GATE_FAILED", gate.reason);
      }
      run.lastVerification = { cycle, jobId: run.pending?.jobId ?? null, checks: gates, acceptedAt: this.now(), detail: gate.reason };
      run.state = "CLEAN_CONFIRMED";
      run.pending = null;
      run.blocker = null;
      this.deps.logger?.info?.(`ZAICODE audit loop ${run.loopId}: CLEAN_CONFIRMED at cycle ${cycle}`);
      return run;
    }

    // Findings. They fold into the run's unresolved ledger, so a finding that is
    // never proven closed survives every later cycle and blocks a later clean
    // verdict. The identity set is what the no-progress guard reads.
    run.unresolvedFindings = zaicodeAuditLoopMergeFindings(run.unresolvedFindings, receipt.findings);
    run.progressFingerprints[String(cycle)] = zaicodeAuditLoopFindingsFingerprintFor(zaicodeAuditLoopUnresolvedFindings(run));
    const stop = zaicodeAuditLoopStopDecision(run);
    if (stop.stop) return this.park(run, stop.state!, stop.code!, stop.reason!);
    run.pending = null;
    run.state = "WAITING_FOR_REMEDIATION";
    return run;
  }

  private reviewRejected(run: ZaicodeAuditLoopRun, code: string, detail: string): ZaicodeAuditLoopRun {
    run.invalidReviewStreak += 1;
    run.retryBudget = Math.max(0, run.retryBudget - 1);
    const stop = zaicodeAuditLoopStopDecision(run);
    if (stop.stop) return this.park(run, stop.state!, stop.code!, stop.reason!);
    run.pending = null;
    run.state = "READY_FOR_REVIEW";
    this.deps.logger?.warn?.(`ZAICODE audit loop ${run.loopId}: review rejected (${code}): ${detail}`);
    return run;
  }

  private async runGates(run: ZaicodeAuditLoopRun): Promise<{ command: string; exitCode: number }[]> {
    if (!this.deps.runGates) return [];
    try {
      return await this.deps.runGates(run);
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audit loop: acceptance gate run failed", error);
      return [{ command: "acceptance-gates", exitCode: 1 }];
    }
  }

  /**
   * Who receives this cycle's remediation. The original executor is preferred
   * because the findings belong to its context; a generic implementer is an
   * explicit FALLBACK, and the route is persisted so nothing downstream can
   * describe that fallback as a continuation of the original session.
   */
  private async resolveRemediationExecutor(
    run: ZaicodeAuditLoopRun,
  ): Promise<{ agentId: string; route: "original_executor" | "authorized_fallback" } | null> {
    const original = await this.deps.agentService.get(run.originalExecutor.agentId).catch(() => null);
    const job = await this.deps.jobService.get(run.originalExecutor.jobId).catch(() => null);
    // The original context is only a valid target while it still exists and the
    // audited job really is this workspace's job for this agent.
    if (original && job && job.workspaceKey === run.workspaceKey && job.agentId === run.originalExecutor.agentId) {
      return { agentId: original.id, route: "original_executor" };
    }
    const fallback = await this.ensureAgent("implementer");
    return fallback ? { agentId: fallback, route: "authorized_fallback" } : null;
  }

  private async stepDispatchRemediation(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const findings = zaicodeAuditLoopUnresolvedFindings(run);
    if (findings.length === 0) {
      run.state = "READY_FOR_REVIEW";
      return run;
    }
    // Findings may be delivered, but the source is mutated only when it is
    // proven that no other owner holds it. An unprovable answer refuses.
    const refusal = await this.ownershipRefusal(run.workspacePath);
    if (refusal) return this.park(run, "WAITING_OPERATOR", refusal.code, refusal.reason);

    const target = await this.resolveRemediationExecutor(run);
    if (!target) return this.fail(run, "EXECUTOR_AGENT_UNAVAILABLE", "no remediation executor could be resolved");

    const provenance = zaicodeAuditLoopFeedbackProvenance(run);
    const title = auditLoopJobTitle(run.loopId, run.cycle, "fix");
    const reportFile = this.fixReportPath(run.loopId, run.cycle);
    const instructions = [
      ...buildZaicodeAuditLoopRemediationProtocol(),
      "",
      "## What this work is",
      `The original task ${run.originalTaskId} for ${run.projectName} was audited and this cycle produced validated findings.`,
      `Original executor identity: ${run.originalExecutor.agentId} (job ${run.originalExecutor.jobId}).`,
      `Evidence package: ${run.evidence?.packageFile ?? "(missing)"}`,
      `Evidence digest: ${run.evidence?.digest ?? "(missing)"}`,
      `Source identity this review was made against: ${run.sourceFingerprint}`,
      "",
      "## Routing",
      target.route === "original_executor"
        ? `This remediation returns to the original executor ${target.agentId}, whose context the audited work belongs to.`
        : `The original executor ${run.originalExecutor.agentId} could not receive this work; it is dispatched to an authorized implementer (${target.agentId}) as an explicit FALLBACK. This is NOT a continuation of the original session.`,
      "",
      "## Provenance (authoritative)",
      "This message is AGENT/RUNTIME-ORIGINATED audit feedback. It is not a new human instruction,",
      "it grants no additional human authorization, and it does not replace the original goal.",
      JSON.stringify(provenance, null, 2),
      "",
      "## Findings to verify and address",
      ...findings.map((finding, index) => formatFinding(finding, index)),
      "",
      "## Where your report goes",
      "Write one remediation report to this exact file, creating it:",
      reportFile,
      `Identity line (verbatim): ${ZAICODE_AUDIT_LOOP_FIX_IDENTITY_PREFIX} ${run.loopId}#${run.cycle}`,
      `One ${ZAICODE_AUDIT_LOOP_FIX_BEGIN} ... ${ZAICODE_AUDIT_LOOP_FIX_END} block holding JSON:`,
      '  { "findings": [{ "id", "claim": "fixed"|"rejected"|"deferred", "evidence", "command"?, "exitCode"? }] }',
      "Report EVERY finding above, each with its id and the exact evidence: a finding you do not report stays OPEN.",
      `The report must end with exactly: ${ZAICODE_AUDIT_LOOP_FIX_TERMINAL_LINE}`,
    ].join("\n");

    run.pending = {
      kind: "remediation",
      jobId: null,
      idempotencyKey: `${run.loopId}:${run.cycle}:fix`,
      attempt: (run.pending?.attempt ?? 0) + 1,
      startedAt: this.now(),
    };
    run.state = "REMEDIATING";
    this.saveRun(run);
    const dispatched = await this.dispatchOnce({
      workspaceKey: run.workspaceKey,
      workspacePath: run.workspacePath,
      agentId: target.agentId,
      title,
      instructions,
    });
    if (!dispatched) return this.fail(run, "REMEDIATION_DISPATCH_FAILED", "the remediation job could not be queued");
    run.pending.jobId = dispatched.id;
    run.remediation = {
      cycle: run.cycle,
      jobId: dispatched.id,
      agentId: dispatched.agentId,
      route: target.route,
      dispatchedAt: this.now(),
      completedAt: null,
      outcome: null,
    };
    this.deps.logger?.info?.(
      `ZAICODE audit loop ${run.loopId} cycle ${run.cycle}: remediation dispatched as ${dispatched.id} (${target.route})`,
    );
    return run;
  }

  private async stepAwaitRemediation(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const jobId = run.pending?.jobId ?? run.remediation?.jobId ?? null;
    if (!jobId) {
      const title = auditLoopJobTitle(run.loopId, run.cycle, "fix");
      const existing = await this.deps.jobService.list({ workspaceKey: run.workspaceKey }).catch(() => null);
      const found = existing?.jobs.find((candidate) => candidate.title === title) ?? null;
      if (found && found.status !== "completed") {
        // Reconcile the job that already exists; never send a second one.
        run.pending = { ...(run.pending ?? { kind: "remediation", idempotencyKey: `${run.loopId}:${run.cycle}:fix`, attempt: 1, startedAt: this.now() }), jobId: found.id };
        return run;
      }
      run.state = "WAITING_FOR_REMEDIATION";
      return run;
    }
    const job = await this.deps.jobService.get(jobId).catch(() => null);
    if (!job) return this.fail(run, "REMEDIATION_JOB_LOST", "the remediation job vanished from the durable queue");
    if (!["completed", "failed", "cancelled", "blocked"].includes(job.status)) return run;
    if (job.status !== "completed") {
      return this.fail(run, "REMEDIATION_FAILED", `the remediation job ended as ${job.status}`);
    }
    if (run.remediation) {
      run.remediation.completedAt = this.now();
      // The report is read HERE, from the file the prompt named, so a completed
      // job that produced no report is a recorded fact and never a silent pass.
      const reportPath = this.fixReportPath(run.loopId, run.cycle);
      const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      const expected = zaicodeAuditLoopUnresolvedFindings(run).map((finding) => finding.id);
      const parsed = normalizeZaicodeAuditLoopFixReport(reportText, expected);
      run.remediation.outcome = parsed.ok
        ? `${parsed.report.entries.length}/${expected.length} finding(s) reported; ${job.resultSummary ?? "completed"}`
        : `report unusable: ${parsed.reason}`;
    }
    run.state = "VERIFYING_FIX";
    return run;
  }

  private async stepVerifyFix(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const gates = await this.runGates(run);
    if (gates.length === 0) {
      // A fix verified by nothing is not verified at all.
      return this.fail(run, "FIX_VERIFICATION_FAILED", "no deterministic verification gate ran for this fix");
    }
    const failing = gates.filter((gate) => gate.exitCode !== 0);
    // Per-finding verification. Generic gates alone never close a finding: the
    // only finding-level evidence is the executor's own report, and this layer
    // converts its CLAIMS into dispositions. A finding it did not report stays
    // open; a claim without evidence is UNVERIFIED; a claim contradicted by a
    // failing gate is downgraded. Nothing here invents closure (SRC-202 Phase 6).
    const ledger = zaicodeAuditLoopUnresolvedFindings(run);
    const reportPath = this.fixReportPath(run.loopId, run.cycle);
    const raw = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const parsed = normalizeZaicodeAuditLoopFixReport(raw, ledger.map((finding) => finding.id));
    const entryById = new Map(parsed.report.entries.map((entry) => [entry.id, entry]));
    for (const finding of run.unresolvedFindings) {
      if (zaicodeAuditLoopFindingIsResolved(finding.disposition)) continue;
      const entry = entryById.get(finding.id);
      const disposition = zaicodeAuditLoopVerifyFindingClaim(finding, entry);
      finding.disposition = disposition === "FIXED_VERIFIED" && failing.length > 0 ? "UNVERIFIED" : disposition;
      if (entry?.evidence) finding.resolution = entry.evidence;
    }
    const resolved = ledger.map((finding) => `${finding.id}=${finding.disposition}`).join(", ");
    run.lastVerification = {
      cycle: run.cycle,
      jobId: run.pending?.jobId ?? run.remediation?.jobId ?? null,
      checks: gates,
      acceptedAt: this.now(),
      detail: parsed.ok
        ? `per-finding verification: ${resolved}${failing.length > 0 ? `; a gate failed (${failing[0]!.command} exited ${failing[0]!.exitCode})` : ""}`
        : `the remediation report was unusable (${parsed.reason}); every finding stays open or unverified`,
    };
    run.pending = null;
    run.cycle += 1;
    run.state = "READY_FOR_NEXT_CYCLE";
    return run;
  }

  private async stepNextCycle(run: ZaicodeAuditLoopRun): Promise<ZaicodeAuditLoopRun> {
    const stop = zaicodeAuditLoopStopDecision(run);
    if (stop.stop) return this.park(run, stop.state!, stop.code!, stop.reason!);
    if (!run.settings.autoAudits) {
      return this.park(run, "WAITING_OPERATOR", "AUDIT_MODE_DISABLED", "the project's automatic audit mode was switched off mid-run");
    }
    run.state = "SNAPSHOTTING";
    return run;
  }

  private fail(run: ZaicodeAuditLoopRun, code: string, reason: string): ZaicodeAuditLoopRun {
    run.retryBudget = Math.max(0, run.retryBudget - 1);
    const stop = zaicodeAuditLoopStopDecision(run);
    if (stop.stop) return this.park(run, stop.state!, stop.code ?? code, stop.reason ?? reason);
    return this.park(run, "FAILED_RECOVERABLE", code, reason);
  }

  private writeReceipt(run: ZaicodeAuditLoopRun, receipt: ZaicodeAuditLoopReviewReceipt): void {
    run.reviews = [...run.reviews.filter((entry) => entry.cycle !== receipt.cycle), receipt].sort((a, b) => a.cycle - b.cycle);
    const path = this.receiptPath(run.loopId, receipt.cycle);
    // Immutable: an existing receipt is never rewritten, so history cannot be
    // edited by a later cycle or by a recovered process.
    if (existsSync(path)) return;
    try {
      ZaicodeAuditLoopService.writeJsonAtomic(path, receipt);
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audit loop: could not persist the review receipt", error);
    }
  }

  // -------------------------------------------------------------------------
  // Operator surface
  // -------------------------------------------------------------------------

  async getState(): Promise<{ runs: ZaicodeAuditLoopRun[]; settings: ZaicodeAuditLoopSettings }> {
    await this.reconcile();
    return { runs: this.loadRuns(), settings: this.readSettings() };
  }

  async getRun(loopId: string): Promise<ZaicodeAuditLoopRun | null> {
    return this.findRun(loopId);
  }

  async describe(loopId: string): Promise<{ state: ZaicodeAuditLoopState; label: string; openFindings: number } | null> {
    const run = this.findRun(loopId);
    if (!run) return null;
    return { state: run.state, label: describeZaicodeAuditLoopState(run.state), openFindings: zaicodeAuditLoopUnresolvedFindings(run).length };
  }

  async readEvidence(loopId: string, cycle?: number): Promise<string | null> {
    const run = this.findRun(loopId);
    const target = cycle ?? run?.evidence?.cycle;
    if (target === undefined) return null;
    const file = this.evidenceFile(loopId, target);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  async readReviewArtifact(loopId: string, cycle: number): Promise<string | null> {
    const file = this.reviewPath(loopId, cycle);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  async cancel(loopId: string): Promise<ZaicodeAuditLoopRun | null> {
    return this.withRun(loopId, async () => {
      const run = this.findRun(loopId);
      if (!run || zaicodeAuditLoopIsTerminal(run.state)) return run;
      const jobId = run.pending?.jobId ?? null;
      if (jobId) {
        const job = await this.deps.jobService.get(jobId).catch(() => null);
        if (job && !["completed", "failed", "cancelled"].includes(job.status)) {
          // A cancellation that the queue refuses leaves the run non-terminal,
          // exactly like the A3 campaign: the loop does not claim to have
          // stopped work that is still running.
          try {
            await this.deps.jobService.cancel(jobId);
          } catch (error) {
            run.blocker = {
              code: "CANCEL_STOP_FAILED",
              reason: error instanceof Error ? error.message : String(error),
              since: this.now(),
            };
            this.saveRun(run);
            return this.findRun(loopId) ?? run;
          }
        }
      }
      run.state = "CANCELLED";
      run.pending = null;
      run.blocker = null;
      this.saveRun(run);
      return this.findRun(loopId) ?? run;
    });
  }

  async resume(loopId: string): Promise<ZaicodeAuditLoopRun | null> {
    return this.withRun(loopId, async () => {
      const run = this.findRun(loopId);
      if (!run || zaicodeAuditLoopIsTerminal(run.state)) return run;
      // An EXPLICIT human resume is the only thing that refills the step budget;
      // nothing refills it silently, and the cycle counter is never reset.
      run.retryBudget = ZAICODE_AUDIT_LOOP_RETRY_BUDGET;
      run.invalidReviewStreak = 0;
      run.blocker = null;
      run.state = run.evidence ? "READY_FOR_REVIEW" : "SNAPSHOTTING";
      run.pending = null;
      this.saveRun(run);
      return this.findRun(loopId) ?? run;
    });
  }

  async reconcile(): Promise<{ advanced: string[]; parked: string[] }> {
    const advanced: string[] = [];
    const parked: string[] = [];
    for (const run of this.loadRuns()) {
      if (zaicodeAuditLoopIsTerminal(run.state) || run.state === "DISABLED") continue;
      const next = await this.advance(run.loopId).catch(() => null);
      if (!next) continue;
      if (STOP_STATES.includes(next.state)) parked.push(next.loopId);
      else advanced.push(next.loopId);
    }
    return { advanced, parked };
  }

  dispose(): void {
    this.writeLocks.clear();
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** The one queue-title namespace this loop owns; the host never audits such a job. */
export const AUDIT_LOOP_JOB_PREFIX = "AuditLoop ";

export function auditLoopJobTitle(loopId: string, cycle: number, kind: "review" | "fix"): string {
  // The cycle and step are IN the title, so the find-then-create lookup can
  // adopt this attempt's job after a crash while a retry is still a new job.
  return `${AUDIT_LOOP_JOB_PREFIX}${loopId} c${cycle} ${kind}`;
}

/** Content identity of a scanned workspace: byte-level, order-independent. */
export function zaicodeAuditLoopSourceFingerprintOf(files: readonly { path: string; text: string }[]): string {
  const hashed = files.map((file) => ({ path: file.path, sha256: sha256Of(file.text) }));
  const canonical = hashed
    .map((file) => `${file.path}\u0000${file.sha256}`)
    .sort()
    .join("\n");
  return `content-sha256:${sha256Of(canonical)}`;
}

function formatFinding(finding: ZaicodeAuditLoopFinding, index: number): string {
  return [
    `### ${finding.id} (${finding.severity})`,
    `- Location: ${finding.location}`,
    `- Evidence: ${finding.evidence}`,
    `- Expected: ${finding.expected}`,
    `- Observed: ${finding.observed}`,
    `- Reproduction: ${finding.reproduction}`,
    `- Acceptance: ${finding.acceptance}`,
    `- Index: ${index + 1}`,
  ].join("\n");
}
