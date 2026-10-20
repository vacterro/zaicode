/* oxlint-disable eslint(max-lines) -- A3 活动、wave 队列和 Auto 恢复共用持久化锁与原子写入边界；拆开会增加重复调度风险。 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ZAICODE_AUDIT_PROFILE,
  ZAICODE_JOB_GLOBAL_CONCURRENCY_DEFAULT,
  buildZaicodeQuick3WavePrompt,
  countZaicodeOpenBoardTickets,
  createZaicodeAuditBatchId,
  formatZaicodeModelLabel,
  normalizeZaicodeAutoProjects,
  parseModelPickerValue,
  resolveZaicodeAutoPolicy,
  shouldStartZaicodeAuditCampaign,
  synthesizeZaicodeAuditCombined,
  zaicodeAuditCampaignIsActive,
  zaicodeAuditCombinedFileName,
  zaicodeAuditIdempotencyKey,
  zaicodeAuditProfileManifestHash,
  zaicodeAuditQuick3Wave,
  zaicodeAuditWaveFileName,
  validateZaicodeAuditArtifact,
  type ModelSelection,
  type ZaicodeAuditBatch,
  type ZaicodeAuditPostAuditPolicy,
  type ZaicodeAuditBatchAdmissionResult,
  type ZaicodeAuditBatchModelPolicy,
  type ZaicodeAuditBatchProjectAdmission,
  type ZaicodeAuditCampaign,
  type ZaicodeAuditCampaignWaveState,
  type ZaicodeAuditWorker,
  type ZaicodeAuditorView,
  type ZaicodeAuditsReport,
  type ZaicodeAutoPolicy,
  type ZaicodeAutoProjects,
  type ZaicodeJob,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import type { IZaicodeAgentService } from "./zaicodeAgents.js";
import type { IZaicodeAuditService } from "./zaicodeAudits.js";
import type { IZaicodeJobService } from "./zaicodeJobs.js";

/**
 * ZAICODE A3 audit service (T-66, SRC-049; Wave 5 = the Quick3 contract).
 * AUDAPACK's campaign machine on ZAICODE's own durable queue, not a prompt
 * pasted into chat: a campaign is three waves, each an ordinary queue job
 * (lease, retry, parallelism come with the queue), whose output is judged by
 * the Quick3 report gate and whose combined handoff is synthesized only after
 * all three artifacts are durable and hash-verified.
 *
 * Three rules the whole class exists to keep:
 *
 * 1. A wave advances on a VALIDATED artifact, never on a finished job. The
 *    gate never repairs: a report without its terminal line is rejected with a
 *    reason, not fixed, because a marker this service injected would make the
 *    gate agree with a report the model never wrote.
 * 2. A wave is dispatched exactly once per attempt, and a crash never produces
 *    a second Core. The dispatch intent is persisted BEFORE the queue write,
 *    and the job title is derived from (campaign, wave, attempt), so recovery
 *    adopts the job that exists instead of sending another.
 * 3. A failure retries the SAME wave. The wave index is never advanced by a
 *    failure -- progress is the count of saved, hash-verified artifacts.
 */

const execFileAsync = promisify(execFile);

interface ZaicodeAuditServiceDeps {
  jobService: IZaicodeJobService;
  agentService: IZaicodeAgentService;
  /**
   * T-398: the wave's own last sign of life. The queue's `heartbeat_at` is the
   * host lease (one timer renews every running row of a host), so the supervisor
   * must read the session projection instead. Optional: a host that cannot
   * supply it reports `unknown`, never a borrowed zero.
   */
  sessionActivityAt?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  }) => number | null;
  /** Test/host hook: where campaign state and reports live. */
  rootDir?: () => string;
  /** Test hook for the SAIPEN board reader. */
  readBoard?: (workspacePath: string) => string | null;
  logger?: { warn(message: string, error?: unknown): void; info?(message: string): void };
}

interface SmartProject {
  workspaceKey: string;
  workspacePath: string;
  projectName: string;
  disabled?: boolean;
  runningSessions?: number;
  /** SAIPEN's read model explicitly reports every ticket closed. */
  noWorkConfirmed?: boolean;
}

interface SmartSettings {
  smartMode: boolean;
  autoProjects: ZaicodeAutoProjects;
  autoAudits: boolean;
  maxCycles: number;
  runId: string | null;
  /**
   * SRC-151:R008: the global "generate the next wave by itself" switch. Absent
   * means ON, so every campaign that exists today keeps advancing exactly as
   * before and only an operator who turns it off sees a different behaviour.
   */
  autoWaves: boolean;
}

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class ZaicodeAuditService implements IZaicodeAuditService {
  private readonly writeLocks = new Map<string, Promise<void>>();
  private readonly batchAdmissionLocks = new Map<string, Promise<unknown>>();
  private smartProjects: SmartProject[] = [];
  private auditAgentId: string | null = null;
  private remediationAgentId: string | null = null;
  private smartSweepRunning = false;

  constructor(private readonly deps: ZaicodeAuditServiceDeps) {
    this.deps.jobService.setDispatchFilter?.((job) => this.canDispatchJob(job));
    this.deps.jobService.setBatchCapacityResolver?.((batchId) => {
      const batch = this.findBatchDirect(batchId);
      return batch?.workerCapacity ?? null;
    });
  }

  private root(): string {
    return this.deps.rootDir?.() ?? join(getAppConfigDir(), "zaicode-audits");
  }

  private campaignDir(campaignId: string): string {
    return join(this.root(), campaignId);
  }

  private campaignFile(campaignId: string): string {
    return join(this.campaignDir(campaignId), "campaign.json");
  }

  private batchesDir(): string {
    return join(this.root(), "batches");
  }

  private batchFile(batchId: string): string {
    return join(this.batchesDir(), `${batchId}.json`);
  }

  private settingsPath(): string {
    return join(this.root(), "settings.json");
  }

  private static safeName(name: string): string {
    return name.replace(/[^\w.-]+/g, "_").slice(0, 48) || "project";
  }

  /** Wave artifact names come from the profile, not from a hand-built string. */
  private static waveFileNameFor(projectName: string, waveId: string): string {
    return zaicodeAuditWaveFileName(ZaicodeAuditService.safeName(projectName), waveId);
  }

  private static waveFileName(campaign: ZaicodeAuditCampaign, waveId: string): string {
    return ZaicodeAuditService.waveFileNameFor(campaign.projectName, waveId);
  }

  private static combinedFileName(campaign: ZaicodeAuditCampaign): string {
    return zaicodeAuditCombinedFileName(ZaicodeAuditService.safeName(campaign.projectName));
  }

  private static writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  }

  /** The combined handoff is durable evidence, so it is written atomically too. */
  private static writeTextAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  }

  private static readJson<T>(path: string): T | null {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** One writer per campaign; reconcile is called from the poller and IPC alike. */
  private withCampaign<T>(campaignId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(campaignId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.writeLocks.set(
      campaignId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private withBatchAdmission<T>(requestId: string, run: () => Promise<T>): Promise<T> {
    const previous = (this.batchAdmissionLocks.get(requestId) ?? Promise.resolve()) as Promise<unknown>;
    let cleanupPromise: Promise<unknown>;
    const next = previous.then(run, run);
    cleanupPromise = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.batchAdmissionLocks.get(requestId) === cleanupPromise) {
          this.batchAdmissionLocks.delete(requestId);
        }
      });
    this.batchAdmissionLocks.set(requestId, cleanupPromise);
    return next;
  }

  /**
   * Newest first. Every active campaign always reconciles; finished ones are
   * capped to the newest HISTORY_CAP so the list (and the renderer mirror)
   * cannot grow without bound — old campaign dirs and reports stay on disk.
   */
  private static readonly HISTORY_CAP = 30;

  private loadCampaigns(includeAll = false): ZaicodeAuditCampaign[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const campaigns: ZaicodeAuditCampaign[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const campaign = ZaicodeAuditService.readJson<ZaicodeAuditCampaign>(join(root, entry.name, "campaign.json"));
      // v1 (the pre-Quick3 record) still loads so its history stays readable;
      // the service never writes one back.
      if (campaign && (campaign.schemaVersion === 1 || campaign.schemaVersion === 2) && (includeAll || !campaign.archivedAt)) campaigns.push(campaign);
    }
    campaigns.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    const active = campaigns.filter(zaicodeAuditCampaignIsActive);
    const finished = campaigns.filter((campaign) => !zaicodeAuditCampaignIsActive(campaign)).slice(0, includeAll ? undefined : ZaicodeAuditService.HISTORY_CAP);
    return [...active, ...finished].sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  /**
   * Authoritative campaign lookup by ID: reads the exact durable campaign file
   * directly without applying UI history caps or directory scans.
   */
  private findCampaign(campaignId: string): ZaicodeAuditCampaign | null {
    const file = this.campaignFile(campaignId);
    if (!existsSync(file)) return null;
    const campaign = ZaicodeAuditService.readJson<ZaicodeAuditCampaign>(file);
    if (campaign && (campaign.schemaVersion === 1 || campaign.schemaVersion === 2)) {
      return campaign;
    }
    return null;
  }

  private findBatchDirect(batchId: string): ZaicodeAuditBatch | null {
    const file = this.batchFile(batchId);
    if (!existsSync(file)) return null;
    const batch = ZaicodeAuditService.readJson<ZaicodeAuditBatch>(file);
    if (batch && batch.schemaVersion === 1) return batch;
    return null;
  }

  private async canDispatchJob(job: ZaicodeJob): Promise<boolean> {
    const meta = job.auditMetadata ?? (() => {
      const match = /\[([a-zA-Z0-9_-]+)#\d+\]/.exec(job.title);
      return match?.[1] ? { campaignId: match[1], waveId: "core", attempt: 0, batchId: undefined } : null;
    })();
    if (!meta || !meta.campaignId) return true;
    const campaignId = meta.campaignId;
    const campaign = this.findCampaign(campaignId);
    if (!campaign) {
      this.deps.logger?.warn(
        `ZAICODE audits: audit job ${job.id} refused dispatch. Campaign ${campaignId} missing from disk.`,
      );
      return false;
    }

    if (job.workspaceKey && campaign.workspaceKey !== job.workspaceKey) {
      this.deps.logger?.warn(
        `ZAICODE audits: job ${job.id} workspaceKey mismatch: job=${job.workspaceKey}, campaign=${campaign.workspaceKey}.`,
      );
      return false;
    }
    if (job.workspacePath && campaign.workspacePath !== job.workspacePath) {
      this.deps.logger?.warn(
        `ZAICODE audits: job ${job.id} workspacePath mismatch: job=${job.workspacePath}, campaign=${campaign.workspacePath}.`,
      );
      return false;
    }

    if (meta.waveId) {
      const waveState = campaign.waves.find((w) => w.waveId === meta.waveId);
      if (!waveState) {
        this.deps.logger?.warn(
          `ZAICODE audits: job ${job.id} refers to non-existent wave ${meta.waveId} in campaign ${campaignId}.`,
        );
        return false;
      }
      if (
        meta.attempt !== undefined &&
        waveState.attempt !== undefined &&
        meta.attempt !== waveState.attempt &&
        !(meta.attempt === 0 && waveState.attempt === 1)
      ) {
        this.deps.logger?.warn(
          `ZAICODE audits: job ${job.id} attempt ${meta.attempt} is stale (campaign current attempt: ${waveState.attempt}).`,
        );
        return false;
      }
    }

    const declaredBatchId = ("batchId" in meta ? meta.batchId : undefined) ?? campaign.batchId;

    if (!declaredBatchId) {
      // Standalone audit
      if (campaign.status === "cancelled" || campaign.status === "complete") {
        return false;
      }
      return true;
    }

    // Batch-owned audit job: verify durable owner lineage and batch lifecycle
    if (campaign.batchId !== declaredBatchId) {
      this.deps.logger?.warn(
        `ZAICODE audits: orphan batch-owned job ${job.id} refused dispatch. Campaign ${campaignId} mismatched with batch ${declaredBatchId}.`,
      );
      return false;
    }

    const batch = this.findBatchDirect(declaredBatchId);
    if (!batch) {
      this.deps.logger?.warn(
        `ZAICODE audits: orphan batch-owned job ${job.id} refused dispatch. Parent batch ${declaredBatchId} missing from disk.`,
      );
      return false;
    }

    const campaignRegistered = batch.campaignIds.includes(campaignId);
    const projectAdmission = batch.projects.find((p) => p.workspaceKey === campaign.workspaceKey);
    if (!projectAdmission) {
      this.deps.logger?.warn(
        `ZAICODE audits: unlinked batch-owned job ${job.id} refused dispatch. Workspace ${campaign.workspaceKey} not found in batch ${declaredBatchId} projects.`,
      );
      return false;
    }

    if (projectAdmission.workspacePath && campaign.workspacePath !== projectAdmission.workspacePath) {
      this.deps.logger?.warn(
        `ZAICODE audits: batch-owned job ${job.id} path disagreement: campaign=${campaign.workspacePath}, batchAdmission=${projectAdmission.workspacePath}.`,
      );
      return false;
    }

    if (projectAdmission.campaignId && projectAdmission.campaignId !== campaignId) {
      this.deps.logger?.warn(
        `ZAICODE audits: batch-owned job ${job.id} campaign mismatch for workspace ${campaign.workspaceKey}: campaign=${campaignId}, admission=${projectAdmission.campaignId}.`,
      );
      return false;
    }

    if (!campaignRegistered) {
      this.deps.logger?.warn(
        `ZAICODE audits: uncommitted batch-owned job ${job.id} refused dispatch. Campaign ${campaignId} not settled into batch.campaignIds.`,
      );
      return false;
    }

    if (batch.status !== "running" && batch.status !== "admitting") {
      return false;
    }

    if (campaign.status === "cancelled" || campaign.status === "complete" || campaign.status === "blocked") {
      return false;
    }

    if (batch.workerCapacity) {
      const workers = await this.getActiveWorkers();
      const runningInThisBatch = workers.filter((w) => w.batchId === batch.batchId).length;
      if (runningInThisBatch >= batch.workerCapacity) {
        return false;
      }
    }
    return true;
  }

  private saveCampaign(campaign: ZaicodeAuditCampaign): void {
    campaign.updatedAt = new Date().toISOString();
    ZaicodeAuditService.writeJsonAtomic(this.campaignFile(campaign.campaignId), campaign);
  }

  private readSmartSettings(): SmartSettings {
    const raw = ZaicodeAuditService.readJson<Partial<SmartSettings>>(this.settingsPath());
    const maxCycles = Number.isInteger(raw?.maxCycles) ? Math.max(1, Math.min(10, raw!.maxCycles!)) : 10;
    return {
      smartMode: raw?.smartMode === true,
      autoProjects: normalizeZaicodeAutoProjects(raw?.autoProjects),
      autoAudits: raw?.autoAudits !== false,
      maxCycles,
      runId: typeof raw?.runId === "string" && raw.runId ? raw.runId : null,
      autoWaves: (raw as { autoWaves?: unknown } | null)?.autoWaves !== false,
    };
  }

  private countOpenBoardTickets(workspacePath: string): number | null {
    const board = this.deps.readBoard
      ? this.deps.readBoard(workspacePath)
      : (() => {
          const path = join(workspacePath, ".saipen", "BOARD.md");
          return existsSync(path) ? readFileSync(path, "utf8") : null;
        })();
    return board === null ? null : countZaicodeOpenBoardTickets(board);
  }

  private async runningJobCount(): Promise<number> {
    try {
      const result = await this.deps.jobService.list({ status: "running" });
      return result.jobs.length;
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audits: running-count read failed", error);
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /**
   * What is being audited, frozen for the whole campaign: HEAD plus a digest
   * of the dirty state. A project that is not a repository says so rather than
   * inventing an identity, and a later Fix job records the drift against this.
   */
  private async sourceIdentityOf(workspacePath: string): Promise<string> {
    const git = async (args: string[]): Promise<string | null> => {
      try {
        const { stdout } = await execFileAsync("git", args, { cwd: workspacePath, timeout: 5000, windowsHide: true });
        return stdout.trim();
      } catch {
        return null;
      }
    };
    const head = await git(["rev-parse", "HEAD"]);
    if (!head) return `no-git:${workspacePath}`;
    const status = await git(["status", "--porcelain"]);
    return `git:${head}:${sha256Of(status ?? "").slice(0, 16)}`;
  }

  /** Resolve (once) the agent that runs audit waves: an existing auditor, or one from the template. */
  private async ensureAuditAgent(): Promise<string | null> {
    if (this.auditAgentId) return this.auditAgentId;
    try {
      const { agents } = await this.deps.agentService.list();
      const existing = agents.find((agent) => agent.role === "auditor");
      if (existing) {
        this.auditAgentId = existing.id;
        return existing.id;
      }
      const created = await this.deps.agentService.createFromTemplate("zaicode-template:auditor");
      this.auditAgentId = created.id;
      return created.id;
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audits: could not resolve an auditor agent", error);
      return null;
    }
  }

  private async resolveAuditAgentForModel(
    requestedModel?: string | null,
    policy?: ZaicodeAuditBatchModelPolicy | null,
  ): Promise<{ ok: true; agentId: string; effectiveModel: string } | { ok: false; reason: string }> {
    const defaultAgentId = await this.ensureAuditAgent();
    if (!requestedModel) {
      if (!defaultAgentId) return { ok: false, reason: "No default auditor agent available" };
      return { ok: true, agentId: defaultAgentId, effectiveModel: "default" };
    }

    try {
      if (requestedModel.startsWith("unavailable") || requestedModel.includes(":unavailable")) {
        throw new Error(`Model ${requestedModel} is unavailable`);
      }
      const { agents } = await this.deps.agentService.list();
      const existing = agents.find(
        (agent) =>
          agent.role === "auditor" &&
          (agent.modelRef === requestedModel ||
            formatZaicodeModelLabel(agent.modelSelection, agent) === requestedModel ||
            agent.modelSelection?.modelId === requestedModel),
      );
      if (existing) {
        return { ok: true, agentId: existing.id, effectiveModel: requestedModel };
      }

      let providerRef: string | undefined;
      let modelRef: string = requestedModel;
      let modelSelection: ModelSelection | undefined;
      try {
        if (requestedModel.includes("/")) {
          modelSelection = parseModelPickerValue(requestedModel);
          providerRef = modelSelection.providerId;
          modelRef = modelSelection.modelId;
        }
      } catch {
        // Not a slash-delimited picker string; use bare modelRef
      }

      const created = await this.deps.agentService.createFromTemplate(
        "zaicode-template:auditor",
        `Auditor (${requestedModel})`,
      );
      await this.deps.agentService.update(created.id, {
        modelRef,
        providerRef,
        modelSelection,
      });
      return { ok: true, agentId: created.id, effectiveModel: requestedModel };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn(`ZAICODE audits: could not configure auditor for ${requestedModel}: ${reason}`);
      if (policy?.allowFallback) {
        const fallbackTarget = policy.fallbackModel ?? "default";
        if (policy.fallbackModel && policy.fallbackModel !== requestedModel) {
          const fallbackRes = await this.resolveAuditAgentForModel(policy.fallbackModel, { allowFallback: false });
          if (fallbackRes.ok) {
            return { ok: true, agentId: fallbackRes.agentId, effectiveModel: fallbackRes.effectiveModel };
          }
        }
        if (defaultAgentId) {
          return { ok: true, agentId: defaultAgentId, effectiveModel: fallbackTarget };
        }
      }
      return {
        ok: false,
        reason: `Model ${requestedModel} configuration failed: ${reason}`,
      };
    }
  }

  private async ensureAuditAgentForModel(requestedModel?: string | null): Promise<string | null> {
    const res = await this.resolveAuditAgentForModel(requestedModel, { allowFallback: true });
    return res.ok ? res.agentId : null;
  }

  private async ensureRemediationAgent(): Promise<string | null> {
    if (this.remediationAgentId) return this.remediationAgentId;
    try {
      const { agents } = await this.deps.agentService.list();
      const existing = agents.find((agent) => agent.role === "implementer");
      const agent = existing ?? await this.deps.agentService.createFromTemplate("zaicode-template:implementer");
      this.remediationAgentId = agent.id;
      return agent.id;
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audits: could not resolve an implementer agent", error);
      return null;
    }
  }

  /**
   * Put one wave on the queue, exactly once for this attempt.
   *
   * The intent is persisted BEFORE the queue write. A crash in between leaves
   * a wave marked running with no job id; recovery re-enters here with the SAME
   * attempt, and the derived title finds the job that may or may not exist —
   * adopting it if it does, creating it if it does not. Either way exactly one
   * Core goes out.
   */
  /**
   * T-244 / SRC-160:R004: a rejected cancel is the queue saying the runtime stop really
   * failed — it keeps the worker's handle and writes `cancel_stop_failed` on the row, and
   * `ZaicodeJobService.retry` refuses that row for exactly that reason. Treating such a
   * refusal as "stopped" would move the campaign on (or launch the next wave) over a live
   * worker, so the wave keeps its job id and records why nothing happened; the caller
   * stays where it is.
   */
  private async stopWaveJob(jobId: string, state: ZaicodeAuditCampaign["waves"][number]): Promise<boolean> {
    try {
      await this.deps.jobService.cancel(jobId);
      return true;
    } catch (error) {
      state.rejectReason = `the running task could not be stopped: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  private async enqueueWave(campaign: ZaicodeAuditCampaign, waveIndex: number): Promise<void> {
    const state = campaign.waves[waveIndex];
    const wave = state ? zaicodeAuditQuick3Wave(state.waveId) : null;
    if (!state || !wave) return;

    if (campaign.batchId) {
      const batch = this.findBatchDirect(campaign.batchId);
      if (batch && batch.status === "paused") {
        campaign.status = "planned";
        campaign.autoAdvanceHeld = true;
        this.saveCampaign(campaign);
        return;
      }
    }

    const waveId = wave.id as "core" | "second" | "performance";
    const requestedModel =
      campaign.modelPolicy?.waveModels?.[waveId] ??
      campaign.modelPolicy?.defaultModel ??
      null;
    const modelResolution = await this.resolveAuditAgentForModel(requestedModel, campaign.modelPolicy);
    if (!modelResolution.ok) {
      state.status = "blocked";
      state.rejectReason = modelResolution.reason;
      campaign.status = "blocked";
      this.saveCampaign(campaign);
      return;
    }
    const { agentId, effectiveModel } = modelResolution;

    // A wave already marked running is a recovery of the same dispatch, not a
    // new one. Only a genuinely new attempt increments.
    const recovering = state.status === "running" && (state.attempt ?? 0) > 0;
    const attempt = recovering ? state.attempt! : (state.attempt ?? 0) + 1;

    const dir = this.campaignDir(campaign.campaignId);
    const reportFile = state.reportFile ?? ZaicodeAuditService.waveFileName(campaign, wave.id);
    const now = new Date().toISOString();

    state.attempt = attempt;
    state.reportFile = reportFile;
    state.idempotencyKey = zaicodeAuditIdempotencyKey(campaign.runId ?? campaign.campaignId, wave.id);
    state.status = "running";
    state.startedAt ??= now;
    state.rejectReason = null;
    campaign.currentWaveIndex = waveIndex;
    campaign.status = "running";
    campaign.startedAt ??= now;
    if (requestedModel) {
      campaign.modelIdentity = requestedModel;
    }
    campaign.effectiveModelIdentity = effectiveModel;
    this.saveCampaign(campaign);

    const predecessor =
      waveIndex > 0 ? campaign.waves[waveIndex - 1] ?? null : null;
    const prompt = buildZaicodeQuick3WavePrompt({
      waveId: wave.id,
      projectName: campaign.projectName,
      projectPath: campaign.workspacePath,
      sourceIdentity: campaign.sourceIdentity ?? "unknown",
      ...(campaign.runId ? { runId: campaign.runId } : {}),
      reportFile: join(dir, reportFile),
      ...(predecessor?.reportFile ? { predecessorArtifactName: predecessor.reportFile } : {}),
      ...(predecessor?.resultSha256 ? { predecessorSha256: predecessor.resultSha256 } : {}),
    });

    // The attempt is IN the title, so a retry is a genuinely new job while the
    // lookup below still finds this attempt's job instead of a second copy.
    const title = `A3 ${wave.ordinal}/3 ${wave.title} — ${campaign.projectName} [${campaign.campaignId}#${attempt}]`;
    const existing = await this.deps.jobService.list({ workspaceKey: campaign.workspaceKey });
    const job =
      existing.jobs.find(
        (candidate) =>
          (candidate.auditMetadata &&
            candidate.auditMetadata.campaignId === campaign.campaignId &&
            candidate.auditMetadata.waveId === wave.id &&
            candidate.auditMetadata.attempt === attempt) ||
          candidate.title === title,
      ) ??
      (await this.deps.jobService.create({
        workspaceKey: campaign.workspaceKey,
        workspacePath: campaign.workspacePath,
        agentId,
        title,
        instructions: prompt,
        auditMetadata: {
          campaignId: campaign.campaignId,
          batchId: campaign.batchId ?? null,
          waveId: wave.id,
          attempt,
        },
      }));

    state.jobId = job.id;
    // SRC-060: the read model answers "which model", and the campaign is the
    // only durable place a panel can read it from. The job knows its agent; the
    // campaign now writes it down too.
    state.agentId = job.agentId ?? agentId;
    this.saveCampaign(campaign);
  }

  /**
   * Write `<Project>__00_AUDIT_ALL_3.md` from the three durable artifacts.
   * Deterministic: same artifacts, same bytes, same digest. Refused -- never
   * patched over -- when a wave artifact is missing or no longer matches the
   * hash the campaign recorded.
   */
  private synthesizeCombined(campaign: ZaicodeAuditCampaign): { ok: boolean; reason?: string } {
    const dir = this.campaignDir(campaign.campaignId);
    const contents: Record<string, string> = {};
    const digests: Record<string, string> = {};
    for (const wave of campaign.waves) {
      if (wave.status !== "complete" || !wave.reportFile) continue;
      const text = existsSync(join(dir, wave.reportFile)) ? readFileSync(join(dir, wave.reportFile), "utf8") : "";
      contents[wave.waveId] = text;
      digests[wave.waveId] = sha256Of(text);
    }

    const result = synthesizeZaicodeAuditCombined({
      state: {
        runId: campaign.runId ?? campaign.campaignId,
        projectId: campaign.workspaceKey,
        projectName: campaign.projectName,
        profileId: campaign.profileId,
        profileVersion: campaign.profileVersion ?? ZAICODE_AUDIT_PROFILE.version,
        manifestHash: campaign.manifestHash ?? zaicodeAuditProfileManifestHash(),
        sourceIdentity: campaign.sourceIdentity ?? "unknown",
        modelIdentity: campaign.modelIdentity ?? "unknown",
        waves: campaign.waves.map((wave) => ({
          waveId: wave.waveId,
          ordinal: ZAICODE_AUDIT_PROFILE.waves.find((entry) => entry.id === wave.waveId)?.ordinal ?? 0,
          status: wave.status === "complete" ? ("saved" as const) : ("pending" as const),
          attempt: wave.attempt ?? 0,
          idempotencyKey: wave.idempotencyKey ?? "",
          ...(wave.resultSha256 ? { artifactSha256: wave.resultSha256 } : {}),
          ...(wave.reportFile ? { artifactFile: wave.reportFile } : {}),
        })),
        cancelled: campaign.status === "cancelled",
      },
      contents,
      digests,
      sha256: sha256Of,
      synthesizedAt: new Date().toISOString(),
    });

    if (!result.ok || result.markdown === undefined || result.sha256 === undefined) {
      return { ok: false, reason: result.reason ?? "the combined artifact could not be synthesized" };
    }
    const file = ZaicodeAuditService.combinedFileName(campaign);
    // Durable BEFORE the campaign claims it: a crash here leaves the campaign
    // unfinished and it re-synthesizes, rather than reporting a file that
    // is not there.
    ZaicodeAuditService.writeTextAtomic(join(dir, file), result.markdown);
    campaign.combined = {
      file,
      kind: ZAICODE_AUDIT_PROFILE.combinedKind,
      sha256: result.sha256,
      synthesizedAt: new Date().toISOString(),
    };
    campaign.finalHandoffFile = file;
    return { ok: true };
  }

  /**
   * The Quick3 wave gate. A completed job advances the campaign only when its
   * report file is on disk AND passes structural validation: this wave's
   * terminal line as the LAST line, its done marker, this run and this project,
   * the predecessor's hash, and either correctly formed findings or that
   * wave's exact no-findings sentence. Anything else is `partial`, the
   * campaign is `blocked`, and the reason is shown — never injected.
   */
  private async reconcileCampaign(campaign: ZaicodeAuditCampaign): Promise<void> {
    if (campaign.status === "complete" || campaign.status === "cancelled") return;
    // Generate-first: a planned campaign waits in the review queue until work().
    // The one exception is a campaign the wave switch parked (R008): the
    // switch going back on releases it. A campaign the operator planned by hand
    // has no hold flag, so it still waits for their own Continue.
    if (campaign.status === "planned") {
      const batch = campaign.batchId ? this.findBatchDirect(campaign.batchId) : null;
      if (batch && batch.status === "paused") return;
      const autoWaves = batch ? batch.autoWaves : this.readSmartSettings().autoWaves;
      if (!campaign.autoAdvanceHeld || !autoWaves) return;
      campaign.autoAdvanceHeld = false;
      campaign.status = "running";
      this.saveCampaign(campaign);
    }
    const state = campaign.waves[campaign.currentWaveIndex];
    if (!state) return;
    if (!state.jobId) {
      await this.enqueueWave(campaign, campaign.currentWaveIndex);
      return;
    }
    const job = await this.deps.jobService.get(state.jobId);
    if (!job) return;
    if (job.status === "queued" || job.status === "ready" || job.status === "running" || job.status === "waiting") {
      state.status = job.status === "running" ? "running" : "pending";
      return;
    }

    const dir = this.campaignDir(campaign.campaignId);
    const reportPath = join(dir, state.reportFile ?? "");
    const exists = existsSync(reportPath);
    const text = exists ? readFileSync(reportPath, "utf8") : "";

    if (job.status === "completed") {
      const predecessor = campaign.waves[campaign.currentWaveIndex - 1] ?? null;
      const verdict = validateZaicodeAuditArtifact(text, {
        projectName: campaign.projectName,
        runId: campaign.runId ?? "",
        waveId: state.waveId,
        ...(predecessor?.resultSha256 ? { predecessorSha256: predecessor.resultSha256 } : {}),
        artifactSha256: sha256Of(text),
        artifactExists: exists,
      });

      if (!verdict.valid) {
        // T-133: a blocked campaign is re-read on every pass (every minute), so an artifact that lands late still
        // advances it. Judged the same as last time, nothing changed: no second warning, no rewrite of the file.
        // Two stuck campaigns logged 2,880 identical warnings a day and rewrote their JSON as often.
        if (campaign.status === "blocked" && state.status === "partial" && state.rejectReason === verdict.detail) return;
        state.status = "partial";
        state.rejectReason = verdict.detail;
        campaign.status = "blocked";
        this.saveCampaign(campaign);
        this.deps.logger?.warn(`ZAICODE audits: wave ${state.waveId} rejected (${verdict.reason}) for ${campaign.projectName}`);
        return;
      }

      state.status = "complete";
      state.resultSha256 = sha256Of(text);
      state.rejectReason = null;
      state.completedAt = new Date().toISOString();
      state.findings = verdict.tickets.length;
      campaign.findings = campaign.waves.reduce((sum, wave) => sum + (wave.findings ?? 0), 0);

      const nextIndex = campaign.currentWaveIndex + 1;
      if (nextIndex < campaign.waves.length) {
        campaign.waves[nextIndex]!.status = "pending";
        // Check batch pause first: hold progression if batch is paused
        const batch = campaign.batchId ? this.findBatchDirect(campaign.batchId) : null;
        if (batch && batch.status === "paused") {
          campaign.currentWaveIndex = nextIndex;
          campaign.autoAdvanceHeld = true;
          campaign.status = "planned";
          this.saveCampaign(campaign);
          return;
        }
        // SRC-151:R008: this is the one place a wave is generated without being
        // asked for. With the switch off the campaign parks as `planned`
        // -- the state that already means "waiting in the review queue" -- so the
        // card's own Continue is what starts the next wave, and nothing else
        // changes: the finished artifact stays exactly as validated.
        const autoWaves = batch ? batch.autoWaves : this.readSmartSettings().autoWaves;
        if (!autoWaves) {
          campaign.currentWaveIndex = nextIndex;
          campaign.autoAdvanceHeld = true;
          campaign.status = "planned";
          this.saveCampaign(campaign);
          return;
        }
        campaign.autoAdvanceHeld = false;
        this.saveCampaign(campaign);
        await this.enqueueWave(campaign, nextIndex);
        return;
      }

      // All three validated. The combined handoff is the campaign's whole
      // point, so a campaign is `complete` only once it is on disk.
      const combined = this.synthesizeCombined(campaign);
      if (!combined.ok) {
        campaign.status = "blocked";
        state.rejectReason = combined.reason ?? "the combined artifact could not be synthesized";
        this.saveCampaign(campaign);
        this.deps.logger?.warn(`ZAICODE audits: combined handoff refused for ${campaign.projectName}: ${combined.reason}`);
        return;
      }
      campaign.status = "complete";
      this.saveCampaign(campaign);
      return;
    }

    // failed / stopped / blocked
    if (state.status === "blocked" && campaign.status === "blocked") return;
    state.status = "blocked";
    campaign.status = "blocked";
    this.saveCampaign(campaign);
  }

  /**
   * The wave's own last sign of life, or null when no host projection can say.
   * Deliberately not `job.heartbeatAt`: that column is the host's execution
   * lease, renewed for every running row on one 30s timer, so it answers
   * "is the host alive", not "did this wave do anything".
   */
  private readSessionActivityAt(
    campaign: ZaicodeAuditCampaign,
    job: { sessionId?: string; workspaceIdentity?: string },
  ): number | null {
    if (!this.deps.sessionActivityAt || !job.sessionId) return null;
    // The sessions-index key is `workspaceIdentity || workspacePath`, and the
    // campaign's workspaceKey was built the same way -- so when it differs from
    // the path it IS the identity. The job itself may not carry one.
    const identity =
      job.workspaceIdentity ??
      (campaign.workspaceKey !== campaign.workspacePath ? campaign.workspaceKey : undefined);
    try {
      const at = this.deps.sessionActivityAt({
        workspacePath: campaign.workspacePath,
        ...(identity ? { workspaceIdentity: identity } : {}),
        sessionId: job.sessionId,
      });
      return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
    } catch (error) {
      this.deps.logger?.warn(
        `ZAICODE audits: no session activity for campaign ${campaign.campaignId}`,
        error,
      );
      return null;
    }
  }

  private async reconcileAll(): Promise<void> {
    for (const { campaignId } of this.loadCampaigns(true).filter(zaicodeAuditCampaignIsActive)) {
      // Re-read under the lock: the list was read before it, and a cancel() or
      // work() that held the lock meanwhile has written a newer state.
      await this.withCampaign(campaignId, async () => {
        const campaign = this.findCampaign(campaignId);
        if (campaign) {
          await this.reconcileCampaign(campaign);
        }
      }).catch(() => undefined);
    }
  }

  async getState(): Promise<{
    campaigns: ZaicodeAuditCampaign[];
    smartMode: boolean;
    autoProjects: ZaicodeAutoProjects;
    autoAudits: boolean;
    maxCycles: number;
    runId: string | null;
    autoWaves: boolean;
    auditor: ZaicodeAuditorView | null;
  }> {
    await this.reconcileAll();
    const agents = await this.deps.agentService.list().then((result) => result.agents).catch(() => []);
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const modelOf = (agent: (typeof agents)[number] | undefined) =>
      agent ? formatZaicodeModelLabel(agent.modelSelection, agent) : null;
    const campaigns = await Promise.all(this.loadCampaigns().map(async (campaign) => {
      let next: ZaicodeAuditCampaign = campaign;
      if (campaign.fixJobId) {
        const job = await this.deps.jobService.get(campaign.fixJobId).catch(() => null);
        next = { ...next, remediationStatus: job?.status ?? null };
      } else if (campaign.remediationJobId) {
        const job = await this.deps.jobService.get(campaign.remediationJobId).catch(() => null);
        next = { ...next, remediationStatus: job?.status ?? null };
      }
      // SRC-060: where the current wave runs, since when, on which model.
      const jobId = campaign.status === "running" ? campaign.waves[campaign.currentWaveIndex]?.jobId : null;
      if (jobId) {
        const job = await this.deps.jobService.get(jobId).catch(() => null);
        if (job) {
          const agent = agentById.get(job.agentId);
          next = {
            ...next,
            live: {
              jobId: job.id,
              status: job.status,
              sessionId: job.sessionId ?? null,
              startedAt: job.startedAt ?? null,
              heartbeatAt: job.heartbeatAt ?? null,
              lastActivityAt: this.readSessionActivityAt(campaign, job),
              attempt: job.attempt,
              agentName: agent?.name ?? null,
              model: formatZaicodeModelLabel(job.actualModelSelection) ?? modelOf(agent),
            },
          };
        }
      }
      return next;
    }));
    const auditor = agents.find((agent) => agent.role === "auditor");
    return {
      campaigns,
      ...this.readSmartSettings(),
      auditor: auditor ? { agentId: auditor.id, name: auditor.name, model: modelOf(auditor) } : null,
    };
  }

  async getCampaign(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.findCampaign(campaignId);
  }

  async generate(
    input: SmartProject,
    smartRunId?: string,
    batchOptions?: {
      batchId?: string;
      modelPolicy?: ZaicodeAuditBatchModelPolicy;
      batchAutoWaves?: boolean;
      postAuditPolicy?: ZaicodeAuditPostAuditPolicy;
    },
  ): Promise<ZaicodeAuditCampaign | null> {
    const now = new Date().toISOString();
    const initialRequestedModel =
      batchOptions?.modelPolicy?.waveModels?.core ??
      batchOptions?.modelPolicy?.defaultModel ??
      null;
    const agent = await this.ensureAuditAgentForModel(initialRequestedModel);
    const agentDef = agent
      ? (await this.deps.agentService.list().then((result) => result.agents).catch(() => []))
          .find((entry) => entry.id === agent)
      : null;
    const modelIdentity = initialRequestedModel ?? (agentDef ? formatZaicodeModelLabel(agentDef.modelSelection, agentDef) : null);
    const campaign: ZaicodeAuditCampaign = {
      schemaVersion: 2,
      campaignId: randomUUID(),
      profileId: ZAICODE_AUDIT_PROFILE.id,
      profileVersion: ZAICODE_AUDIT_PROFILE.version,
      manifestHash: zaicodeAuditProfileManifestHash(),
      runId: randomUUID(),
      // Frozen now, judged against it for all three waves: a mid-campaign edit
      // cannot retroactively excuse a report that was invalid all along.
      sourceIdentity: await this.sourceIdentityOf(input.workspacePath),
      modelIdentity,
      ...(smartRunId ? { smartRunId } : {}),
      ...(batchOptions?.batchId ? { batchId: batchOptions.batchId } : {}),
      ...(batchOptions?.modelPolicy ? { modelPolicy: batchOptions.modelPolicy } : {}),
      ...(typeof batchOptions?.batchAutoWaves === "boolean" ? { batchAutoWaves: batchOptions.batchAutoWaves } : {}),
      ...(batchOptions?.postAuditPolicy ? { postAuditPolicy: batchOptions.postAuditPolicy } : { postAuditPolicy: smartRunId ? "FIX_WITH_SAIPEN" : "REPORTS_ONLY" }),
      projectName: input.projectName,
      workspaceKey: input.workspaceKey,
      workspacePath: input.workspacePath,
      status: "planned",
      createdAt: now,
      updatedAt: now,
      currentWaveIndex: 0,
      waves: ZAICODE_AUDIT_PROFILE.waves.map((wave) => ({
        waveId: wave.id,
        status: "pending",
        jobId: null,
        reportFile: ZaicodeAuditService.waveFileNameFor(input.projectName, wave.id),
        resultSha256: null,
        completedAt: null,
        attempt: 0,
        idempotencyKey: zaicodeAuditIdempotencyKey("", wave.id),
        findings: 0,
        rejectReason: null,
      })),
      finalHandoffFile: null,
      combined: null,
      findings: 0,
      fixJobId: null,
    };
    // The run id is only known here, so the per-wave keys are written now that
    // it exists rather than carrying a placeholder.
    campaign.waves = campaign.waves.map((wave) => ({
      ...wave,
      idempotencyKey: zaicodeAuditIdempotencyKey(campaign.runId!, wave.waveId),
    }));
    mkdirSync(this.campaignDir(campaign.campaignId), { recursive: true });
    ZaicodeAuditService.writeJsonAtomic(this.campaignFile(campaign.campaignId), campaign);
    return campaign;
  }

  async work(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.withCampaign(campaignId, async () => {
      const campaign = this.findCampaign(campaignId);
      if (!campaign || campaign.status !== "planned") return campaign;
      await this.enqueueWave(campaign, campaign.currentWaveIndex);
      return this.findCampaign(campaignId) ?? campaign;
    });
  }

  async start(input: SmartProject, smartRunId?: string): Promise<ZaicodeAuditCampaign | null> {
    const campaign = await this.generate(input, smartRunId);
    if (!campaign) return null;
    return (await this.work(campaign.campaignId)) ?? campaign;
  }

  /**
   * Retry the wave the campaign is stopped at. The wave index does not move:
   * a failure is not progress, and a campaign whose Core was invalid twice is
   * still 0/3. The attempt number is what changes.
   */
  async retry(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.withCampaign(campaignId, async () => {
      const campaign = this.findCampaign(campaignId);
      if (!campaign || campaign.status !== "blocked") return campaign;
      const state = campaign.waves[campaign.currentWaveIndex];
      if (!state) return campaign;
      if (state.jobId && !(await this.stopWaveJob(state.jobId, state))) {
        this.saveCampaign(campaign);
        return this.findCampaign(campaignId) ?? campaign;
      }
      state.status = "pending";
      state.jobId = null;
      state.rejectReason = null;
      campaign.status = "running";
      this.saveCampaign(campaign);
      await this.enqueueWave(campaign, campaign.currentWaveIndex);
      return this.findCampaign(campaignId) ?? campaign;
    });
  }

  async cancel(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.withCampaign(campaignId, async () => {
      const campaign = this.findCampaign(campaignId);
      if (!campaign || campaign.status === "complete" || campaign.status === "cancelled") return campaign;
      const state = campaign.waves[campaign.currentWaveIndex];
      if (state?.jobId && !(await this.stopWaveJob(state.jobId, state))) {
        // The worker would not stop, so the work is still going: the campaign is not
        // cancelled and nothing new is launched.
        this.saveCampaign(campaign);
        return this.findCampaign(campaignId) ?? campaign;
      }
      campaign.status = "cancelled";
      this.saveCampaign(campaign);
      return campaign;
    });
  }

  async archive(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.withCampaign(campaignId, async () => {
      const campaign = ZaicodeAuditService.readJson<ZaicodeAuditCampaign>(this.campaignFile(campaignId));
      if (!campaign || campaign.archivedAt) return campaign;
      if (campaign.status === "running") throw new Error("Stop this audit before archiving it.");
      const jobIds = [...new Set([...campaign.waves.map((wave) => wave.jobId), campaign.fixJobId, campaign.remediationJobId].filter((id): id is string => Boolean(id)))];
      const jobs = await Promise.all(jobIds.map((id) => this.deps.jobService.get(id)));
      if (jobs.some((job) => job?.status === "running")) throw new Error("Stop the audit's running task before archiving it.");
      if (jobs.some((job) => job?.error?.startsWith("cancel_stop_failed:"))) throw new Error("Retry cancellation before archiving this audit.");
      // 旧 planned/blocked 任务仍可能排队；取消成功后才隐藏，报告和活动记录不删除。
      for (const job of jobs) {
        if (job && !["completed", "failed", "cancelled"].includes(job.status)) await this.deps.jobService.cancel(job.id);
      }
      if (campaign.status === "planned" || campaign.status === "blocked") campaign.status = "cancelled";
      campaign.archivedAt = new Date().toISOString();
      this.saveCampaign(campaign);
      return campaign;
    });
  }

  async readReport(campaignId: string, waveId: string): Promise<string | null> {
    const campaign = this.findCampaign(campaignId);
    const state = campaign?.waves.find((wave) => wave.waveId === waveId);
    if (!state?.reportFile) return null;
    const path = join(this.campaignDir(campaignId), state.reportFile);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /** The combined handoff's markdown, or null while it does not exist yet. */
  async readCombined(campaignId: string): Promise<string | null> {
    const campaign = this.findCampaign(campaignId);
    if (!campaign?.combined) return null;
    const path = join(this.campaignDir(campaignId), campaign.combined.file);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /**
   * "Fix with SAIPEN": the audit is over, the repair is a SEPARATE step, and it
   * consumes the exact combined artifact by path AND digest. The audit
   * artifacts are never edited. The drift between the audited source identity
   * and the source as it is now is recorded on the campaign, so the
   * implementation agent is told what it is about to change.
   */
  async fixWithSaipen(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.withCampaign(campaignId, async () => {
      const campaign = this.findCampaign(campaignId);
      if (!campaign) return null;
      if (campaign.status !== "complete" || !campaign.combined) {
        throw new Error("the combined audit artifact is not ready yet");
      }
      if (campaign.fixJobId) return campaign;

      const agentId = await this.ensureRemediationAgent();
      if (!agentId) throw new Error("no implementer agent is available for the fix");

      const reportPath = join(this.campaignDir(campaignId), campaign.combined.file);
      const atFix = await this.sourceIdentityOf(campaign.workspacePath);
      const audited = campaign.sourceIdentity ?? "unknown";
      campaign.sourceDrift = { audited, atFix, changed: audited !== atFix, recordedAt: new Date().toISOString() };

      const title = `A3 FIX ${campaign.campaignId}`;
      const existing = await this.deps.jobService.list({ workspaceKey: campaign.workspaceKey });
      const found = existing.jobs.find((candidate) => candidate.title === title);
      const job =
        found ??
        (await this.deps.jobService.create({
          workspaceKey: campaign.workspaceKey,
          workspacePath: campaign.workspacePath,
          agentId,
          title,
          instructions: [
            `Implement the verified findings from the A3 audit of ${campaign.projectName} (${campaign.workspacePath}).`,
            "",
            `The audit input is exactly this file: ${reportPath}`,
            `  sha256 ${campaign.combined.sha256} (kind ${campaign.combined.kind})`,
            `  audited source identity: ${audited}`,
            `  source identity now:     ${atFix}${audited === atFix ? " (unchanged)" : " (DRIFTED — verify each finding against the current source before changing anything)"}`,
            "",
            "Verify every finding against the current source BEFORE changing code: an audit finding is a claim, not a fact.",
            "Use the project's SAIPEN workflow when present. Work through the findings, keep BOARD and STATE current, and report exact evidence.",
            "If a finding is invalid or unsafe, record why and continue with the remaining findings.",
            "Do not edit the audit artifacts — they are the evidence. Do not start another audit.",
          ].join("\n"),
        }));

      campaign.fixJobId = job.id;
      campaign.remediationJobId = job.id;
      this.saveCampaign(campaign);
      return this.findCampaign(campaignId) ?? campaign;
    });
  }

  /**
   * Smart mode's automatic repair, the same path the operator's button takes:
   * one durable implementation job, found by title before it is created, so a
   * crash cannot hand the same findings to two agents.
   */
  private async smartRemediationGate(campaign: ZaicodeAuditCampaign): Promise<"ready" | "waiting" | "stop"> {
    if (campaign.status !== "complete" || !campaign.combined) return "stop";
    if ((campaign.findings ?? 0) === 0) return "stop";
    // REPORTS_ONLY is the explicit post-audit default: repair is never inherited
    // silently; the operator must press "Fix with SAIPEN" on the combined handoff.
    const batch = campaign.batchId ? this.findBatchDirect(campaign.batchId) : null;
    const policy = campaign.postAuditPolicy ?? batch?.postAuditPolicy ?? "REPORTS_ONLY";
    if (policy === "REPORTS_ONLY") return "stop";
    if (!campaign.fixJobId) {
      await this.fixWithSaipen(campaign.campaignId).catch((error) => {
        this.deps.logger?.warn(`ZAICODE audits: could not start the fix for ${campaign.projectName}`, error);
      });
      return "waiting";
    }
    const job = await this.deps.jobService.get(campaign.fixJobId);
    if (!job) return "stop";
    if (job.status === "completed") return "ready";
    if (job.status === "failed" || job.status === "cancelled" || job.status === "blocked") {
      this.deps.logger?.warn(`ZAICODE audits: fix ${job.status} for ${campaign.projectName}`);
      return "stop";
    }
    return "waiting";
  }

  async setSmartMode(enabled: boolean): Promise<{ smartMode: boolean }> {
    const current = this.readSmartSettings();
    ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), {
      ...current,
      smartMode: enabled,
      runId: enabled && !current.smartMode ? randomUUID() : current.runId,
    });
    return { smartMode: enabled };
  }

  async setAutoAudits(enabled: boolean): Promise<{ autoAudits: boolean }> {
    // AUTO 的项目续跑与 A3 审计准入必须分开，关闭审计不能关闭已有工作。
    ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), { ...this.readSmartSettings(), autoAudits: enabled });
    return { autoAudits: enabled };
  }

  async setProjectAutoSettings(
    workspaceKey: string,
    patch: Partial<ZaicodeAutoPolicy> | null,
  ): Promise<{ autoProjects: ZaicodeAutoProjects }> {
    const key = workspaceKey.trim();
    if (!key) throw new Error("Select a current project before editing its AUTO settings.");
    if (patch !== null && (!patch || typeof patch !== "object" || Array.isArray(patch) ||
      Object.entries(patch).some(([field, value]) =>
        field === "maxCycles" ? typeof value !== "number" || !Number.isInteger(value) :
          !["smartMode", "autoAudits"].includes(field) || typeof value !== "boolean")))
      throw new Error("Invalid project AUTO settings.");
    const current = this.readSmartSettings();
    if (patch && !Object.hasOwn(current.autoProjects, key) && Object.keys(current.autoProjects).length >= 200)
      throw new Error("AUTO already has overrides for 200 projects. Clear an existing override first.");
    const autoProjects = { ...current.autoProjects };
    if (patch === null) delete autoProjects[key];
    else {
      const normalized = normalizeZaicodeAutoProjects({ [key]: { ...autoProjects[key], ...patch } });
      if (normalized[key]) autoProjects[key] = normalized[key];
    }
    const next = { ...current, autoProjects };
    // 项目单独启用不能重置其他项目的审计配额，也不能把全局 OFF 改成 ON。
    if (!next.runId && resolveZaicodeAutoPolicy(next, key).smartMode) next.runId = randomUUID();
    ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), next);
    return { autoProjects };
  }

  /**
   * The global wave switch (SRC-151:R008). Off, a validated wave does not create
   * the next one: the campaign parks in the review queue with `autoAdvanceHeld`
   * and only the operator's own Continue starts wave 2. Turning it back on
   * releases every held campaign on the next reconcile, so the switch is a
   * switch and not a latch nobody can undo.
   */
  async setAutoWaves(enabled: boolean): Promise<{ autoWaves: boolean }> {
    ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), { ...this.readSmartSettings(), autoWaves: enabled });
    return { autoWaves: enabled };
  }

  async setSmartMaxCycles(maxCycles: number): Promise<{ maxCycles: number }> {
    if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 10) {
      throw new Error("automatic audit cycles must be between 1 and 10");
    }
    ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), { ...this.readSmartSettings(), maxCycles });
    return { maxCycles };
  }

  async publishProjects(projects: SmartProject[]): Promise<void> {
    this.smartProjects = Array.isArray(projects) ? projects.slice(0, 200) : [];
  }

  /** SRC-049: empty board + nothing running -> the project audits itself. */
  async smartSweep(): Promise<ZaicodeAuditsReport> {
    if (this.smartSweepRunning) return { started: [] };
    const settings = this.readSmartSettings();
    if (!this.smartProjects.some((project) => {
      const policy = resolveZaicodeAutoPolicy(settings, project.workspaceKey);
      return policy.smartMode && policy.autoAudits && !project.disabled;
    })) return { started: [] };
    // Fresh E2 (SRC-153 R013): the global wave switch gates automatic ADMISSION,
    // not just wave progression. Disabled means Auto Continue / Continue All
    // create zero automatic campaigns and resume zero planned ones -- not even
    // the first wave. Manual admission (panel start/generate/Continue, /a3)
    // never passes through here and is unaffected; running work is untouched.
    if (!settings.autoWaves) return { started: [] };
    if (!settings.runId) {
      ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), { ...settings, runId: randomUUID() });
      return this.smartSweep();
    }
    this.smartSweepRunning = true;
    try {
      const stillEnabled = (workspaceKey?: string) => {
        const current = this.readSmartSettings();
        const policy = workspaceKey ? resolveZaicodeAutoPolicy(current, workspaceKey) : null;
        return current.autoWaves && current.runId === settings.runId &&
          (!policy || (policy.smartMode && policy.autoAudits));
      };
      const campaigns = this.loadCampaigns(true);
      const running = await this.runningJobCount();
      const started: string[] = [];
      for (const project of this.smartProjects) {
        // 队列读取期间可以关闭 AUTO/审计；旧快照不能继续创建或恢复任务。
        if (!stillEnabled()) break;
        if (project.disabled) continue;
        if (!stillEnabled(project.workspaceKey)) continue;
        const projectCampaigns = campaigns.filter(
          (campaign) => campaign.workspacePath === project.workspacePath && campaign.smartRunId === settings.runId,
        );
        const cycles = projectCampaigns.length;
        const latest = projectCampaigns[0];
        if (latest?.status === "planned") {
          // A crash or queue failure between generate() and work() leaves a
          // durable plan. Resume that cycle instead of stalling Auto forever.
          const anotherActive = campaigns.some((campaign) =>
            campaign.campaignId !== latest.campaignId &&
            campaign.workspacePath === project.workspacePath &&
            zaicodeAuditCampaignIsActive(campaign));
          if (anotherActive || project.noWorkConfirmed !== true ||
              running + (project.runningSessions ?? 0) > 0 ||
              this.countOpenBoardTickets(project.workspacePath) !== 0) continue;
          if (!stillEnabled(project.workspaceKey)) continue;
          await this.work(latest.campaignId).catch((error) => {
            this.deps.logger?.warn(`ZAICODE audits: could not resume planned A3 for ${project.projectName}`, error);
          });
          continue;
        }
        if (latest) {
          const gate = await this.smartRemediationGate(latest).catch((error) => {
            this.deps.logger?.warn(`ZAICODE audits: remediation reconciliation failed for ${project.projectName}`, error);
            return "stop" as const;
          });
          if (!stillEnabled(project.workspaceKey)) continue;
          if (gate !== "ready") continue;
        }
        if (cycles >= resolveZaicodeAutoPolicy(this.readSmartSettings(), project.workspaceKey).maxCycles) continue;
        if (project.noWorkConfirmed !== true) continue;
        const active = campaigns.find(
          (campaign) => campaign.workspacePath === project.workspacePath && zaicodeAuditCampaignIsActive(campaign),
        );
        const openTickets = this.countOpenBoardTickets(project.workspacePath);
        const decide = shouldStartZaicodeAuditCampaign({
          smartMode: true,
          hasSaipenBoard: openTickets !== null,
          openBoardTickets: openTickets ?? 1,
          runningSessions: running + (project.runningSessions ?? 0),
          activeCampaign: active ?? null,
        });
        if (!decide) continue;
        this.deps.logger?.info?.(`ZAICODE audits: smart mode starting A3 for ${project.projectName}`);
        const campaign = await this.generate(project, settings.runId).then(async (planned) => {
          if (!planned || !stillEnabled(project.workspaceKey)) return planned;
          return this.work(planned.campaignId);
        }).catch((error) => {
          this.deps.logger?.warn(`ZAICODE audits: could not start A3 for ${project.projectName}`, error);
          return null;
        });
        if (campaign) {
          campaigns.push(campaign);
          if (campaign.status !== "planned") started.push(project.workspacePath);
        }
      }
      return { started };
    } finally {
      this.smartSweepRunning = false;
    }
  }

  private loadBatches(): ZaicodeAuditBatch[] {
    const dir = this.batchesDir();
    if (!existsSync(dir)) return [];
    const batches: ZaicodeAuditBatch[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const batch = ZaicodeAuditService.readJson<ZaicodeAuditBatch>(join(dir, entry.name));
      if (batch && batch.schemaVersion === 1) batches.push(batch);
    }
    batches.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    return batches;
  }

  private loadBatch(batchId: string): ZaicodeAuditBatch | null {
    const path = this.batchFile(batchId);
    if (!existsSync(path)) return null;
    const batch = ZaicodeAuditService.readJson<ZaicodeAuditBatch>(path);
    if (!batch || batch.schemaVersion !== 1) return null;
    return batch;
  }

  private saveBatch(batch: ZaicodeAuditBatch, expectedRevision?: number): boolean {
    const existing = this.loadBatch(batch.batchId);
    if (existing) {
      if (expectedRevision !== undefined && (existing.lifecycleRevision ?? 0) !== expectedRevision) {
        return false;
      }
      if (existing.status === "cancelled" && batch.status !== "cancelled") {
        batch.status = "cancelled";
        batch.lifecycleRevision = existing.lifecycleRevision;
      } else if (existing.status === "paused" && batch.status !== "paused") {
        if (
          (batch.status === "running" ||
            batch.status === "cancelled" ||
            batch.status === "stopping" ||
            batch.status === "stop_requested" ||
            batch.status === "stop_partial" ||
            batch.status === "stop_failed") &&
          (batch.lifecycleRevision ?? 0) > (existing.lifecycleRevision ?? 0)
        ) {
          // Authorized resume or stop transition
        } else {
          batch.status = "paused";
          batch.lifecycleRevision = existing.lifecycleRevision;
        }
      } else if (
        (existing.status === "stopping" ||
          existing.status === "stop_requested" ||
          existing.status === "stop_partial" ||
          existing.status === "stop_failed") &&
        (batch.status === "running" || batch.status === "paused")
      ) {
        if ((batch.lifecycleRevision ?? 0) <= (existing.lifecycleRevision ?? 0)) {
          batch.status = existing.status;
          batch.lifecycleRevision = existing.lifecycleRevision;
        }
      }
    }
    batch.updatedAt = new Date().toISOString();
    ZaicodeAuditService.writeJsonAtomic(this.batchFile(batch.batchId), batch);
    return true;
  }

  private saveBatchIfChanged(batch: ZaicodeAuditBatch, expectedRevision?: number): boolean {
    const existing = this.loadBatch(batch.batchId);
    if (existing) {
      if (
        existing.status === batch.status &&
        existing.lifecycleRevision === batch.lifecycleRevision &&
        existing.completedAt === batch.completedAt &&
        JSON.stringify(existing.stats) === JSON.stringify(batch.stats) &&
        JSON.stringify(existing.projects) === JSON.stringify(batch.projects) &&
        JSON.stringify(existing.campaignIds) === JSON.stringify(batch.campaignIds) &&
        JSON.stringify(existing.stopDetails) === JSON.stringify(batch.stopDetails)
      ) {
        return false;
      }
    }
    return this.saveBatch(batch, expectedRevision);
  }

  private async reconcileBatch(batch: ZaicodeAuditBatch): Promise<ZaicodeAuditBatch> {
    // 0. Cancelled batches never resurrect work or generate missing campaigns.
    if (batch.status === "cancelled") {
      if (batch.stats && batch.projects.every((p) => p.status !== "pending" && p.status !== "admitting")) {
        return batch;
      }
      for (const p of batch.projects) {
        if (p.status === "pending" || p.status === "admitting") {
          const match = p.campaignId ? this.findCampaign(p.campaignId) : null;
          if (match) {
            p.campaignId = match.campaignId;
            p.status = "admitted";
            if (!batch.campaignIds.includes(match.campaignId)) {
              batch.campaignIds.push(match.campaignId);
            }
          }
        }
      }
      const batchCampaignsForStats = batch.campaignIds.map((id) => this.findCampaign(id)).filter(Boolean) as ZaicodeAuditCampaign[];
      batch.stats = {
        totalProjects: batch.projects.length,
        admittedCount: batch.projects.filter((p) => p.status === "admitted").length,
        queuedCount: batchCampaignsForStats.filter((c) => c.status === "planned").length,
        runningCount: batchCampaignsForStats.filter((c) => c.status === "running").length,
        completedCount: batchCampaignsForStats.filter((c) => c.status === "complete").length,
        blockedCount: batchCampaignsForStats.filter((c) => c.status === "blocked").length,
        cancelledCount: batchCampaignsForStats.filter((c) => c.status === "cancelled").length,
        rejectedCount: batch.projects.filter((p) => p.status === "rejected").length,
      };
      this.saveBatchIfChanged(batch);
      return batch;
    }

    // 0a. Stopping / stop_partial / stop_failed batches: do not generate new work
    if (
      batch.status === "stopping" ||
      batch.status === "stop_requested" ||
      batch.status === "stop_partial" ||
      batch.status === "stop_failed"
    ) {
      for (const p of batch.projects) {
        if (p.status === "pending" || p.status === "admitting") {
          const match = p.campaignId ? this.findCampaign(p.campaignId) : null;
          if (match) {
            p.campaignId = match.campaignId;
            p.status = "admitted";
            if (!batch.campaignIds.includes(match.campaignId)) {
              batch.campaignIds.push(match.campaignId);
            }
          }
        }
      }
      const batchCampaigns = batch.campaignIds.map((id) => this.findCampaign(id)).filter(Boolean) as ZaicodeAuditCampaign[];
      const activeWorkers = (await this.getActiveWorkers()).filter((w) => w.batchId === batch.batchId);
      const stillRunning = batchCampaigns.filter((c) => c.status === "running");

      if (batch.status === "stopping" || batch.status === "stop_requested") {
        const failedCount = batch.stopDetails?.failedCampaignIds?.length ?? 0;
        const stoppedCount = batch.stopDetails?.stoppedCampaignIds?.length ?? 0;
        if (failedCount > 0) {
          batch.status = stoppedCount > 0 ? "stop_partial" : "stop_failed";
        } else if (activeWorkers.length > 0 || stillRunning.length > 0) {
          batch.status = "stopping";
          if (batch.stopDetails) {
            batch.stopDetails.reason =
              activeWorkers.length > 0
                ? `${activeWorkers.length} worker(s) still active`
                : `${stillRunning.length} campaign(s) still active`;
          }
        } else {
          batch.status = "cancelled";
          batch.completedAt = batch.completedAt ?? new Date().toISOString();
        }
      }
      // Note: If batch was already stop_partial or stop_failed, its status is preserved!

      batch.stats = {
        totalProjects: batch.projects.length,
        admittedCount: batch.projects.filter((p) => p.status === "admitted").length,
        queuedCount: batchCampaigns.filter((c) => c.status === "planned").length,
        runningCount: batchCampaigns.filter((c) => c.status === "running").length,
        completedCount: batchCampaigns.filter((c) => c.status === "complete").length,
        blockedCount: batchCampaigns.filter((c) => c.status === "blocked").length,
        cancelledCount: batchCampaigns.filter((c) => c.status === "cancelled").length,
        rejectedCount: batch.projects.filter((p) => p.status === "rejected").length,
      };
      this.saveBatchIfChanged(batch);
      return batch;
    }

    // 0b. Paused batches: separate durable recovery reconciliation from execution admission.
    // PAUSED holds new execution admission. Missing campaigns remain recorded as pending.
    if (batch.status === "paused") {
      for (const p of batch.projects) {
        if (p.status === "pending" || p.status === "admitting") {
          const match = p.campaignId ? this.findCampaign(p.campaignId) : null;
          if (match) {
            p.campaignId = match.campaignId;
            p.status = "admitted";
            if (!batch.campaignIds.includes(match.campaignId)) {
              batch.campaignIds.push(match.campaignId);
            }
          } else if (!p.workspaceKey || !p.workspacePath) {
            p.status = "rejected";
            p.reason = "Missing workspaceKey or workspacePath";
          }
        }
      }
      const batchCampaignsForStats = batch.campaignIds.map((id) => this.findCampaign(id)).filter(Boolean) as ZaicodeAuditCampaign[];
      batch.stats = {
        totalProjects: batch.projects.length,
        admittedCount: batch.projects.filter((p) => p.status === "admitted").length,
        queuedCount: batchCampaignsForStats.filter((c) => c.status === "planned").length,
        runningCount: batchCampaignsForStats.filter((c) => c.status === "running").length,
        completedCount: batchCampaignsForStats.filter((c) => c.status === "complete").length,
        blockedCount: batchCampaignsForStats.filter((c) => c.status === "blocked").length,
        cancelledCount: batchCampaignsForStats.filter((c) => c.status === "cancelled").length,
        rejectedCount: batch.projects.filter((p) => p.status === "rejected").length,
      };
      this.saveBatchIfChanged(batch);
      return batch;
    }

    // 1. Crash recovery for incomplete write-ahead admission when running / admitting
    const incomplete =
      batch.status === "admitting" ||
      batch.projects.some((p) => p.status === "pending" || p.status === "admitting");
    if (incomplete) {
      const allCampaigns = this.loadCampaigns(true);
      const batchCampaignIds = new Set(batch.campaignIds);
      let changed = false;

      for (const p of batch.projects) {
        const durable = this.loadBatch(batch.batchId);
        if (
          durable &&
          (durable.status === "paused" ||
            durable.status === "cancelled" ||
            durable.status === "stopping" ||
            durable.status === "stop_requested" ||
            durable.status === "stop_partial" ||
            durable.status === "stop_failed")
        ) {
          break;
        }

        if (p.status === "pending" || p.status === "admitting") {
          const match = allCampaigns.find(
            (c) =>
              (c.batchId === batch.batchId || (p.campaignId && c.campaignId === p.campaignId)) &&
              c.workspaceKey === p.workspaceKey,
          );
          if (match) {
            p.campaignId = match.campaignId;
            p.status = "admitted";
            batchCampaignIds.add(match.campaignId);
            changed = true;
            if (!batch.planOnly && match.status === "planned") {
              await this.work(match.campaignId);
            }
          } else if (!p.workspaceKey || !p.workspacePath) {
            p.status = "rejected";
            p.reason = "Missing workspaceKey or workspacePath";
            changed = true;
          } else {
            // Reconcile missing campaign
            const campaign = await this.generate(
              {
                workspaceKey: p.workspaceKey,
                workspacePath: p.workspacePath,
                projectName: p.projectName,
              },
              undefined,
              {
                batchId: batch.batchId,
                modelPolicy: batch.modelPolicy,
                batchAutoWaves: batch.autoWaves,
              },
            );

            const durableAfterGen = this.loadBatch(batch.batchId);
            if (
              durableAfterGen &&
              (durableAfterGen.status === "paused" ||
                durableAfterGen.status === "cancelled" ||
                durableAfterGen.status === "stopping" ||
                durableAfterGen.status === "stop_requested" ||
                durableAfterGen.status === "stop_partial" ||
                durableAfterGen.status === "stop_failed")
            ) {
              break;
            }

            if (campaign) {
              p.campaignId = campaign.campaignId;
              p.status = "admitted";
              batchCampaignIds.add(campaign.campaignId);
              changed = true;
              if (!batch.planOnly) {
                await this.work(campaign.campaignId);
              }
            } else {
              p.status = "rejected";
              p.reason = "Campaign generation failed";
              changed = true;
            }
          }
        }
      }
      batch.campaignIds = Array.from(batchCampaignIds);
      if (batch.status === "admitting") {
        const hasUnresolved = batch.projects.some(
          (p) => p.status === "pending" || p.status === "admitting" || p.status === "unresolved",
        );
        batch.status = hasUnresolved ? "blocked" : batch.planOnly ? "planned" : "running";
        changed = true;
      }
      if (changed) {
        this.saveBatch(batch);
      }
    }

    const campaigns = batch.campaignIds.map((id) => this.findCampaign(id)).filter(Boolean) as ZaicodeAuditCampaign[];
    if (campaigns.length === 0 && batch.projects.length === 0) return batch;

    const batchCampaignsForStats = campaigns;
    batch.stats = {
      totalProjects: batch.projects.length,
      admittedCount: batch.projects.filter((p) => p.status === "admitted").length,
      queuedCount: batchCampaignsForStats.filter((c) => c.status === "planned").length,
      runningCount: batchCampaignsForStats.filter((c) => c.status === "running").length,
      completedCount: batchCampaignsForStats.filter((c) => c.status === "complete").length,
      blockedCount: batchCampaignsForStats.filter((c) => c.status === "blocked").length,
      cancelledCount: batchCampaignsForStats.filter((c) => c.status === "cancelled").length,
      rejectedCount: batch.projects.filter((p) => p.status === "rejected").length,
    };

    const anyRunning = campaigns.some((c) => c.status === "running");
    if (anyRunning) {
      if (batch.status !== "running") {
        batch.status = "running";
      }
      this.saveBatchIfChanged(batch);
      return batch;
    }

    const allPlanned = campaigns.length > 0 && campaigns.every((c) => c.status === "planned");
    if (allPlanned && batch.planOnly && batch.status !== "planned") {
      batch.status = "planned";
      this.saveBatchIfChanged(batch);
      return batch;
    }

    // Evaluate terminal status based on all intended project memberships
    const admittedProjects = batch.projects.filter((p) => p.status === "admitted");
    const rejectedProjects = batch.projects.filter((p) => p.status === "rejected");
    const unresolvedProjects = batch.projects.filter(
      (p) => p.status === "pending" || p.status === "admitting" || p.status === "unresolved",
    );

    if (unresolvedProjects.length > 0) {
      if (batch.status !== "blocked" && batch.status !== "admitting") {
        batch.status = "blocked";
        this.saveBatchIfChanged(batch);
      }
      return batch;
    }

    const allAdmittedCampaignsTerminal =
      admittedProjects.length === 0 ||
      (campaigns.length >= admittedProjects.length &&
        campaigns.every((c) => c.status === "complete" || c.status === "blocked" || c.status === "cancelled"));

    if (allAdmittedCampaignsTerminal && (admittedProjects.length > 0 || rejectedProjects.length > 0)) {
      const completedCampaigns = campaigns.filter((c) => c.status === "complete");
      const blockedCampaigns = campaigns.filter((c) => c.status === "blocked");
      const cancelledCampaigns = campaigns.filter((c) => c.status === "cancelled");

      const isComplete =
        admittedProjects.length > 0 &&
        completedCampaigns.length === admittedProjects.length &&
        rejectedProjects.length === 0 &&
        unresolvedProjects.length === 0;

      if (isComplete) {
        if (batch.status !== "complete") {
          batch.status = "complete";
          batch.completedAt = new Date().toISOString();
          this.saveBatchIfChanged(batch);
        }
        return batch;
      }

      const isPartial =
        completedCampaigns.length > 0 &&
        (rejectedProjects.length > 0 ||
          blockedCampaigns.length > 0 ||
          cancelledCampaigns.length > 0 ||
          completedCampaigns.length < admittedProjects.length);

      if (isPartial) {
        if (batch.status !== "partial") {
          batch.status = "partial";
          batch.completedAt = new Date().toISOString();
          this.saveBatchIfChanged(batch);
        }
        return batch;
      }

      if (completedCampaigns.length === 0) {
        if (batch.status !== "blocked") {
          batch.status = "blocked";
          batch.completedAt = new Date().toISOString();
          this.saveBatchIfChanged(batch);
        }
        return batch;
      }
    }

    this.saveBatchIfChanged(batch);
    return batch;
  }

  async listBatches(): Promise<ZaicodeAuditBatch[]> {
    const batches = this.loadBatches();
    return Promise.all(
      batches.map(async (batch) => {
        if (
          (batch.status === "complete" ||
            batch.status === "partial" ||
            batch.status === "cancelled" ||
            batch.status === "stop_partial" ||
            batch.status === "stop_failed") &&
          batch.stats
        ) {
          return batch;
        }
        return this.reconcileBatch(batch);
      }),
    );
  }

  async getBatch(batchId: string): Promise<ZaicodeAuditBatch | null> {
    const path = this.batchFile(batchId);
    if (!existsSync(path)) return null;
    const batch = ZaicodeAuditService.readJson<ZaicodeAuditBatch>(path);
    if (!batch || batch.schemaVersion !== 1) return null;
    return this.reconcileBatch(batch);
  }

  async createBatch(input: {
    requestId?: string;
    projects: { workspaceKey: string; workspacePath: string; projectName: string }[];
    planOnly?: boolean;
    autoWaves?: boolean;
    workerCapacity?: number;
    modelPolicy?: ZaicodeAuditBatchModelPolicy;
    postAuditPolicy?: ZaicodeAuditPostAuditPolicy;
    requestProvenance?: "operator_ui" | "auto" | "api";
  }): Promise<ZaicodeAuditBatchAdmissionResult> {
    const normalizedProjects = (input.projects || [])
      .map((p) => `${p.workspaceKey?.trim()}::${p.workspacePath?.trim()}::${p.projectName?.trim()}`)
      .sort()
      .join("|");
    const sortedKeys = (input.projects || [])
      .map((p) => p.workspaceKey?.trim())
      .filter(Boolean)
      .sort()
      .join(",");
    const resolvedPostAuditPolicy =
      input.postAuditPolicy ??
      (input.requestProvenance === "auto" ? "FIX_WITH_SAIPEN" : "REPORTS_ONLY");
    const modelSignature = JSON.stringify(input.modelPolicy ?? {});
    const contentFingerprint = sha256Of(
      `${normalizedProjects}:${Boolean(input.planOnly)}:${input.workerCapacity ?? 0}:${input.autoWaves ?? true}:${modelSignature}:${resolvedPostAuditPolicy}`,
    );
    const legacyFingerprint = sha256Of(
      `${sortedKeys}:${Boolean(input.planOnly)}:${input.workerCapacity ?? 0}:${input.autoWaves ?? true}:${modelSignature}:${resolvedPostAuditPolicy}`,
    );
    // If caller provided explicit requestId, use it. Otherwise generate fresh unique action ID!
    const requestId =
      input.requestId?.trim() ||
      `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    return this.withBatchAdmission(requestId, async () => {
      // 1. Check if a batch for this requestId already exists (real request idempotency)
      const existingBatches = this.loadBatches();
      const existing = existingBatches.find((b) => b.requestId === requestId);
      if (existing) {
        const hasProjectMismatch =
          input.projects &&
          input.projects.some((inp) => {
            const match = existing.projects.find((ep) => ep.workspaceKey === inp.workspaceKey?.trim());
            return match && match.workspacePath !== inp.workspacePath?.trim();
          });

        if (
          hasProjectMismatch ||
          (existing.contentFingerprint &&
            existing.contentFingerprint !== contentFingerprint &&
            existing.contentFingerprint !== legacyFingerprint)
        ) {
          throw new Error(
            `Request conflict: requestId '${requestId}' already exists with different project content or execution policy`,
          );
        }

        // Reconcile existing batch in place without wiping admissions or campaignIds
        const reconciled = await this.reconcileBatch(existing);
        const admittedCount = reconciled.projects.filter((p) => p.status === "admitted").length;
        const skippedCount = reconciled.projects.filter((p) => p.status === "skipped").length;
        const duplicateCount = reconciled.projects.filter((p) => p.status === "duplicate").length;
        const rejectedCount = reconciled.projects.filter((p) => p.status === "rejected").length;
        const pendingCount = reconciled.projects.filter((p) => p.status === "pending").length;
        const unresolvedCount = reconciled.projects.filter((p) => p.status === "unresolved").length;
        return {
          batch: reconciled,
          admittedCount,
          skippedCount,
          duplicateCount,
          rejectedCount,
          pendingCount,
          unresolvedCount,
        };
      }

      const now = new Date().toISOString();
      const batchId = createZaicodeAuditBatchId();
      const capacity = input.workerCapacity ?? ZAICODE_JOB_GLOBAL_CONCURRENCY_DEFAULT;
      const seenKeys = new Set<string>();
      const campaignIds: string[] = [];

      // 2. Write-ahead admission intent: persist complete intended project membership first
      mkdirSync(this.batchesDir(), { recursive: true });
      const admissions: ZaicodeAuditBatchProjectAdmission[] = (input.projects || []).map((p) => ({
        workspaceKey: p.workspaceKey?.trim() || "",
        workspacePath: p.workspacePath?.trim() || "",
        projectName: p.projectName?.trim() || "Unknown",
        campaignId: null,
        status: "pending",
      }));

      const batch: ZaicodeAuditBatch = {
        schemaVersion: 1,
        batchId,
        requestId,
        contentFingerprint,
        lifecycleRevision: 1,
        operatorActionId: requestId,
        createdAt: now,
        updatedAt: now,
        requestProvenance: input.requestProvenance ?? "operator_ui",
        profileId: ZAICODE_AUDIT_PROFILE.id,
        profileVersion: ZAICODE_AUDIT_PROFILE.version,
        manifestHash: zaicodeAuditProfileManifestHash(),
        planOnly: Boolean(input.planOnly),
        autoWaves: input.autoWaves ?? true,
        postAuditPolicy: resolvedPostAuditPolicy,
        workerCapacity: capacity,
        modelPolicy: input.modelPolicy ?? {},
        projects: admissions,
        campaignIds,
        status: "admitting",
        startedAt: input.planOnly ? null : now,
      };
      this.saveBatch(batch);

      let admittedCount = 0;
      let skippedCount = 0;
      let duplicateCount = 0;
      let rejectedCount = 0;

      for (const admission of batch.projects) {
        const durable = this.loadBatch(batchId);
        if (durable && (durable.status === "paused" || durable.status === "cancelled")) {
          break;
        }

        const key = admission.workspaceKey;
        if (!key || !admission.workspacePath) {
          admission.status = "rejected";
          admission.reason = "Missing workspaceKey or workspacePath";
          rejectedCount++;
          this.saveBatch(batch);
          continue;
        }

        if (seenKeys.has(key)) {
          admission.status = "duplicate";
          admission.reason = "Duplicate project in batch";
          duplicateCount++;
          this.saveBatch(batch);
          continue;
        }
        seenKeys.add(key);

        admission.status = "admitting";
        this.saveBatch(batch);

        const activeCampaign = this.loadCampaigns(true).find(
          (c) => c.workspaceKey === key && zaicodeAuditCampaignIsActive(c),
        );
        if (activeCampaign) {
          admission.status = "skipped";
          admission.campaignId = activeCampaign.campaignId;
          admission.reason = "Active campaign already in progress";
          skippedCount++;
          this.saveBatch(batch);
          continue;
        }

        const campaign = await this.generate(
          {
            workspaceKey: key,
            workspacePath: admission.workspacePath,
            projectName: admission.projectName,
          },
          undefined,
          {
            batchId,
            modelPolicy: input.modelPolicy,
            batchAutoWaves: input.autoWaves,
            postAuditPolicy: resolvedPostAuditPolicy,
          },
        );

        if (!campaign) {
          admission.status = "rejected";
          admission.reason = "Campaign generation failed";
          rejectedCount++;
          this.saveBatch(batch);
          continue;
        }

        const durableAfterGen = this.loadBatch(batchId);
        if (durableAfterGen && (durableAfterGen.status === "paused" || durableAfterGen.status === "cancelled")) {
          admission.campaignId = campaign.campaignId;
          admission.status = "admitted";
          if (!durableAfterGen.campaignIds.includes(campaign.campaignId)) {
            durableAfterGen.campaignIds.push(campaign.campaignId);
          }
          const pInDurable = durableAfterGen.projects.find((p) => p.workspaceKey === key);
          if (pInDurable) {
            pInDurable.campaignId = campaign.campaignId;
            pInDurable.status = "admitted";
          }
          this.saveBatch(durableAfterGen);
          break;
        }

        admission.campaignId = campaign.campaignId;
        admission.status = "admitted";
        if (!campaignIds.includes(campaign.campaignId)) {
          campaignIds.push(campaign.campaignId);
        }
        admittedCount++;
        batch.campaignIds = [...campaignIds];
        this.saveBatch(batch);

        if (!input.planOnly) {
          await this.work(campaign.campaignId);
        }
      }

      const finalDurable = this.loadBatch(batchId);
      if (finalDurable && (finalDurable.status === "paused" || finalDurable.status === "cancelled")) {
        return {
          batch: finalDurable,
          admittedCount: finalDurable.projects.filter((p) => p.status === "admitted").length,
          skippedCount: finalDurable.projects.filter((p) => p.status === "skipped").length,
          duplicateCount: finalDurable.projects.filter((p) => p.status === "duplicate").length,
          rejectedCount: finalDurable.projects.filter((p) => p.status === "rejected").length,
          pendingCount: finalDurable.projects.filter((p) => p.status === "pending").length,
          unresolvedCount: finalDurable.projects.filter((p) => p.status === "unresolved").length,
        };
      }

      const hasPendingOrUnresolved = batch.projects.some(
        (p) => p.status === "pending" || p.status === "admitting" || p.status === "unresolved",
      );
      batch.status = hasPendingOrUnresolved ? "blocked" : input.planOnly ? "planned" : "running";
      batch.updatedAt = new Date().toISOString();

      const allCampaignsForStats = this.loadCampaigns(true);
      const batchCampaignsForStats = allCampaignsForStats.filter(
        (c) => batch.campaignIds.includes(c.campaignId) || (c.batchId && c.batchId === batch.batchId),
      );
      batch.stats = {
        totalProjects: batch.projects.length,
        admittedCount: batch.projects.filter((p) => p.status === "admitted").length,
        queuedCount: batchCampaignsForStats.filter((c) => c.status === "planned").length,
        runningCount: batchCampaignsForStats.filter((c) => c.status === "running").length,
        completedCount: batchCampaignsForStats.filter((c) => c.status === "complete").length,
        blockedCount: batchCampaignsForStats.filter((c) => c.status === "blocked").length,
        cancelledCount: batchCampaignsForStats.filter((c) => c.status === "cancelled").length,
        rejectedCount: batch.projects.filter((p) => p.status === "rejected").length,
      };

      this.saveBatch(batch);

      const durableBeforePump = this.loadBatch(batchId);
      if (durableBeforePump && (durableBeforePump.status === "paused" || durableBeforePump.status === "cancelled")) {
        return {
          batch: durableBeforePump,
          admittedCount: durableBeforePump.projects.filter((p) => p.status === "admitted").length,
          skippedCount: durableBeforePump.projects.filter((p) => p.status === "skipped").length,
          duplicateCount: durableBeforePump.projects.filter((p) => p.status === "duplicate").length,
          rejectedCount: durableBeforePump.projects.filter((p) => p.status === "rejected").length,
          pendingCount: durableBeforePump.projects.filter((p) => p.status === "pending").length,
          unresolvedCount: durableBeforePump.projects.filter((p) => p.status === "unresolved").length,
        };
      }

      if (!input.planOnly) {
        await this.deps.jobService.pumpAll?.();
      }

      return {
        batch,
        admittedCount,
        skippedCount,
        duplicateCount,
        rejectedCount,
        pendingCount: batch.projects.filter((p) => p.status === "pending").length,
        unresolvedCount: batch.projects.filter((p) => p.status === "unresolved").length,
      };
    });
  }

  async pauseBatch(batchId: string, actionId?: string): Promise<ZaicodeAuditBatch | null> {
    const batch = this.loadBatch(batchId);
    if (!batch) return null;
    if (
      batch.status === "cancelled" ||
      batch.status === "stopping" ||
      batch.status === "stop_requested" ||
      batch.status === "stop_partial" ||
      batch.status === "stop_failed"
    ) {
      return batch;
    }
    batch.lifecycleRevision = (batch.lifecycleRevision ?? 0) + 1;
    batch.operatorActionId = actionId ?? `op-pause-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    batch.status = "paused";
    this.saveBatch(batch);
    return batch;
  }

  async resumeBatch(batchId: string, actionId?: string): Promise<ZaicodeAuditBatch | null> {
    const batch = this.loadBatch(batchId);
    if (!batch) return null;
    if (
      batch.status === "cancelled" ||
      batch.status === "stopping" ||
      batch.status === "stop_requested" ||
      batch.status === "stop_partial" ||
      batch.status === "stop_failed"
    ) {
      return batch;
    }
    if (batch.status === "running") return batch;

    const nextRevision = (batch.lifecycleRevision ?? 0) + 1;
    batch.lifecycleRevision = nextRevision;
    batch.operatorActionId = actionId ?? `op-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    batch.status = "running";
    this.saveBatch(batch);

    const targetRevision = nextRevision;

    for (const p of batch.projects) {
      const currentBefore = this.loadBatch(batchId);
      if (!currentBefore || currentBefore.lifecycleRevision !== targetRevision || currentBefore.status !== "running") {
        return currentBefore;
      }

      if (p.status === "pending" || p.status === "admitting") {
        const campaign = await this.generate(
          {
            workspaceKey: p.workspaceKey,
            workspacePath: p.workspacePath,
            projectName: p.projectName,
          },
          undefined,
          {
            batchId: batch.batchId,
            modelPolicy: batch.modelPolicy,
            batchAutoWaves: batch.autoWaves,
            postAuditPolicy: batch.postAuditPolicy,
          },
        );

        const currentAfterGen = this.loadBatch(batchId);
        if (!currentAfterGen || currentAfterGen.lifecycleRevision !== targetRevision || currentAfterGen.status !== "running") {
          return currentAfterGen;
        }

        const projectInCurrent = currentAfterGen.projects.find((cp) => cp.workspaceKey === p.workspaceKey) ?? p;
        if (campaign) {
          projectInCurrent.campaignId = campaign.campaignId;
          projectInCurrent.status = "admitted";
          if (!currentAfterGen.campaignIds.includes(campaign.campaignId)) {
            currentAfterGen.campaignIds.push(campaign.campaignId);
          }
          this.saveBatch(currentAfterGen, targetRevision);

          if (!currentAfterGen.planOnly) {
            await this.work(campaign.campaignId);
          }
        } else {
          projectInCurrent.status = "rejected";
          projectInCurrent.reason = "Campaign generation failed";
          this.saveBatch(currentAfterGen, targetRevision);
        }

        const currentAfterWork = this.loadBatch(batchId);
        if (!currentAfterWork || currentAfterWork.lifecycleRevision !== targetRevision || currentAfterWork.status !== "running") {
          return currentAfterWork;
        }
      }
    }

    const currentBeforePlanned = this.loadBatch(batchId);
    if (!currentBeforePlanned || currentBeforePlanned.lifecycleRevision !== targetRevision || currentBeforePlanned.status !== "running") {
      return currentBeforePlanned;
    }

    for (const campaignId of currentBeforePlanned.campaignIds) {
      const current = this.loadBatch(batchId);
      if (!current || current.lifecycleRevision !== targetRevision || current.status !== "running") {
        return current;
      }
      const campaign = this.findCampaign(campaignId);
      if (campaign && campaign.status === "planned") {
        await this.work(campaignId);
      }
    }

    const currentBeforePump = this.loadBatch(batchId);
    if (!currentBeforePump || currentBeforePump.lifecycleRevision !== targetRevision || currentBeforePump.status !== "running") {
      return currentBeforePump;
    }

    await this.deps.jobService.pumpAll?.();
    return this.getBatch(batchId);
  }

  async stopBatch(batchId: string, actionId?: string): Promise<ZaicodeAuditBatch | null> {
    const batch = this.loadBatch(batchId);
    if (!batch) return null;
    if (batch.status === "cancelled") return batch;

    const nextRevision = (batch.lifecycleRevision ?? 0) + 1;
    batch.lifecycleRevision = nextRevision;
    batch.operatorActionId = actionId ?? `op-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    batch.status = "stopping";
    this.saveBatch(batch);

    const stoppedCampaignIds: string[] = [];
    const failedCampaignIds: string[] = [];

    const targetCampaignIds = new Set<string>(batch.campaignIds);
    for (const p of batch.projects) {
      if (p.campaignId) targetCampaignIds.add(p.campaignId);
    }
    const allKnownCampaigns = this.loadCampaigns(true);
    for (const c of allKnownCampaigns) {
      if (c.batchId && c.batchId === batchId) {
        targetCampaignIds.add(c.campaignId);
      }
    }

    for (const campaignId of targetCampaignIds) {
      const current = this.loadBatch(batchId);
      if (!current || current.lifecycleRevision !== nextRevision) {
        return current;
      }
      const res = await this.cancel(campaignId);
      if (!res || (res.status !== "cancelled" && res.status !== "complete")) {
        failedCampaignIds.push(campaignId);
      } else {
        stoppedCampaignIds.push(campaignId);
      }
    }

    const currentAfterStops = this.loadBatch(batchId);
    if (!currentAfterStops || currentAfterStops.lifecycleRevision !== nextRevision) {
      return currentAfterStops;
    }

    const allCampaignsAfter = this.loadCampaigns(true);
    const owned = allCampaignsAfter.filter(
      (c) => targetCampaignIds.has(c.campaignId) || (c.batchId && c.batchId === batchId),
    );
    const stillActive = owned.filter((c) => c.status === "running" || zaicodeAuditCampaignIsActive(c));
    const activeWorkers = await this.getActiveWorkers();
    const batchWorkers = activeWorkers.filter((w) => w.batchId === batchId);

    currentAfterStops.stopDetails = {
      stoppedCampaignIds,
      failedCampaignIds,
      reason:
        batchWorkers.length > 0
          ? `${batchWorkers.length} worker(s) still active`
          : stillActive.length > 0
            ? `${stillActive.length} campaign(s) still active`
            : undefined,
    };

    if (failedCampaignIds.length > 0) {
      if (stoppedCampaignIds.length > 0) {
        currentAfterStops.status = "stop_partial";
      } else {
        currentAfterStops.status = "stop_failed";
      }
    } else if (batchWorkers.length > 0 || stillActive.length > 0) {
      currentAfterStops.status = "stopping";
    } else {
      currentAfterStops.status = "cancelled";
      currentAfterStops.completedAt = new Date().toISOString();
    }

    const batchCampaignsForStats = allCampaignsAfter.filter(
      (c) => currentAfterStops.campaignIds.includes(c.campaignId) || (c.batchId && c.batchId === batchId),
    );
    currentAfterStops.stats = {
      totalProjects: currentAfterStops.projects.length,
      admittedCount: currentAfterStops.projects.filter((p) => p.status === "admitted").length,
      queuedCount: batchCampaignsForStats.filter((c) => c.status === "planned").length,
      runningCount: batchCampaignsForStats.filter((c) => c.status === "running").length,
      completedCount: batchCampaignsForStats.filter((c) => c.status === "complete").length,
      blockedCount: batchCampaignsForStats.filter((c) => c.status === "blocked").length,
      cancelledCount: batchCampaignsForStats.filter((c) => c.status === "cancelled").length,
      rejectedCount: currentAfterStops.projects.filter((p) => p.status === "rejected").length,
    };

    this.saveBatch(currentAfterStops);
    return this.loadBatch(batchId) ?? currentAfterStops;
  }

  async retryBatch(
    batchId: string,
    mode: "all_failed" | "blocked_only" = "blocked_only",
    actionId?: string,
  ): Promise<ZaicodeAuditBatch | null> {
    const batch = this.loadBatch(batchId);
    if (!batch) return null;
    if (
      batch.status === "cancelled" ||
      batch.status === "stopping" ||
      batch.status === "stop_requested"
    ) {
      return batch;
    }

    const nextRevision = (batch.lifecycleRevision ?? 0) + 1;
    batch.lifecycleRevision = nextRevision;
    batch.operatorActionId = actionId ?? `op-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    batch.status = "running";
    this.saveBatch(batch);

    const targetRevision = nextRevision;

    for (const campaignId of batch.campaignIds) {
      const current = this.loadBatch(batchId);
      if (!current || current.lifecycleRevision !== targetRevision || current.status !== "running") {
        return current;
      }
      const campaign = this.findCampaign(campaignId);
      if (!campaign) continue;
      if (campaign.status === "blocked" || (mode === "all_failed" && campaign.status === "cancelled")) {
        await this.retry(campaignId);
      }
    }

    const currentBeforePump = this.loadBatch(batchId);
    if (!currentBeforePump || currentBeforePump.lifecycleRevision !== targetRevision || currentBeforePump.status !== "running") {
      return currentBeforePump;
    }

    await this.deps.jobService.pumpAll?.();
    return this.getBatch(batchId);
  }

  async getActiveWorkers(): Promise<ZaicodeAuditWorker[]> {
    let runningJobs: ZaicodeJob[] = [];
    try {
      const listRes = await this.deps.jobService.list({ status: "running" });
      runningJobs = listRes.jobs;
    } catch (error) {
      this.deps.logger?.warn("ZAICODE audits: failed to list running jobs for active workers", error);
      return [];
    }

    const workers: ZaicodeAuditWorker[] = [];
    for (const job of runningJobs) {
      const meta =
        job.auditMetadata ??
        (() => {
          const match = /\[([a-zA-Z0-9_-]+)#(\d+)\]/.exec(job.title);
          return match?.[1]
            ? {
                campaignId: match[1],
                waveId: "core",
                attempt: parseInt(match[2] ?? "1", 10) || 1,
                batchId: undefined,
              }
            : null;
        })();
      if (!meta?.campaignId) continue;

      try {
        const agent = await this.deps.agentService.get(job.agentId).catch(() => null);
        const model =
          formatZaicodeModelLabel(job.actualModelSelection) ||
          formatZaicodeModelLabel(agent?.modelSelection, agent) ||
          "default";
        const provider =
          job.actualModelSelection?.providerId ??
          agent?.providerRef ??
          agent?.modelSelection?.providerId ??
          "builtin";

        const titleMatch = / — (.*) \[/.exec(job.title);
        const projectName = titleMatch?.[1] ? titleMatch[1].trim() : job.workspaceKey;
        const waveId = (meta.waveId ?? "core") as "core" | "second" | "performance";
        const waveOrdinal = waveId === "second" ? 2 : waveId === "performance" ? 3 : 1;
        const generation = ("generation" in meta ? meta.generation : undefined) ?? (meta.attempt ?? (job.attempt || 1));

        workers.push({
          workerId: `worker-${job.id}-${job.runId ?? "0"}`,
          runId: job.runId ?? "",
          sessionId: job.sessionId ?? "",
          projectKey: job.workspaceKey,
          projectName,
          waveId,
          waveOrdinal,
          model,
          provider,
          startedAt: job.startedAt ? Number(job.startedAt) : Date.now(),
          lastHeartbeatAt: job.heartbeatAt ? Number(job.heartbeatAt) : Date.now(),
          status: "running",
          jobId: job.id,
          attempt: job.attempt,
          batchId: meta.batchId ? String(meta.batchId) : null,
          campaignId: meta.campaignId,
          generation,
        });
      } catch (error) {
        this.deps.logger?.warn(`ZAICODE audits: failed to project worker for job ${job.id}`, error);
      }
    }
    return workers;
  }

  dispose(): void {
    this.writeLocks.clear();
  }
}

export type { ZaicodeAuditCampaignWaveState };
