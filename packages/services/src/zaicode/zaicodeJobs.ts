import { ServiceChannels } from "@zcode/shared";
import type {
  ModelSelection,
  ZaicodeAgentDefinition,
  ZaicodeJob,
  ZaicodeJobCreateInput,
  ZaicodeJobListFilter,
  ZaicodeJobListResult,
  ZaicodeJobUpdatePatch,
  ZaicodeDelegationPolicy,
  ZaicodeDelegationRefusal,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// ZAICODE 任务队列服务通道：持久队列的 CRUD、原子派发、取消/重试/恢复与并发闸门。
// 执行真相在队列存储；UI 只是投影。会话生命周期归上游 task/session 运行时，
// 本服务只保存 sessionId 引用，不复制会话状态机。

/** 派发上下文：任务 + 当时的 agent 定义快照。 */
export interface ZaicodeJobExecutionRequest {
  job: ZaicodeJob;
  agent: ZaicodeAgentDefinition;
}

/** 派发结果：会话已受理即返回；终态稍后经 reportRunOutcome 回写。 */
export interface ZaicodeJobExecutionHandle {
  sessionId: string;
  /** 实际采用的模型选择（含运行时回退），用于区分展示配置值与实际值。 */
  actualModelSelection?: ModelSelection;
  /** 取消正在执行的会话（best-effort）；服务层 cancel 时调用。 */
  stop?: () => Promise<void>;
}

export type ZaicodeJobExecutor = (
  request: ZaicodeJobExecutionRequest,
) => Promise<ZaicodeJobExecutionHandle>;

export interface ZaicodeJobRunOutcomeInput {
  jobId: string;
  runId: string;
  attempt: number;
  outcome: "succeeded" | "failed" | "stopped";
  error?: string;
  resultSummary?: string;
}

export interface IZaicodeJobService {
  /** 按过滤条件列出任务；损坏的持久化行以 diagnostics 返回。 */
  list(filter?: ZaicodeJobListFilter): Promise<ZaicodeJobListResult>;
  get(jobId: string): Promise<ZaicodeJob | null>;
  /** 创建即入队（默认 queued；draft 表示尚未准入）；不自动派发。 */
  create(input: ZaicodeJobCreateInput): Promise<ZaicodeJob>;
  update(jobId: string, patch: ZaicodeJobUpdatePatch): Promise<ZaicodeJob | null>;
  reorder(jobId: string, direction: "up" | "down"): Promise<boolean>;
  /** 显式派发单个任务；重复派发返回当前状态，不产生第二次执行。 */
  dispatch(jobId: string): Promise<ZaicodeJob | null>;
  /** 按并发上限派发可执行任务，返回本次实际派发的任务。 */
  pump(workspaceKey: string): Promise<ZaicodeJob[]>;
  cancel(jobId: string): Promise<ZaicodeJob | null>;
  /** 重试产生带 retryOfJobId 血缘的新任务行；旧行保持终态。 */
  retry(jobId: string): Promise<ZaicodeJob>;
  /** blocked -> queued；随后可重新派发。 */
  resume(jobId: string): Promise<ZaicodeJob | null>;
  remove(jobId: string): Promise<boolean>;
  /** 回收无心跳的 running 行（进程崩溃/重启）；返回回收数量。 */
  reconcileStaleRuns(): Promise<number>;
  getMaxConcurrency(): Promise<number>;
  setMaxConcurrency(value: number): Promise<number>;
  /** 自动驾驶：开启时入队/完成/恢复后自动派发（默认开启）。 */
  getAutoRun(): Promise<boolean>;
  setAutoRun(enabled: boolean): Promise<boolean>;
  /** host 运行时终态回写；陈旧 run/attempt 写入被拒绝；成功后触发有界委托。 */
  reportRunOutcome(input: ZaicodeJobRunOutcomeInput): Promise<ZaicodeJob | null>;
  /** 运行时委托（T-10）：当前运行的 coordinator 请求 helper；策略拒绝时返回原因。 */
  delegateFromRun(input: {
    parentJobId: string;
    runId: string;
    request: unknown;
  }): Promise<
    | { ok: true; child: ZaicodeJob }
    | { ok: false; reason: ZaicodeDelegationRefusal; detail: string }
  >;
  getDelegationPolicy(): Promise<ZaicodeDelegationPolicy>;
  setDelegationPolicy(policy: ZaicodeDelegationPolicy): Promise<ZaicodeDelegationPolicy>;
  /** Projects switched off by the operator (Shift+Click): automatic dispatch skips them. */
  getDisabledWorkspaces(): Promise<string[]>;
  setWorkspaceDisabled(workspaceKey: string, disabled: boolean): Promise<string[]>;
}

export const IZaicodeJobService = createServiceDescriptor<IZaicodeJobService>(
  ServiceChannels.ZaicodeJobs,
);
