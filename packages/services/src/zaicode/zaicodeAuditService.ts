import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ZAICODE_AUDIT_PROFILE_A3,
  buildZaicodeAuditWavePrompt,
  countZaicodeOpenBoardTickets,
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
}

export class ZaicodeAuditService implements IZaicodeAuditService {
  private readonly writeLocks = new Map<string, Promise<void>>();
  private smartProjects: SmartProject[] = [];
  private auditAgentId: string | null = null;

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

  private loadCampaigns(): ZaicodeAuditCampaign[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const campaigns: ZaicodeAuditCampaign[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const campaign = ZaicodeAuditService.readJson<ZaicodeAuditCampaign>(join(root, entry.name, "campaign.json"));
      if (campaign && campaign.schemaVersion === 1) campaigns.push(campaign);
    }
    return campaigns.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  private findCampaign(campaignId: string): ZaicodeAuditCampaign | null {
    return this.loadCampaigns().find((entry) => entry.campaignId === campaignId) ?? null;
  }

  private readSmartMode(): boolean {
    return ZaicodeAuditService.readJson<{ smartMode?: boolean }>(this.settingsPath())?.smartMode === true;
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
      return 0;
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

  private async enqueueWave(campaign: ZaicodeAuditCampaign, waveIndex: number): Promise<void> {
    const state = campaign.waves[waveIndex];
    const wave = state ? zaicodeAuditWaveOf(ZAICODE_AUDIT_PROFILE_A3, state.waveId) : null;
    const agentId = await this.ensureAuditAgent();
    if (!state || !wave || !agentId) return;
    const previous =
      waveIndex > 0 && campaign.waves[waveIndex - 1]?.reportFile
        ? join(this.campaignDir(campaign.campaignId), campaign.waves[waveIndex - 1]!.reportFile!)
        : null;
    const prompt = buildZaicodeAuditWavePrompt({
      projectName: campaign.projectName,
      workspacePath: campaign.workspacePath,
      wave,
      reportFile: join(this.campaignDir(campaign.campaignId), ZaicodeAuditService.reportFileName(campaign, wave)),
      previousReport: previous,
    });
    const job = await this.deps.jobService.create({
      workspaceKey: campaign.workspaceKey,
      workspacePath: campaign.workspacePath,
      agentId,
      title: `A3 ${wave.ordinal}/3 ${wave.title} — ${campaign.projectName}`,
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
      if (!verdict.complete) {
        state.status = "partial";
        campaign.status = "blocked";
        campaign.updatedAt = new Date().toISOString();
        ZaicodeAuditService.writeJsonAtomic(join(dir, "campaign.json"), campaign);
        this.deps.logger?.warn(`ZAICODE audits: wave ${state.waveId} partial (${verdict.reason}) for ${campaign.projectName}`);
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

  async getState(): Promise<{ campaigns: ZaicodeAuditCampaign[]; smartMode: boolean }> {
    await this.reconcileAll();
    return { campaigns: this.loadCampaigns(), smartMode: this.readSmartMode() };
  }

  async getCampaign(campaignId: string): Promise<ZaicodeAuditCampaign | null> {
    return this.findCampaign(campaignId);
  }

  async generate(input: SmartProject): Promise<ZaicodeAuditCampaign | null> {
    const now = new Date().toISOString();
    const campaign: ZaicodeAuditCampaign = {
      schemaVersion: 1,
      campaignId: randomUUID(),
      profileId: ZAICODE_AUDIT_PROFILE_A3.id,
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

  async start(input: SmartProject): Promise<ZaicodeAuditCampaign | null> {
    const campaign = await this.generate(input);
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
    ZaicodeAuditService.writeJsonAtomic(this.settingsPath(), { smartMode: enabled });
    return { smartMode: enabled };
  }

  async publishProjects(projects: SmartProject[]): Promise<void> {
    this.smartProjects = Array.isArray(projects) ? projects.slice(0, 200) : [];
  }

  /** SRC-049: empty board + nothing running -> the project audits itself. */
  async smartSweep(): Promise<ZaicodeAuditsReport> {
    if (!this.readSmartMode()) return { started: [] };
    const campaigns = this.loadCampaigns();
    const running = await this.runningJobCount();
    const started: string[] = [];
    for (const project of this.smartProjects) {
      const active = campaigns.find(
        (campaign) => campaign.workspacePath === project.workspacePath && zaicodeAuditCampaignIsActive(campaign),
      );
      const openTickets = this.countOpenBoardTickets(project.workspacePath);
      const decide = shouldStartZaicodeAuditCampaign({
        smartMode: true,
        hasSaipenBoard: openTickets !== null,
        openBoardTickets: openTickets ?? 1,
        runningSessions: running,
        activeCampaign: active ?? null,
      });
      if (!decide) continue;
      this.deps.logger?.info?.(`ZAICODE audits: smart mode starting A3 for ${project.projectName}`);
      await this.start(project).catch(() => undefined);
      started.push(project.workspacePath);
    }
    return { started };
  }

  dispose(): void {
    this.writeLocks.clear();
  }
}
