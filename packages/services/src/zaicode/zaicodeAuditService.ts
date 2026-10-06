/* oxlint-disable eslint(max-lines) -- A3 活动、wave 队列和 Auto 恢复共用持久化锁与原子写入边界；拆开会增加重复调度风险。 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ZAICODE_AUDIT_PROFILE,
  buildZaicodeQuick3WavePrompt,
  countZaicodeOpenBoardTickets,
  formatZaicodeModelLabel,
  shouldStartZaicodeAuditCampaign,
  synthesizeZaicodeAuditCombined,
  zaicodeAuditCampaignIsActive,
  zaicodeAuditCombinedFileName,
  zaicodeAuditIdempotencyKey,
  zaicodeAuditProfileManifestHash,
  zaicodeAuditQuick3Wave,
  zaicodeAuditWaveFileName,
  validateZaicodeAuditArtifact,
  type ZaicodeAuditCampaign,
  type ZaicodeAuditCampaignWaveState,
  type ZaicodeAuditorView,
  type ZaicodeAuditsReport,
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
  private smartProjects: SmartProject[] = [];
  private auditAgentId: string | null = null;
  private remediationAgentId: string | null = null;
  private smartSweepRunning = false;

  constructor(private readonly deps: ZaicodeAuditServiceDeps) {}

  private root(): string {
    return this.deps.rootDir?.() ?? join(getAppConfigDir(), "zaicode-audits");
  }

  private campaignDir(campaignId: string): string {
    return join(this.root(), campaignId);
  }

  private campaignFile(campaignId: string): string {
    return join(this.campaignDir(campaignId), "campaign.json");
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

  private findCampaign(campaignId: string): ZaicodeAuditCampaign | null {
    return this.loadCampaigns().find((entry) => entry.campaignId === campaignId) ?? null;
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
    const agentId = await this.ensureAuditAgent();
    if (!state || !wave || !agentId) return;

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
      existing.jobs.find((candidate) => candidate.title === title) ??
      (await this.deps.jobService.create({
        workspaceKey: campaign.workspaceKey,
        workspacePath: campaign.workspacePath,
        agentId,
        title,
        instructions: prompt,
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
    // The one exception is a campaign the global wave switch parked (R008): the
    // switch going back on releases it. A campaign the operator planned by hand
    // has no hold flag, so it still waits for their own Continue.
    if (campaign.status === "planned") {
      if (!campaign.autoAdvanceHeld || !this.readSmartSettings().autoWaves) return;
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
      state.status = "running";
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
        // SRC-151:R008: this is the one place a wave is generated without being
        // asked for. With the global switch off the campaign parks as `planned`
        // -- the state that already means "waiting in the review queue" -- so the
        // card's own Continue is what starts the next wave, and nothing else
        // changes: the finished artifact stays exactly as validated.
        if (!this.readSmartSettings().autoWaves) {
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

  private async reconcileAll(): Promise<void> {
    for (const { campaignId } of this.loadCampaigns()) {
      // Re-read under the lock: the list was read before it, and a cancel() or
      // work() that held the lock meanwhile has written a newer state.
      // One file, not findCampaign(): that rescans every campaign directory.
      await this.withCampaign(campaignId, async () => {
        const campaign = ZaicodeAuditService.readJson<ZaicodeAuditCampaign>(this.campaignFile(campaignId));
        if (campaign && (campaign.schemaVersion === 1 || campaign.schemaVersion === 2)) {
          await this.reconcileCampaign(campaign);
        }
      }).catch(() => undefined);
    }
  }

  async getState(): Promise<{
    campaigns: ZaicodeAuditCampaign[];
    smartMode: boolean;
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

  async generate(input: SmartProject, smartRunId?: string): Promise<ZaicodeAuditCampaign | null> {
    const now = new Date().toISOString();
    const agent = await this.ensureAuditAgent();
    const modelIdentity = agent
      ? formatZaicodeModelLabel(
          (await this.deps.agentService.list().then((result) => result.agents).catch(() => []))
            .find((entry) => entry.id === agent)
            ?.modelSelection,
        )
      : null;
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
    if (!settings.smartMode) return { started: [] };
    // Fresh E2 (SRC-153 R013): the global wave switch gates automatic ADMISSION,
    // not just wave progression. Disabled means Auto Continue / Continue All
    // create zero automatic campaigns and resume zero planned ones -- not even
    // the first wave. Manual admission (panel start/generate/Continue, /a3)
    // never passes through here and is unaffected; running work is untouched.
    if (!settings.autoWaves) return { started: [] };
    if (!settings.runId) {
      await this.setSmartMode(false);
      await this.setSmartMode(true);
      return this.smartSweep();
    }
    this.smartSweepRunning = true;
    try {
      const campaigns = this.loadCampaigns(true);
      const running = await this.runningJobCount();
      const started: string[] = [];
      for (const project of this.smartProjects) {
        if (project.disabled) continue;
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
          if (gate !== "ready") continue;
        }
        if (cycles >= settings.maxCycles) continue;
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
        const campaign = await this.start(project, settings.runId).catch((error) => {
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

  dispose(): void {
    this.writeLocks.clear();
  }
}

export type { ZaicodeAuditCampaignWaveState };
