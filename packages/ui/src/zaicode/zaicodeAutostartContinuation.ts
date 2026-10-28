import { completeNewModelSelection } from "@zcode/provider";
import { createUuid, decideZaicodeContinuation, markZaicodeContinuationLimit, zaicodeScheduleStopAt, type ZaicodeContinuingJob, type ZaicodeContinuationRun } from "@zcode/shared";
import { readZaicodeEnginesState, refreshZaicodeEngineLimits } from "./zaicodeEngines.js";
import { launchZaicodeWorker, readZaicodeWorkers, removeZaicodeWorker, type ZaicodeWorker } from "./zaicodeWorkers.js";
import { useZaicodeSessionBriefs, type ZaicodeSessionBrief } from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import { zaicodeCommandForPrompt } from "./zaicodeScheduleRun.js";
import { isZaicodeProjectDisabled } from "./zaicodeProjectSwitch.js";
import type { ZaicodeServices } from "./zaicodeServices.js";
import { readZaicodeKnownProjects, zaicodeScheduleTargets, type ZaicodeKnownProject } from "./zaicodeScheduler.js";
import type { ZaicodeWorkerLimitSignal } from "./zaicodeWorkerSignals.js";
import { resolveZaicodeDefaultSelection } from "./zaicodeDefaultModel.js";
import { terminalControl } from "@/terminal/terminalOutputTap.js";
import { useZaicodeMainSessions, zaicodeMainSessionIdOf, zaicodeMainSessionKey } from "./zaicodeMainSession.js";
import { pickZaicodeSchedulerEligibleAccounts } from "./zaicodeSchedulerEligibility.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { useZaicodeSidebarPrefs } from "./zaicodeSidebarPrefs.js";

const QUOTA_REFRESH_MS = 30_000;
const RETRY_MS = 15_000;
const pending = new Set<string>();
let lastQuotaRefreshAt = 0;

export interface ZaicodeContinuationStore {
  read: () => ZaicodeContinuingJob[];
  update: (id: string, patch: Partial<ZaicodeContinuingJob>) => void;
  services: () => ZaicodeServices | null;
  canDispatch?: () => boolean;
}

const liveRuntime = {
  engines: () => {
    const engines = readZaicodeEnginesState();
    return { ...engines, accounts: pickZaicodeSchedulerEligibleAccounts(engines.accounts, useZaicodeUiPrefs.getState()) };
  },
  refresh: refreshZaicodeEngineLimits,
  workers: readZaicodeWorkers,
  launch: launchZaicodeWorker,
  remove: removeZaicodeWorker,
  sessions: () => useZaicodeSessionBriefs.getState().sessions,
  handle: zaicodeContinueHandleFor,
  disabled: isZaicodeProjectDisabled,
  terminal: terminalControl,
  main: (target: { path: string; identity?: string }) => zaicodeMainSessionIdOf(useZaicodeMainSessions.getState().byWorkspace, zaicodeMainSessionKey(target.path, target.identity)),
  setMain: (target: { path: string; identity?: string }, sessionId: string) => useZaicodeMainSessions.getState().setMain(zaicodeMainSessionKey(target.path, target.identity), sessionId),
  targets: (job: ZaicodeContinuingJob) => {
    const prefs = useZaicodeSidebarPrefs.getState();
    return zaicodeScheduleTargets(job, readZaicodeKnownProjects(), prefs.groups, prefs.defaultSlot);
  },
};
export type ZaicodeContinuationRuntime = Omit<typeof liveRuntime, "targets"> & Partial<Pick<typeof liveRuntime, "targets">>;

function dispatchConfiguration(job: ZaicodeContinuingJob): string {
  return JSON.stringify([job.engineId, job.prompt, job.targetKind, job.projectPath, job.section, job.onlyMarked, job.onlyWhenIdle, job.beforeRun, job.continuation]);
}

function targetSelected(job: ZaicodeContinuingJob, run: ZaicodeContinuationRun, runtime: ZaicodeContinuationRuntime): boolean {
  return runtime.targets
    ? runtime.targets(job).some((target) => target.path.toLowerCase() === run.projectPath.toLowerCase() && (target.identity ?? "") === (run.workspaceIdentity ?? ""))
    : job.targetKind !== "project" || job.projectPath.toLowerCase() === run.projectPath.toLowerCase();
}

function persist(store: ZaicodeContinuationStore, jobId: string, run: ZaicodeContinuationRun): void {
  const job = store.read().find((value) => value.id === jobId);
  if (!job) throw new Error("Schedule removed before dispatch");
  store.update(jobId, { continuationRuns: job.continuationRuns.map((value) => value.workspaceKey === run.workspaceKey && value.occurrence === run.occurrence ? run : value), lastResult: run.result });
}

export function beginZaicodeContinuation(job: ZaicodeContinuingJob, targets: readonly ZaicodeKnownProject[], occurrence: string, now: number): ZaicodeContinuationRun[] {
  const active = job.continuationRuns.filter((run) => !["complete", "stopped"].includes(run.state));
  const terminal = job.continuationRuns.filter((run) => ["complete", "stopped"].includes(run.state)).slice(-32);
  const existing = [...terminal, ...active];
  return [...existing, ...targets.filter((target) => !existing.some((run) => run.workspaceKey === target.key && (run.occurrence === occurrence || !["complete", "stopped"].includes(run.state)))).slice(0, Math.max(0, 128 - existing.length)).map((target): ZaicodeContinuationRun => ({ workspaceKey: target.key, projectPath: target.path, ...(target.identity ? { workspaceIdentity: target.identity } : {}), occurrence, runnerId: job.engineId, lease: createUuid(), state: "pending", blocked: [], nextAt: now, launchedAt: now, startedAt: now, result: "Pending eligible runner" }))];
}

/** Persist the limit before stopping anything. Exact worker identity and generation own this transition. */
export function recordZaicodeContinuationWorkerLimit(store: ZaicodeContinuationStore, worker: ZaicodeWorker, signal: ZaicodeWorkerLimitSignal, now = Date.now()): boolean {
  for (const job of store.read()) {
    const run = job.continuationRuns.find((value) => value.workerId === worker.id && value.generation === worker.generation && value.runnerId === worker.accountId && value.state === "running");
    if (!run || !job.continuation.enabled) continue;
    persist(store, job.id, markZaicodeContinuationLimit(run, signal, now, job.continuation.delayMinutes));
    return true;
  }
  return false;
}

function currentSession(run: ZaicodeContinuationRun, runtime: ZaicodeContinuationRuntime): ZaicodeSessionBrief | undefined {
  // canonical MAIN 指针跨 worker 保留，但旧会话快照不能冒充当前订阅执行的状态。
  if (!run.runnerId.startsWith("pool:")) return undefined;
  return runtime.sessions().find((session) => session.sessionId === run.sessionId && session.projectKey === run.workspaceKey);
}

async function stopOwned(run: ZaicodeContinuationRun, runtime: ZaicodeContinuationRuntime): Promise<void> {
  if (run.workerId) {
    const worker = runtime.workers().workers.find((value) => value.id === run.workerId);
    if (worker && worker.exitCode === null) {
      if (worker.generation !== run.generation || worker.accountId !== run.runnerId) throw new Error("Worker lease changed; stop refused");
      runtime.remove(worker.id, "schedule");
    }
  }
  if (run.sessionId) {
    const session = currentSession(run, runtime);
    if (session?.running) {
      if (!run.foregroundExecutionId || session.foregroundExecutionId !== run.foregroundExecutionId) throw new Error("Session execution changed; stop refused");
      const handle = runtime.handle({ key: run.workspaceKey, path: run.projectPath, identity: run.workspaceIdentity });
      if (!handle) throw new Error("Project is not connected");
      await handle.stop(run.sessionId, run.foregroundExecutionId);
    }
  }
}

/** One serialized target lane. Replay carries the same terminal/command lease, never a second launch. */
export async function tickZaicodeContinuations(store: ZaicodeContinuationStore, autopilot: boolean, now = Date.now(), runtime: ZaicodeContinuationRuntime = liveRuntime): Promise<void> {
  const jobs = store.read();
  if (!jobs.some((job) => job.continuationRuns.some((run) => !["complete", "stopped"].includes(run.state)))) return;
  if (autopilot && now - lastQuotaRefreshAt >= QUOTA_REFRESH_MS) {
    lastQuotaRefreshAt = now;
    await runtime.refresh().catch(() => undefined);
  }
  const view = await store.services()?.modelSelection.getView().catch(() => undefined);
  const selections = new Map<string, NonNullable<ReturnType<typeof completeNewModelSelection>>>();
  for (const provider of view?.providers ?? []) {
    for (const model of provider.models) {
      const selection = completeNewModelSelection(view!, { providerId: provider.providerId, modelId: model.modelId });
      if (selection) selections.set(`pool:${provider.providerId}/${model.modelId}`, selection);
    }
  }
  if (view) {
    const defaultSelection = resolveZaicodeDefaultSelection(view);
    if (defaultSelection) selections.set("pool:start", defaultSelection);
  }
  for (const initialJob of jobs) for (const initialRun of initialJob.continuationRuns) {
    if (["complete", "stopped"].includes(initialRun.state)) continue;
    const key = `${initialJob.id}/${initialRun.workspaceKey}/${initialRun.occurrence}`;
    if (pending.has(key)) continue;
    pending.add(key);
    let run = initialRun;
    try {
      const job = store.read().find((value) => value.id === initialJob.id);
      if (!job) continue;
      const configuration = dispatchConfiguration(job);
      const current = job.continuationRuns.find((value) => value.workspaceKey === initialRun.workspaceKey && value.occurrence === initialRun.occurrence);
      if (!current) continue;
      run = current;
      const worker = run.workerId ? runtime.workers().workers.find((value) => value.id === run.workerId) : undefined;
      const session = run.sessionId ? currentSession(run, runtime) : undefined;
      if (worker && (worker.accountId !== run.runnerId || worker.projectPath.toLowerCase() !== run.projectPath.toLowerCase())) throw new Error("Worker belongs to another schedule scope");
      if (worker && worker.accountId === run.runnerId && worker.generation !== run.generation) {
        run = { ...run, generation: worker.generation };
        persist(store, job.id, run);
      }
      if (session?.running && !run.foregroundExecutionId && session.foregroundExecutionId && (session.foregroundStartedAt ?? 0) >= run.launchedAt) {
        run = { ...run, foregroundExecutionId: session.foregroundExecutionId };
        persist(store, job.id, run);
      }
      if (run.state === "running" && (worker?.exitCode === 0 || (session && !session.running && !session.failed && !session.interrupted && !session.waiting && session.goalStatus !== "active"))) {
        persist(store, job.id, { ...run, state: "complete", result: "Scheduled work completed" });
        continue;
      }
      if (run.state === "running" && (session?.manuallyStopped || (session?.foregroundExecutionId && run.foregroundExecutionId && session.foregroundExecutionId !== run.foregroundExecutionId))) {
        persist(store, job.id, { ...run, state: "stopped", result: "Session stopped or taken over" });
        continue;
      }
      if (run.state === "running" && ((worker && worker.exitCode !== null) || session?.failed)) {
        persist(store, job.id, { ...run, state: "stopped", result: "Run failed; no subscription-limit evidence" });
        continue;
      }
      const selectedTarget = targetSelected(job, run, runtime);
      if (!selectedTarget && run.state !== "running") {
        await stopOwned(run, runtime);
        persist(store, job.id, { ...run, state: "stopped", result: "Project is no longer a schedule target" });
        continue;
      }
      const stopAt = zaicodeScheduleStopAt(job.stopAt, run.startedAt ?? run.launchedAt);
      if (run.state === "running" && !run.workerId && run.sessionId && !session && !(stopAt !== null && now >= stopAt)) continue;
      if (run.state === "running" && run.workerId && !worker && !(stopAt !== null && now >= stopAt)) {
        // 进程丢失只能重放已持久化的终端 lease；仍有 PTY 控制权时不得双启。
        if (run.workerId !== `zaicode-worker:${run.lease}` || runtime.terminal(run.workerId)) continue;
        run = { ...run, state: "failed", nextAt: now, result: "Recovering the owned worker after restart" };
        persist(store, job.id, run);
      }
      const engines = runtime.engines();
      const decision = decideZaicodeContinuation({ job, run, accounts: engines.accounts, limits: engines.limits, availablePools: new Set(selections.keys()), now, autopilot: autopilot && (store.canDispatch?.() ?? true), enabled: job.enabled, projectDisabled: runtime.disabled(run.workspaceKey) || !selectedTarget, stopDue: stopAt !== null && now >= stopAt });
      if (decision.action === "none" || decision.action === "wait") continue;
      if (decision.action === "arm-return" || decision.action === "cancel-return") {
        persist(store, job.id, { ...run, preferredReadyAt: decision.action === "arm-return" ? decision.at : undefined });
        continue;
      }
      if (decision.action === "stop") {
        await stopOwned(run, runtime);
        persist(store, job.id, { ...run, state: "stopped", result: decision.reason });
        continue;
      }
      if (!("runnerId" in decision)) continue;
      if (job.onlyMarked || job.engineId.startsWith("agent:")) throw new Error("Continuation requires a project runner, without marked-session-only mode");
      if (decision.action === "switch") await stopOwned(run, runtime);
      const admitted = store.read().find((value) => value.id === job.id);
      if (!admitted?.enabled || !admitted.continuation.enabled || !(store.canDispatch?.() ?? true) || runtime.disabled(run.workspaceKey)) continue;
      if (dispatchConfiguration(admitted) !== configuration) continue;
      const sameLease = run.state === "launching" || (run.state === "failed" && run.runnerId === decision.runnerId);
      const generation = sameLease && run.generation ? run.generation + 1 : undefined;
      // 模型/worker lease 替换不能丢掉 canonical MAIN 会话身份。
      run = { ...run, runnerId: decision.runnerId, lease: sameLease ? run.lease : createUuid(), state: "launching", workerId: undefined, generation: undefined, sessionId: run.sessionId, foregroundExecutionId: undefined, preferredReadyAt: undefined, launchedAt: sameLease ? run.launchedAt : now, result: "Launching selected runner" };
      persist(store, job.id, run);
      const canDispatch = () => {
        const latest = store.read().find((value) => value.id === job.id);
        const owned = latest?.continuationRuns.find((value) => value.workspaceKey === run.workspaceKey && value.occurrence === run.occurrence);
        // 提示文件/会话准备跨过停止时刻后，必须在真正派发前重新验证最新停止规则。
        const deadline = latest ? zaicodeScheduleStopAt(latest.stopAt, run.startedAt ?? run.launchedAt) : null;
        const accountEligible = run.runnerId.startsWith("pool:") || runtime.engines().accounts.some((account) => account.id === run.runnerId && account.status === "ready" && account.cli);
        return Boolean(latest?.enabled && latest.continuation.enabled && dispatchConfiguration(latest) === configuration && targetSelected(latest, run, runtime) && accountEligible && !latest.onlyMarked && owned?.lease === run.lease && owned.state === "launching" && (deadline === null || Date.now() < deadline) && (store.canDispatch?.() ?? true) && !runtime.disabled(run.workspaceKey));
      };
      if (decision.runnerId.startsWith("pool:")) {
        const target = { key: run.workspaceKey, path: run.projectPath, identity: run.workspaceIdentity };
        const handle = runtime.handle(target);
        const modelSelection = selections.get(decision.runnerId);
        if (!handle || !modelSelection) throw new Error("Selected in-app model or project is unavailable");
        const mainId = runtime.main(target);
        if (!run.sessionId && mainId) {
          const main = runtime.sessions().find((value) => value.sessionId === mainId && value.projectKey === run.workspaceKey);
          if (!main || main.running) throw new Error("Project MAIN is busy or its state is unavailable");
          run = { ...run, sessionId: mainId };
          persist(store, job.id, run);
        }
        const options = { modelSelection, commandId: run.lease, canDispatch, onCreated: (sessionId: string) => { if (!canDispatch()) throw new Error("Scheduled dispatch was cancelled"); run = { ...run, sessionId }; persist(store, job.id, run); runtime.setMain(target, sessionId); } };
        if (run.sessionId) await handle.send(run.sessionId, zaicodeCommandForPrompt(job.prompt), options);
        else await handle.start(zaicodeCommandForPrompt(job.prompt), options);
      } else {
        const account = engines.accounts.find((value) => value.id === decision.runnerId)!;
        run = { ...run, workerId: `zaicode-worker:${run.lease}` };
        persist(store, job.id, run);
        const launched = await runtime.launch({ account, projectPath: run.projectPath, prompt: job.prompt.trim() || "/goal cc all", workerId: run.workerId, generation, canDispatch });
        if (!launched.ok || !launched.worker) throw new Error(launched.message);
        run = { ...run, generation: launched.worker.generation };
      }
      const acknowledged = store.read().find((value) => value.id === job.id)?.continuationRuns.find((value) => value.workspaceKey === run.workspaceKey && value.occurrence === run.occurrence);
      // 异步启动确认只更新自己的活 lease，不能复活已停止/删除的任务或覆盖更新后的状态。
      if (!acknowledged || acknowledged.lease !== run.lease || ["complete", "stopped"].includes(acknowledged.state)) {
        await stopOwned(run, runtime);
        continue;
      }
      if (acknowledged.state !== "launching") continue;
      persist(store, job.id, { ...run, state: "running", result: `Continuing on ${run.runnerId}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = store.read().find((value) => value.id === initialJob.id)?.continuationRuns.find((value) => value.workspaceKey === run.workspaceKey && value.occurrence === run.occurrence);
      if (latest && !["complete", "stopped"].includes(latest.state) && latest.lease === run.lease) persist(store, initialJob.id, { ...run, state: run.state === "launching" ? "failed" : run.state, nextAt: now + RETRY_MS, result: message });
    } finally { pending.delete(key); }
  }
}
