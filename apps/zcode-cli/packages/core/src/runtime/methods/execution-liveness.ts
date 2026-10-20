import { EXECUTION_LIVENESS_TTL_MS, type ExecutionLivenessSnapshot, type ExecutionWorkLease } from "@zcode/shared";
import { SessionEventType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { isTerminalRuntimeTask, type RuntimeTaskSnapshot } from "../../runtime-task/registry.js";

const owners = new WeakMap<AgentRuntimeInternal, string>();

function statusOf(task: RuntimeTaskSnapshot): ExecutionWorkLease["status"] {
  if (task.status === "running" || task.status === "completed" || task.status === "failed") return task.status;
  if (task.status === "lost") return "orphaned";
  return "cancelled";
}

/** Observes only current requested work; never scans or deserializes session history. */
export async function getExecutionLiveness(
  this: AgentRuntimeInternal,
  workIds: readonly string[],
): Promise<ExecutionLivenessSnapshot> {
  let ownerId = owners.get(this);
  if (!ownerId) { ownerId = crypto.randomUUID(); owners.set(this, ownerId); }
  const ids = [...new Set(workIds)];
  const unknown = new Set<string>();
  await Promise.all(ids.map(async (id) => {
    const task = this.runtimeTaskRegistry.get(id);
    if (this.shuttingDown || !task || isTerminalRuntimeTask(task) || task.livenessSource === "poll") return;
    if (task.livenessSource === "waiter") {
      this.runtimeTaskRegistry.update(id, (current) => current === task ? { ...current, lastConfirmedAt: this.now().getTime() } : current);
      return;
    }
    // SendMessage 恢复的子任务未必经过 tool tracker；复用实际端口，不能凭缓存 running 续租。
    const read = task.type === "local_agent" && this.subagentPort?.getTask
      ? () => this.subagentPort!.getTask!(id)
      : task.type === "local_dynamic_workflow" && this.dynamicWorkflowRunPort
        ? () => this.dynamicWorkflowRunPort!.getTask(id)
        : task.type === "local_bash" && this.executionPort?.getBackgroundTask
          ? () => this.executionPort!.getBackgroundTask!(id)
          : null;
    if (!read) { unknown.add(id); return; }
    let snapshot: Awaited<ReturnType<typeof read>>;
    try { snapshot = await read(); } catch {
      // 查询失败只代表未知，不代表退出；旧租约仍按最后一次真实确认到期。
      unknown.add(id);
      return;
    }
    if (this.shuttingDown || this.runtimeTaskRegistry.get(id) !== task) return;
    const status = !snapshot ? "lost" : snapshot.status === "timed_out" ? "killed" :
      snapshot.status === "spawn_error" ? "failed" : snapshot.status;
    const confirmedAt = this.now().getTime();
    const terminal = status !== "running";
    this.runtimeTaskRegistry.update(id, () => ({
      ...task, status, lastConfirmedAt: confirmedAt,
      ...(terminal ? { completedAt: snapshot?.completedAt ?? new Date(confirmedAt) } : {}),
    }));
    if (terminal) {
      // 恢复路径也走既有终态事件；只改 registry 会让持久投影永远保留 running。
      const event = this.createEvent(SessionEventType.BackgroundTaskCompleted, {
        taskId: id, status, toolCallId: task.parentToolCallId,
        taskKind: task.type === "local_agent" ? "subagent" : task.type === "local_dynamic_workflow" ? "workflow" : "bash",
        description: task.description, completedAt: snapshot?.completedAt ?? new Date(confirmedAt),
      }, task.traceContext ?? this.rootTraceContext);
      event.turnId = task.turnId;
      await this.appendEvent(event, task.traceContext ?? this.rootTraceContext);
    }
  }));
  const observedAt = this.now().getTime();
  const background = ids.map((id): ExecutionWorkLease => {
    const task = this.runtimeTaskRegistry.get(id);
    if (!task || this.shuttingDown) return { workId: id, status: "orphaned", confirmedAt: null };
    const confirmedAt = task.lastConfirmedAt ?? null;
    const stale = task.status === "running" && (unknown.has(id) || confirmedAt === null || observedAt - confirmedAt > EXECUTION_LIVENESS_TTL_MS);
    return { workId: id, status: stale ? "unconfirmed" : statusOf(task), confirmedAt, ...(task.pid ? { pid: task.pid } : {}) };
  });
  const foregroundExecutionId = this.shuttingDown ? undefined : this.getActiveForegroundExecutionId();
  return {
    ownerId, released: this.shuttingDown, observedAt, validUntil: observedAt + EXECUTION_LIVENESS_TTL_MS,
    ...(foregroundExecutionId ? { foregroundExecutionId } : {}), background,
    orphaned: background.some((work) => work.status === "orphaned"),
    unconfirmed: background.some((work) => work.status === "unconfirmed"),
  };
}
