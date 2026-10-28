import type {
  ZaicodeAgentDefinition,
  ZaicodeJob,
  ZaicodeJobStatus,
  ZaicodeRouteBackend,
  ZaicodeRoutePlan,
} from "@zcode/shared";

/** ZAICODE 状态词汇（UI.md）：每个展示状态都对到权威运行时状态，不凭 UI 猜测。 */
export type ZaicodeAgentDisplayStatus = "offline" | "idle" | "running" | "blocked";

export function jobStatusLabelId(status: ZaicodeJobStatus): string {
  return `zaicode.status.${status}`;
}

export function routeBackendLabelId(backend: ZaicodeRouteBackend): string {
  return `zaicode.backend.${backend}`;
}

export function routePlanStatusMessageId(plan: ZaicodeRoutePlan): string {
  if (plan.fallbackReason === "selection-missing") return "zaicode.route.directNeedsSelection";
  return "zaicode.route.directReady";
}

export function jobStatusBadgeVariant(
  status: ZaicodeJobStatus,
): "default" | "secondary" | "destructive" | "outline" | "ghost" {
  switch (status) {
    case "running":
      return "default";
    case "queued":
    case "ready":
    case "waiting":
      return "secondary";
    case "failed":
    case "blocked":
      return "destructive";
    case "completed":
      return "outline";
    case "draft":
    case "cancelled":
    default:
      return "ghost";
  }
}

/** 队列仍会继续处理的非终态集合。 */
export function isJobActive(status: ZaicodeJobStatus): boolean {
  return (
    status === "draft" ||
    status === "queued" ||
    status === "ready" ||
    status === "running" ||
    status === "waiting" ||
    status === "blocked"
  );
}

/** 展示状态只由 agent.enabled 与真实任务状态派生；blocked 只看非终态任务。 */
export function deriveAgentDisplayStatus(
  agent: ZaicodeAgentDefinition,
  jobs: readonly ZaicodeJob[],
): ZaicodeAgentDisplayStatus {
  if (!agent.enabled) return "offline";
  const agentJobs = jobs.filter((job) => job.agentId === agent.id);
  if (agentJobs.some((job) => job.status === "running")) return "running";
  if (agentJobs.some((job) => job.status === "blocked")) return "blocked";
  return "idle";
}

export function agentDisplayStatusLabelId(status: ZaicodeAgentDisplayStatus): string {
  return `zaicode.agentStatus.${status}`;
}

/** 展示排序：活跃任务在前，其后按 priority ↓ / sort_order ↑ / created_at ↑，与派发顺序一致。 */
export function sortJobsForDisplay(jobs: readonly ZaicodeJob[]): ZaicodeJob[] {
  return [...jobs].sort((left, right) => {
    const activeDelta = Number(isJobActive(right.status)) - Number(isJobActive(left.status));
    if (activeDelta !== 0) return activeDelta;
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return left.createdAt - right.createdAt;
  });
}

/** 运行中任务数只来自存储投影，不作为并发闸门的判据。 */
export function countRunningJobs(jobs: readonly ZaicodeJob[]): number {
  return jobs.filter((job) => job.status === "running").length;
}

/** 队列筛选的四个人话分组：替代九个原始状态按钮。 */
export type ZaicodeJobGroup = "active" | "attention" | "done";

export function jobStatusGroup(status: ZaicodeJobStatus): ZaicodeJobGroup {
  switch (status) {
    case "blocked":
    case "failed":
      return "attention";
    case "completed":
    case "cancelled":
      return "done";
    default:
      return "active";
  }
}

/** 每个状态只有一个主操作，其余操作收进行悬停菜单。 */
export type ZaicodeJobPrimaryAction = "run" | "stop" | "retry" | "resume" | null;

export function jobPrimaryAction(status: ZaicodeJobStatus): ZaicodeJobPrimaryAction {
  switch (status) {
    case "draft":
    case "queued":
    case "ready":
      return "run";
    case "running":
    case "waiting":
      return "stop";
    case "blocked":
      return "resume";
    case "failed":
    case "cancelled":
      return "retry";
    default:
      return null;
  }
}

export function jobStatusHelpId(status: ZaicodeJobStatus): string {
  return `zaicode.statusHelp.${status}`;
}
