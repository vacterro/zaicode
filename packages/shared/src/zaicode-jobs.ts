import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

/**
 * ZAICODE 任务队列（handoff M7）契约与显式生命周期。
 *
 * 状态迁移是显式表而不是布尔位；终态不可逆出。运行状态的事实来源是队列存储，
 * UI 展示只是投影，不构成执行真相。任务行不复制会话状态机：sessionId 只做引用，
 * 会话生命周期仍归上游 session 运行时所有。
 */

export const ZAICODE_JOB_STATUSES = [
  "draft",
  "queued",
  "ready",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ZaicodeJobStatus = (typeof ZAICODE_JOB_STATUSES)[number];

export const zaicodeJobStatusSchema = z.enum(ZAICODE_JOB_STATUSES);

export const ZAICODE_JOB_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export type ZaicodeJobTerminalStatus = (typeof ZAICODE_JOB_TERMINAL_STATUSES)[number];

export function isZaicodeJobTerminal(status: ZaicodeJobStatus): boolean {
  return (ZAICODE_JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 显式迁移表；未列出的迁移一律拒绝，不做隐式兜底。 */
const ZAICODE_JOB_TRANSITIONS: Record<ZaicodeJobStatus, readonly ZaicodeJobStatus[]> = {
  draft: ["queued", "cancelled"],
  queued: ["ready", "running", "blocked", "cancelled"],
  ready: ["queued", "running", "blocked", "cancelled"],
  running: ["waiting", "blocked", "completed", "failed", "cancelled"],
  waiting: ["running", "blocked", "failed", "cancelled"],
  blocked: ["queued", "ready", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionZaicodeJob(from: ZaicodeJobStatus, to: ZaicodeJobStatus): boolean {
  return ZAICODE_JOB_TRANSITIONS[from].includes(to);
}

export function assertZaicodeJobTransition(from: ZaicodeJobStatus, to: ZaicodeJobStatus): void {
  if (!canTransitionZaicodeJob(from, to)) {
    throw new Error(`ZAICODE job 非法状态迁移: ${from} -> ${to}`);
  }
}

/** 上游一轮输入的终态到队列状态的唯一映射；未知结果不能当作成功。 */
export function mapTaskOutcomeToZaicodeJobStatus(
  outcome: "succeeded" | "failed" | "stopped",
): ZaicodeJobTerminalStatus {
  if (outcome === "succeeded") return "completed";
  if (outcome === "stopped") return "cancelled";
  return "failed";
}

export const ZAICODE_JOB_DEFAULT_PRIORITY = 0;

/** 保守且可配置的并发上限（handoff M9）；并发计数只来自存储，不来自 UI。 */
export const ZAICODE_JOB_CONCURRENCY_DEFAULT = 1;
export const ZAICODE_JOB_CONCURRENCY_MAX = 4;

/** 执行租约心跳：超过该时长无心跳的 running 行视为所属进程已死，启动时可回收。 */
export const ZAICODE_JOB_HEARTBEAT_STALE_MS = 2 * 60_000;

/** 编排探针的有界委托：只允许一跳，父任务完成后入队一个子任务。 */
export const zaicodeJobDelegationSchema = z
  .object({
    targetAgentId: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
  })
  .strict();

export type ZaicodeJobDelegation = z.infer<typeof zaicodeJobDelegationSchema>;

export const zaicodeJobSchema = z
  .object({
    id: z.string().trim().min(1),
    workspaceKey: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1),
    title: z.string(),
    instructions: z.string().trim().min(1),
    status: zaicodeJobStatusSchema,
    priority: z.number().int(),
    sortOrder: z.number().int(),
    createdAt: z.number(),
    updatedAt: z.number(),
    queuedAt: z.number().optional(),
    startedAt: z.number().optional(),
    finishedAt: z.number().optional(),
    resultSummary: z.string().optional(),
    error: z.string().optional(),
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    attempt: z.number().int().nonnegative(),
    /** 持有当前 running 执行租约的 host 实例；用于重启回收与陈旧判定。 */
    hostId: z.string().trim().min(1).optional(),
    heartbeatAt: z.number().optional(),
    parentJobId: z.string().trim().min(1).optional(),
    retryOfJobId: z.string().trim().min(1).optional(),
    delegation: zaicodeJobDelegationSchema.optional(),
    actualModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ZaicodeJob = z.infer<typeof zaicodeJobSchema>;

export interface ZaicodeJobCreateInput {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  agentId: string;
  title: string;
  instructions: string;
  priority?: number;
  /** 直接入队（默认）或先存草稿。 */
  status?: Extract<ZaicodeJobStatus, "draft" | "queued">;
  /** 编排探针：子任务记录父任务 id；不实现递归派生。 */
  parentJobId?: string;
  /** 仅顶层 Coordinator 任务可带委托；服务端对子任务拒绝该字段。 */
  delegation?: ZaicodeJobDelegation;
  /** 重试血缘：指向被重试的原任务行。 */
  retryOfJobId?: string;
}

export interface ZaicodeJobUpdatePatch {
  title?: string;
  instructions?: string;
  priority?: number;
}

export interface ZaicodeJobListFilter {
  workspaceKey?: string;
  status?: ZaicodeJobStatus;
  agentId?: string;
}

/** 损坏/不可解释的持久化任务行：保留诊断，不当作正常任务使用。 */
export interface ZaicodeJobDiagnostic {
  jobId?: string;
  code: "invalid-job";
  message: string;
}

export interface ZaicodeJobListResult {
  jobs: ZaicodeJob[];
  diagnostics: ZaicodeJobDiagnostic[];
}

/**
 * Hit and go (SRC-038): an agent's task that is empty runs this -- continue
 * the SAIPEN board until only human work is left.
 */
export const ZAICODE_HIT_AND_GO_PROMPT = "/goal cc all";

/** Bare SAIPEN shortcuts (and their Cyrillic twins) that are commands, not task text. */
const ZAICODE_BARE_SHORTCUTS = new Set([
  "cc", "ccc", "сс", "ссс", "sss", "st", "tt", "hh", "aa", "аа", "zz", "gg", "ff", "xx", "vv", "qq", "qqq",
  "ee", "еее", "ее", "pp", "рр", "хх", "dd", "sc", "saipen", "saipen continue",
  "saiwiki", "saitranslate", "saitest", "saihunt", "saipen clean", "saipen crew",
]);

/**
 * Whether a task text is a command the runtime or SAIPEN runs as is (a slash
 * command such as `/goal cc all`, or a bare shortcut such as `cc`). Such a
 * text must reach the agent alone and first: wrapped in a persona paragraph a
 * slash command is plain prose, and SAIPEN's operator template would file it
 * as a brand-new ticket.
 */
export function isZaicodeRawCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  return ZAICODE_BARE_SHORTCUTS.has(trimmed.toLowerCase());
}

/** The text an agent is given: its task, or hit-and-go when the task is empty. */
export function zaicodeJobTaskText(instructions: string): string {
  return instructions.trim() || ZAICODE_HIT_AND_GO_PROMPT;
}
