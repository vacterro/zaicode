/* eslint-disable max-lines -- SRC-161:W2-001 put two recovery statements into the owner that arms
   them: the shutdown lease release in dispose(), and the bounded stale-running reaper on the
   heartbeat this service already runs. This file held exactly the 400 logical-line ceiling before
   them, and keeping them beside the host-owned execution truth beats an eleven-line module. */
import { randomUUID } from "node:crypto";
import {
  ZAICODE_JOB_CONCURRENCY_DEFAULT,
  ZAICODE_JOB_CONCURRENCY_MAX,
  ZAICODE_JOB_HEARTBEAT_STALE_MS as HEARTBEAT_STALE_MS,
  ZAICODE_DISABLED_WORKSPACES_SETTING_KEY,
  isZaicodeJobTerminal,
  isZaicodeWorkspaceDisabled,
  normalizeZaicodeDisabledWorkspaces,
  setZaicodeWorkspaceDisabledIn,
  mapTaskOutcomeToZaicodeJobStatus,
  zaicodeJobSchema,
  type ZaicodeAgentDefinition,
  type ZaicodeJob,
  type ZaicodeJobCreateInput,
  type ZaicodeJobListFilter,
  type ZaicodeJobListResult,
  type ZaicodeJobUpdatePatch,
  type ZaicodeDelegationPolicy,
} from "@zcode/shared";
import {
  delegateZaicodeJobFromRun,
  readZaicodeDelegationPolicy,
  writeZaicodeDelegationPolicy,
  type ZaicodeDelegationResult,
} from "./zaicodeJobDelegation.js";
import type {
  ZaicodeJobRunOutcomeInput,
  IZaicodeJobService,
  ZaicodeJobExecutor,
} from "./zaicodeJobs.js";
import type { ZaicodeJobRepo } from "./zaicodeJobRepo.js";
import { cancelZaicodeJob, retainZaicodeCancellationFailure } from "./zaicodeJobCancellation.js";

const MAX_CONCURRENCY_SETTING_KEY = "max_concurrency_per_workspace";
/** 自动驾驶：入队 / 完成 / 恢复后自动按并发上限派发；默认开启，"0" 关闭。 */
const AUTO_RUN_SETTING_KEY = "auto_run";
const HEARTBEAT_INTERVAL_MS = 30_000;

interface ZaicodeJobServiceDeps {
  repo: ZaicodeJobRepo;
  /** agent 定义读取（由 node 装配注入 agent 服务）；派发前校验存在且启用。 */
  getAgent: (agentId: string) => Promise<ZaicodeAgentDefinition | null>;
  /** 全部 agent 定义：运行时委托按角色挑选 helper。 */
  listAgents?: () => Promise<ZaicodeAgentDefinition[]>;
  /** 子任务到达终态：host 把结果送回发起委托的运行（spool 回执）。 */
  onChildFinished?: (child: ZaicodeJob) => void;
  /** host 注入的真实执行器；未装配时派发落入 blocked，不假装开始。 */
  getExecutor: () => ZaicodeJobExecutor | null;
  now?: () => number;
  logger?: { warn(message: string, error?: unknown): void };
  onJobsChanged?: () => void;
}

interface RunningHandle {
  runId: string;
  stop?: () => Promise<void>;
}

/**
 * ZAICODE 任务队列服务（handoff M7/M9）。
 *
 * 唯一权威所有者：队列存储。原子认领保证同一任务不会被派发两次；
 * 终态写入携带 runId+attempt，陈旧完成无法覆盖新重试；
 * 心跳租约让崩溃/重启后的 running 行可被解释地回收为 blocked。
 */
export class ZaicodeJobService implements IZaicodeJobService {
  private readonly hostId = randomUUID();
  private readonly runningHandles = new Map<string, RunningHandle>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ZaicodeJobServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitChanged(): void {
    try {
      this.deps.onJobsChanged?.();
    } catch {
      // 广播钩子失败不影响队列事实。
    }
  }

  private log(message: string, error?: unknown): void {
    this.deps.logger?.warn(message, error);
  }

  /** 装配入口：迁移就绪、回收陈旧 running、启动执行心跳。 */
  async ensureReady(): Promise<void> {
    await this.deps.repo.ensureReady();
    await this.reconcileStaleRuns();
    this.startHeartbeat();
  }

  dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // A process that is shutting down knows its own leases are dead. Releasing them here closes
    // the fast-restart hole SRC-161:W2-001 names: shutdown stops the terminal-event owner before
    // the runtime dies, so nothing writes a terminal outcome, and a lease that is still under
    // the two-minute stale window would otherwise be trusted by the next start forever. The
    // outcome is unknown, so the row becomes truthfully recoverable (`blocked`), never a
    // manufactured success or failure.
    try {
      const released = this.deps.repo.releaseRunningForHost(this.hostId, this.now(), "interrupted_by_shutdown");
      if (released > 0) this.log(`ZAICODE 队列在退出时释放了 ${released} 个 running 任务 -> blocked`);
    } catch (error) {
      this.log("ZAICODE 队列退出释放失败", error);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.deps.repo.heartbeat(this.hostId, this.now());
        // Bounded reaper on the heartbeat this service already owns: startup reconcile alone left a
        // crashed/ungraceful host's row `running` (and holding a concurrency slot) until the next
        // start, which never comes if the app stays up (SRC-161:W2-001). Same owner, same timer,
        // same method as startup -- no second scheduler and no second copy of the reaper.
        void this.reconcileStaleRuns().catch((error: unknown) => this.log("ZAICODE 队列回收失败", error));
      } catch (error) {
        this.log("ZAICODE 队列心跳写入失败", error);
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  async list(filter: ZaicodeJobListFilter = {}): Promise<ZaicodeJobListResult> {
    await this.deps.repo.ensureReady();
    return this.deps.repo.list(filter);
  }

  async get(jobId: string): Promise<ZaicodeJob | null> {
    await this.deps.repo.ensureReady();
    return this.deps.repo.get(jobId);
  }

  async create(input: ZaicodeJobCreateInput): Promise<ZaicodeJob> {
    await this.deps.repo.ensureReady();
    const job = this.buildJob(input);
    await this.deps.repo.create(job);
    this.emitChanged();
    // 子任务由 delegateToChild 显式 pump；这里只处理顶层入队。
    if (job.status === "queued" && !input.parentJobId) this.autoPump(job.workspaceKey);
    return job;
  }

  private buildJob(input: ZaicodeJobCreateInput, delegatedFromRunId?: string): ZaicodeJob {
    const now = this.now();
    const status = input.status ?? "queued";
    return zaicodeJobSchema.parse({
      id: `zaicode-job:${randomUUID()}`,
      workspaceKey: input.workspaceKey,
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
      agentId: input.agentId,
      title: input.title.trim(),
      instructions: input.instructions.trim(),
      status,
      priority: input.priority ?? 0,
      sortOrder: this.deps.repo.nextSortOrder(input.workspaceKey),
      createdAt: now,
      updatedAt: now,
      queuedAt: status === "queued" ? now : undefined,
      attempt: 0,
      parentJobId: input.parentJobId,
      retryOfJobId: input.retryOfJobId,
      delegatedFromRunId,
      // 只允许顶层任务带委托：子任务委托一律拒绝，深度恒为 1。
      delegation: input.parentJobId ? undefined : input.delegation,
    });
  }

  /**
   * T-243 / SRC-160:R003 — 委托子任务的唯一写路径：委托运行和"这一运行还剩几个 helper"
   * 的配额判定随行一起进同一条 SQL（见 ZaicodeJobRepo.createDelegatedChild）。
   * 返回 null 表示配额已满且没有行写入；调用方按 budget_exhausted 上报，绝不超发。
   */
  private async createDelegatedChild(
    input: ZaicodeJobCreateInput,
    delegatingRunId: string,
    maxPerRun: number,
  ): Promise<ZaicodeJob | null> {
    await this.deps.repo.ensureReady();
    const job = this.buildJob(input, delegatingRunId);
    if (!(await this.deps.repo.createDelegatedChild(job, maxPerRun))) return null;
    this.emitChanged();
    return job;
  }

  /**
   * 自动驾驶派发：不阻塞调用方（入队 / 回写立即返回），失败只记日志，
   * 队列事实仍以存储为准，操作员随时可手动 pump。
   */
  private autoPump(workspaceKey: string): void {
    void this.getAutoRun()
      .then((enabled) => (enabled ? this.pump(workspaceKey) : undefined))
      .catch((error: unknown) => this.log(`ZAICODE 自动派发失败: ${workspaceKey}`, error));
  }

  async getAutoRun(): Promise<boolean> {
    await this.deps.repo.ensureReady();
    return this.deps.repo.getSetting(AUTO_RUN_SETTING_KEY) !== "0";
  }

  async setAutoRun(enabled: boolean): Promise<boolean> {
    await this.deps.repo.ensureReady();
    this.deps.repo.setSetting(AUTO_RUN_SETTING_KEY, enabled ? "1" : "0", this.now());
    this.emitChanged();
    return enabled;
  }

  async update(jobId: string, patch: ZaicodeJobUpdatePatch): Promise<ZaicodeJob | null> {
    await this.deps.repo.ensureReady();
    const job = await this.deps.repo.updateEditable(jobId, patch, this.now());
    if (job) this.emitChanged();
    return job;
  }

  async reorder(jobId: string, direction: "up" | "down"): Promise<boolean> {
    await this.deps.repo.ensureReady();
    const applied = await this.deps.repo.swapOrder(jobId, direction, this.now());
    if (applied) this.emitChanged();
    return applied;
  }

  async dispatch(jobId: string): Promise<ZaicodeJob | null> {
    await this.deps.repo.ensureReady();
    const current = await this.deps.repo.get(jobId);
    if (!current) throw new Error(`ZAICODE 任务不存在: ${jobId}`);
    if (isZaicodeJobTerminal(current.status)) return current;

    const agent = await this.deps.getAgent(current.agentId);
    if (!agent || !agent.enabled) {
      return this.deps.repo.blockForDispatch(
        jobId,
        agent ? `agent_disabled: ${current.agentId}` : `agent_missing: ${current.agentId}`,
        this.now(),
      );
    }

    const runId = randomUUID();
    const claimed = await this.deps.repo.claimForDispatch({
      jobId,
      runId,
      hostId: this.hostId,
      now: this.now(),
    });
    if (!claimed) {
      // 已有派发者抢到或状态已变化：返回当前事实，不产生第二次执行。
      return this.deps.repo.get(jobId);
    }

    const executor = this.deps.getExecutor();
    if (!executor) {
      const blocked = await this.deps.repo.markBlocked({
        jobId,
        runId,
        attempt: claimed.attempt,
        error: "dispatch_unavailable: 当前 host 未装配 ZAICODE 执行器",
        now: this.now(),
      });
      this.emitChanged();
      return blocked;
    }

    try {
      const handle = await executor({ job: claimed, agent });
      // cancel 可先于执行器返回。先登记 stop，再检查持久队列，避免迟到的会话逃过取消。
      if (handle.stop) this.runningHandles.set(jobId, { runId, stop: handle.stop });
      const accepted = await this.deps.repo.get(jobId);
      if (accepted?.status === "cancelled" || accepted?.runId !== runId) {
        await handle.stop?.();
        this.runningHandles.delete(jobId);
        this.emitChanged();
        return accepted;
      }
      await this.deps.repo.attachSession({
        jobId,
        runId,
        sessionId: handle.sessionId,
        actualModelSelection: handle.actualModelSelection,
        now: this.now(),
      });
      this.emitChanged();
      return this.deps.repo.get(jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (await retainZaicodeCancellationFailure(this.deps.repo, this.runningHandles.has(jobId), jobId, message, this.now())) {
        this.emitChanged();
        return this.deps.repo.get(jobId);
      }
      await this.deps.repo.markTerminal({
        jobId,
        runId,
        attempt: claimed.attempt,
        status: "failed",
        error: `dispatch_failed: ${message}`,
        now: this.now(),
      });
      this.log(`ZAICODE 任务派发失败: ${jobId}`, error);
      this.emitChanged();
      return this.deps.repo.get(jobId);
    }
  }

  async pump(workspaceKey: string): Promise<ZaicodeJob[]> {
    await this.deps.repo.ensureReady();
    // A project the operator switched off is invisible to automatic work; its jobs wait.
    if (isZaicodeWorkspaceDisabled(await this.getDisabledWorkspaces(), workspaceKey)) return [];
    const limit = await this.getMaxConcurrency();
    const dispatched: ZaicodeJob[] = [];
    let guard = limit * 2 + 8;
    for (;;) {
      if (this.deps.repo.countRunning(workspaceKey) >= limit) break;
      if (guard-- <= 0) break;
      const [next] = this.deps.repo.listEligible(workspaceKey, 1);
      if (!next) break;
      const job = await this.dispatch(next.id);
      if (job?.status === "running") dispatched.push(job);
    }
    return dispatched;
  }

  async cancel(jobId: string): Promise<ZaicodeJob | null> {
    return cancelZaicodeJob({
      repo: this.deps.repo, handles: this.runningHandles, jobId,
      now: () => this.now(), emitChanged: () => this.emitChanged(), log: (message, error) => this.log(message, error),
    });
  }

  async retry(jobId: string): Promise<ZaicodeJob> {
    await this.deps.repo.ensureReady();
    const current = await this.deps.repo.get(jobId);
    if (!current) throw new Error(`ZAICODE 任务不存在: ${jobId}`);
    if ((current.status === "cancelled" && this.runningHandles.has(jobId)) || current.error?.startsWith("cancel_stop_failed:")) throw new Error("Retry cancellation before starting another attempt.");
    if (!isZaicodeJobTerminal(current.status) && current.status !== "blocked") {
      throw new Error(`仅终态或 blocked 任务可重试: ${current.status}`);
    }
    const created = await this.create({
      workspaceKey: current.workspaceKey,
      workspacePath: current.workspacePath,
      workspaceIdentity: current.workspaceIdentity,
      agentId: current.agentId,
      title: current.title,
      instructions: current.instructions,
      priority: current.priority,
      status: "queued",
      parentJobId: current.parentJobId,
      delegation: current.delegation,
      retryOfJobId: current.id,
    });
    return created;
  }

  async resume(jobId: string): Promise<ZaicodeJob | null> {
    await this.deps.repo.ensureReady();
    const job = await this.deps.repo.resumeBlocked(jobId, this.now());
    if (job && job.status === "queued") {
      this.emitChanged();
      this.autoPump(job.workspaceKey);
    }
    return job;
  }

  async remove(jobId: string): Promise<boolean> {
    await this.deps.repo.ensureReady();
    const current = await this.deps.repo.get(jobId);
    if (this.runningHandles.has(jobId) || current?.error?.startsWith("cancel_stop_failed:")) throw new Error("Retry cancellation before removing this task.");
    const removed = await this.deps.repo.remove(jobId);
    if (removed) {
      this.emitChanged();
    }
    return removed;
  }

  async reconcileStaleRuns(): Promise<number> {
    await this.deps.repo.ensureReady();
    const reclaimed = this.deps.repo.reclaimStaleRunning(this.now(), HEARTBEAT_STALE_MS);
    if (reclaimed > 0) {
      this.log(`ZAICODE 队列回收了 ${reclaimed} 个无心跳 running 任务 -> blocked`);
      this.emitChanged();
    }
    return reclaimed;
  }

  async getDisabledWorkspaces(): Promise<string[]> {
    await this.deps.repo.ensureReady();
    return normalizeZaicodeDisabledWorkspaces(this.deps.repo.getSetting(ZAICODE_DISABLED_WORKSPACES_SETTING_KEY));
  }

  async setWorkspaceDisabled(workspaceKey: string, disabled: boolean): Promise<string[]> {
    const next = setZaicodeWorkspaceDisabledIn(await this.getDisabledWorkspaces(), workspaceKey, disabled);
    this.deps.repo.setSetting(ZAICODE_DISABLED_WORKSPACES_SETTING_KEY, JSON.stringify(next), this.now());
    this.emitChanged();
    // Switching a project back on lets its waiting jobs run (when Autopilot is on).
    if (!disabled) this.autoPump(workspaceKey);
    return next;
  }

  async getMaxConcurrency(): Promise<number> {
    const raw = this.deps.repo.getSetting(MAX_CONCURRENCY_SETTING_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 1) return ZAICODE_JOB_CONCURRENCY_DEFAULT;
    return Math.min(parsed, ZAICODE_JOB_CONCURRENCY_MAX);
  }

  async setMaxConcurrency(value: number): Promise<number> {
    const clamped = Math.min(
      Math.max(Math.trunc(Number.isFinite(value) ? value : ZAICODE_JOB_CONCURRENCY_DEFAULT), 1),
      ZAICODE_JOB_CONCURRENCY_MAX,
    );
    this.deps.repo.setSetting(MAX_CONCURRENCY_SETTING_KEY, String(clamped), this.now());
    this.emitChanged();
    return clamped;
  }

  /**
   * 运行时终态回写。陈旧写入（run/attempt 不匹配）被拒绝；
   * 成功完成后，顶层 Coordinator 任务的有界委托在此入队一个子任务。
   */
  async reportRunOutcome(input: ZaicodeJobRunOutcomeInput): Promise<ZaicodeJob | null> {
    await this.deps.repo.ensureReady();
    const write = await this.deps.repo.markTerminal({
      jobId: input.jobId,
      runId: input.runId,
      attempt: input.attempt,
      status: mapTaskOutcomeToZaicodeJobStatus(input.outcome),
      resultSummary: input.resultSummary,
      error: input.error,
      now: this.now(),
    });
    if (write.stale) {
      this.log(
        `ZAICODE 队列忽略陈旧完成: job=${input.jobId} run=${input.runId} attempt=${input.attempt}`,
      );
    }
    if (!write.applied || !write.job) return write.job;
    this.runningHandles.delete(input.jobId);
    const job = write.job;
    if (job.status === "completed" && !job.parentJobId && job.delegation) {
      await this.delegateToChild(job);
    }
    if (job.parentJobId && isZaicodeJobTerminal(job.status)) {
      try {
        this.deps.onChildFinished?.(job);
      } catch (error) {
        this.log(`ZAICODE 子任务回执失败: child=${job.id}`, error);
      }
    }
    this.emitChanged();
    // 空出的并发位交给下一个排队任务。
    this.autoPump(job.workspaceKey);
    return job;
  }

  async getDelegationPolicy(): Promise<ZaicodeDelegationPolicy> {
    await this.deps.repo.ensureReady();
    return readZaicodeDelegationPolicy(this.deps.repo);
  }

  async setDelegationPolicy(policy: ZaicodeDelegationPolicy): Promise<ZaicodeDelegationPolicy> {
    await this.deps.repo.ensureReady();
    return writeZaicodeDelegationPolicy(this.deps.repo, policy, this.now());
  }

  /** 运行时委托（T-10）：裁决与创建见 zaicodeJobDelegation.ts；runId 即令牌。 */
  async delegateFromRun(input: { parentJobId: string; runId: string; request: unknown }): Promise<ZaicodeDelegationResult> {
    await this.deps.repo.ensureReady();
    return delegateZaicodeJobFromRun(
      {
        repo: this.deps.repo,
        getAgent: this.deps.getAgent,
        listAgents: this.deps.listAgents,
        createChild: (job, delegatingRunId, maxPerRun) =>
          this.createDelegatedChild(job, delegatingRunId, maxPerRun),
        pump: (workspaceKey) => this.pump(workspaceKey).then(() => undefined),
        now: () => this.now(),
      },
      input,
    );
  }

  /** 有界委托：创建一个子任务并经 pump 走真实队列/运行时路径；深度恒为 1。 */
  private async delegateToChild(parent: ZaicodeJob): Promise<void> {
    const delegation = parent.delegation;
    if (!delegation) return;
    try {
      await this.create({
        workspaceKey: parent.workspaceKey,
        workspacePath: parent.workspacePath,
        workspaceIdentity: parent.workspaceIdentity,
        agentId: delegation.targetAgentId,
        title: parent.title,
        instructions: delegation.instructions,
        priority: parent.priority,
        status: "queued",
        parentJobId: parent.id,
      });
      await this.pump(parent.workspaceKey);
    } catch (error) {
      this.log(`ZAICODE 委托子任务创建失败: parent=${parent.id}`, error);
    }
  }
}
