/* oxlint-disable eslint(max-lines) -- A3 活动、wave 队列和 Auto 恢复共用持久化锁与原子写入边界；拆开会增加重复调度风险。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ZAICODE_AUDIT_PROFILE_A3,
  buildZaicodeAuditWavePrompt,
  countZaicodeOpenBoardTickets,
  parseZaicodeAuditActionableFindings,
  parseZaicodeAuditWaveReport,
  shouldStartZaicodeAuditCampaign,
  zaicodeAuditCampaignIsActive,
  zaicodeAuditWaveOf,
  type ZaicodeAuditCampaign,
  type ZaicodeAuditWave,
  type ZaicodeAuditsReport,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import type { IZaicodeAgentService } from "./zaicodeAgents.js";
import type { IZaicodeAuditService } from "./zaicodeAudits.js";
import type { IZaicodeJobService } from "./zaicodeJobs.js";

/**
 * ZAICODE A3 audit service (T-66, SRC-049): AUDAPACK's campaign machine on
 * ZAICODE's own durable queue. A campaign is three waves; every wave is one
 * ordinary queue job (lease, retry, parallelism come with the queue), whose
 * instructions are the wave prompt and whose report file gates completion
 * (STATUS line + done marker — AUDAPACK's rule). Generate-first: `generate`
 * writes the campaign as `planned` into the review queue and dispatches
 * nothing; `work` starts it. Smart mode: an empty SAIPEN board with nothing
 * running makes the project audit itself. State is JSON beside the reports in
 * {appConfig}/zaicode-audits/<id>/campaign.json, written atomically.
 */

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

  private settingsPath(): string {
    return join(this.root(), "settings.json");
  }

  private static safeName(name: string): string {
    return name.replace(/[^\w.-]+/g, "_").slice(0, 48) || "project";
  }

  private static reportFileName(campaign: ZaicodeAuditCampaign, wave: ZaicodeAuditWave): string {
    return `${ZaicodeAuditService.safeName(campaign.projectName)}__0${wave.ordinal}_${wave.slug}.md`;
  }

  private static writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
      if (campaign && campaign.schemaVersion === 1) campaigns.push(campaign);
    }
    campaigns.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    const active = campaigns.filter(zaicodeAuditCampaignIsActive);
    const finished = campaigns.filter((campaign) => !zaicodeAuditCampaignIsActive(campaign)).slice(0, includeAll ? undefined : ZaicodeAuditService.HISTORY_CAP);
    return [...active, ...finished].sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  private findCampaign(campaignId: string): ZaicodeAuditCampaign | null {
    return this.loadCampaigns().find((entry) => entry.campaignId === campaignId) ?? null;
  }

  private readSmartSettings(): SmartSettings {
    const raw = ZaicodeAuditService.readJson<Partial<SmartSettings>>(this.settingsPath());
    const maxCycles = Number.isInteger(raw?.maxCycles) ? Math.max(1, Math.min(10, raw!.maxCycles!)) : 10;
    return {
      smartMode: raw?.smartMode === true,
      maxCycles,
      runId: typeof raw?.runId === "string" && raw.runId ? raw.runId : null,
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

  /** Reconcile a completed audit with one durable implementation job. */
  private async smartRemediationGate(campaign: ZaicodeAuditCampaign): Promise<"ready" | "waiting" | "stop"> {
    if (campaign.status !== "complete" || !campaign.finalHandoffFile) return "stop";
    const campaignFile = join(this.campaignDir(campaign.campaignId), "campaign.json");
    const reportPath = join(this.campaignDir(campaign.campaignId), campaign.finalHandoffFile);
    if (campaign.actionableFindings === undefined) {
      const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      campaign.actionableFindings = parseZaicodeAuditActionableFindings(report);
      ZaicodeAuditService.writeJsonAtomic(campaignFile, campaign);
    }
    if (campaign.actionableFindings === null) {
      this.deps.logger?.warn(`ZAICODE audits: final handoff lacks ACTIONABLE_FINDINGS for ${campaign.projectName}`);
      return "stop";
    }
    if (campaign.actionableFindings === 0) return "stop";

    const title = `A3 REMEDIATE ${campaign.campaignId}`;
    let job = campaign.remediationJobId ? await this.deps.jobService.get(campaign.remediationJobId) : null;
    if (!job) {
      // Query before create: a crash after queue write but before campaign write
      // must not dispatch the same handoff twice on restart.
      const existing = await this.deps.jobService.list({ workspaceKey: campaign.workspaceKey });
      job = existing.jobs.find((candidate) => candidate.title === title) ?? null;
    }
    if (!job) {
      const agentId = await this.ensureRemediationAgent();
      if (!agentId) return "stop";
      job = await this.deps.jobService.create({
        workspaceKey: campaign.workspaceKey,
        workspacePath: campaign.workspacePath,
        agentId,
        title,
        instructions: [
          `Implement the verified actionable findings from A3 audit ${campaign.campaignId} in ${campaign.workspacePath}.`,
          `Read the combined handoff at ${reportPath} and the three wave reports in its directory.`,
          "Use the project's SAIPEN workflow when present. Work through the findings, keep BOARD and STATE current, and report exact evidence.",
          "If a finding is invalid or unsafe, record why and continue with the remaining findings.",
          "Do not start another audit; the automatic controller decides when to do that.",
        ].join("\n"),
      });
    }
    if (campaign.remediationJobId !== job.id) {
      campaign.remediationJobId = job.id;
      campaign.updatedAt = new Date().toISOString();
      ZaicodeAuditService.writeJsonAtomic(campaignFile, campaign);
    }
    if (job.status === "completed") return "ready";
    if (job.status === "failed" || job.status === "cancelled" || job.status === "blocked") {
      this.deps.logger?.warn(`ZAICODE audits: remediation ${job.status} for ${campaign.projectName}`);
      return "stop";
    }
    return "waiting";
  }

  private async enqueueWave(campaign: ZaicodeAuditCampaign, waveIndex: number): Promise<void> {
    const state = campaign.waves[waveIndex];
    const wave = state ? zaicodeAuditWaveOf(ZAICODE_AUDIT_PROFILE_A3, state.waveId) : null;
    const agentId = await this.ensureAuditAgent();
    if (!state || !wave || !agentId) return;
    const previous =
      waveIndex > 0 && campaign.waves[waveIndex - 1]?.reportFile
        ? join(this.campaignDir(campaign.campaignId), campaign.waves[waveIndex - 1]!.reportFile!)
        : null;
    const previousReports = campaign.waves.slice(0, waveIndex)
      .flatMap((entry) => entry.reportFile ? [join(this.campaignDir(campaign.campaignId), entry.reportFile)] : []);
    const prompt = buildZaicodeAuditWavePrompt({
      projectName: campaign.projectName,
      workspacePath: campaign.workspacePath,
      wave,
      reportFile: join(this.campaignDir(campaign.campaignId), ZaicodeAuditService.reportFileName(campaign, wave)),
      previousReport: previous,
      previousReports,
    });
    // 队列写入成功但活动文件尚未保存时，用唯一标题找回同一 wave，避免重复执行。
    const title = `A3 ${wave.ordinal}/3 ${wave.title} — ${campaign.projectName} [${campaign.campaignId}]`;
    const existing = await this.deps.jobService.list({ workspaceKey: campaign.workspaceKey });
    const job = existing.jobs.find((candidate) => candidate.title === title) ?? await this.deps.jobService.create({
      workspaceKey: campaign.workspaceKey,
      workspacePath: campaign.workspacePath,
      agentId,
      title,
      instructions: prompt,
    });
    state.jobId = job.id;
    state.status = "running";
    state.reportFile = ZaicodeAuditService.reportFileName(campaign, wave);
    campaign.currentWaveIndex = waveIndex;
    campaign.status = "running";
    campaign.updatedAt = new Date().toISOString();
    ZaicodeAuditService.writeJsonAtomic(join(this.campaignDir(campaign.campaignId), "campaign.json"), campaign);
  }

  /**
   * AUDAPACK's wave gate: a completed job only counts when its report file
   * answers with the wave's STATUS line and done marker. Partial or failed
   * waves block the campaign (the operator retries the job or cancels).
   */
  private async reconcileCampaign(campaign: ZaicodeAuditCampaign): Promise<void> {
    if (campaign.status === "complete" || campaign.status === "cancelled") return;
    // Generate-first: a planned campaign waits in the review queue until work().
    if (campaign.status === "planned") return;
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
    if (job.status === "completed") {
      const reportPath = join(dir, state.reportFile ?? "");
      const text = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      const wave = zaicodeAuditWaveOf(ZAICODE_AUDIT_PROFILE_A3, state.waveId)!;
      const verdict = parseZaicodeAuditWaveReport(text, wave);
      const actionableFindings = wave.finalizer && campaign.smartRunId
        ? parseZaicodeAuditActionableFindings(text)
        : null;
      if (!verdict.complete || (wave.finalizer && campaign.smartRunId && actionableFindings === null)) {
        state.status = "partial";
        campaign.status = "blocked";
        if (wave.finalizer && campaign.smartRunId) campaign.actionableFindings = actionableFindings;
        campaign.updatedAt = new Date().toISOString();
        ZaicodeAuditService.writeJsonAtomic(join(dir, "campaign.json"), campaign);
        this.deps.logger?.warn(`ZAICODE audits: wave ${state.waveId} partial (${verdict.complete ? "missing-actionable-count" : verdict.reason}) for ${campaign.projectName}`);
        return;
      }
      state.status = "complete";
      state.resultSha256 = createHash("sha256").update(text, "utf8").digest("hex");
      state.completedAt = new Date().toISOString();
      const nextIndex = campaign.currentWaveIndex + 1;
      campaign.updatedAt = new Date().toISOString();
      if (nextIndex < campaign.waves.length) {
        campaign.waves[nextIndex]!.status = "pending";
        ZaicodeAuditService.writeJsonAtomic(join(dir, "campaign.json"), campaign);
        await this.enqueueWave(campaign, nextIndex);
      } else {
        campaign.status = "complete";
        // The finalizer wave's report IS the combined handoff (its contract says so).
        campaign.finalHandoffFile = state.reportFile;
        if (campaign.smartRunId) campaign.actionableFindings = actionableFindings;
        ZaicodeAuditService.writeJsonAtomic(join(dir, "campaign.json"), campaign);
      }
      return;
    }
    // failed / stopped / blocked
    state.status = "blocked";
    campaign.status = "blocked";
    campaign.updatedAt = new Date().toISOString();
    ZaicodeAuditService.writeJsonAtomic(join(dir, "campaign.json"), campaign);
  }

  private async reconcileAll(): Promise<void> {
    for (const campaign of this.loadCampaigns()) {
      await this.withCampaign(campaign.campaignId, () => this.reconcileCampaign(campaign)).catch(() => undefined);
    }
  }

  async getState(): Promise<{ campaigns: ZaicodeAuditCampaign[]; smartMode: boolean; maxCycles: number; runId: string | null }> {
    await this.reconcileAll();
    const campaigns = await Promise.all(this.loadCampaigns().map(async (campaign) => {
      if (!campaign.remediationJobId) return campaign;
      const job = await this.deps.jobService.get(campaign.remediationJobId).catch(() => null);
      return { ...campaign, remediationStatus: job?.status ?? null };
    }));
    return { campaigns, ...this.readSmartSettings() };
  }

  async getCampaign(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.findCampaign(campaignId);
  }

  async generate(input: SmartProject, smartRunId?: string): Promise<ZaicodeAuditCampaign | null> {
    const now = new Date().toISOString();
    const campaign: ZaicodeAuditCampaign = {
      schemaVersion: 1,
      campaignId: randomUUID(),
      profileId: ZAICODE_AUDIT_PROFILE_A3.id,
      ...(smartRunId ? { smartRunId } : {}),
      projectName: input.projectName,
      workspaceKey: input.workspaceKey,
      workspacePath: input.workspacePath,
      status: "planned",
      createdAt: now,
      updatedAt: now,
      currentWaveIndex: 0,
      waves: ZAICODE_AUDIT_PROFILE_A3.waves.map((wave) => ({
        waveId: wave.id,
        status: "pending",
        jobId: null,
        reportFile: null,
        resultSha256: null,
        completedAt: null,
      })),
      finalHandoffFile: null,
    };
    mkdirSync(this.campaignDir(campaign.campaignId), { recursive: true });
    ZaicodeAuditService.writeJsonAtomic(join(this.campaignDir(campaign.campaignId), "campaign.json"), campaign);
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

  async cancel(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.withCampaign(campaignId, async () => {
      const campaign = this.findCampaign(campaignId);
      if (!campaign || campaign.status === "complete" || campaign.status === "cancelled") return campaign;
      const state = campaign.waves[campaign.currentWaveIndex];
      if (state?.jobId) await this.deps.jobService.cancel(state.jobId).catch(() => undefined);
      campaign.status = "cancelled";
      campaign.updatedAt = new Date().toISOString();
      ZaicodeAuditService.writeJsonAtomic(join(this.campaignDir(campaign.campaignId), "campaign.json"), campaign);
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

  async setSmartMode(enabled: boolean): Promise<{ smartMode: boolean }> {
    const current = this.readSmartSettings();
    ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), {
      ...current,
      smartMode: enabled,
      runId: enabled && !current.smartMode ? randomUUID() : current.runId,
    });
    return { smartMode: enabled };
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
