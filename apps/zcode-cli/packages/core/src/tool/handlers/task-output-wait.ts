// TaskOutput 的阻塞等待循环与 ZAICODE 等待策略（T-136）。
import { stat } from "node:fs/promises";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { ToolExecutionContext } from "../types.js";
import { throwIfAborted } from "./task-output-projection.js";

const TASK_OUTPUT_POLL_INTERVAL_MS = 100;
const OUTPUT_SIZE_CHECK_INTERVAL_MS = 1_000;

export const ZAICODE_TASK_OUTPUT_MAX_WAIT_MS = 120_000;
export const ZAICODE_TASK_OUTPUT_SILENCE_MS = 60_000;

/**
 * ZAICODE (T-136 / SRC-100): "Task output exec_... Wait timed out" hung a chat for up to 15
 * minutes. The agent had started a shell command in the background and waited for it with one
 * TaskOutput call of up to 10 minutes, then another. The agent is told by a <task-notification>
 * when the command ends, so in ZAICODE one wait is capped and also ends when the command has
 * written nothing for a while (it may be waiting for input or be hung); the result says so.
 */
export interface TaskOutputWaitPolicy {
  /** Longest single wait, whatever the model asked for. */
  maxWaitMs: number;
  /** A background shell with no new output for this long ends the wait; 0 = never. */
  silenceMs: number;
  /** Tell the model what a timed-out wait means and what to do next. */
  guidance: boolean;
}

const UNLIMITED_POLICY: TaskOutputWaitPolicy = {
  maxWaitMs: Number.POSITIVE_INFINITY,
  silenceMs: 0,
  guidance: false,
};

function positiveMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveTaskOutputWaitPolicy(
  env: NodeJS.ProcessEnv = process.env,
): TaskOutputWaitPolicy {
  const zaicode = ["1", "true", "on", "yes"].includes(
    (env.ZCODE_ZAICODE_MODE ?? "").trim().toLowerCase(),
  );
  if (!zaicode) return UNLIMITED_POLICY;
  const maxWaitMs = positiveMs(env.ZAICODE_TASK_OUTPUT_MAX_WAIT_MS, ZAICODE_TASK_OUTPUT_MAX_WAIT_MS);
  return {
    maxWaitMs: maxWaitMs === 0 ? Number.POSITIVE_INFINITY : maxWaitMs,
    silenceMs: positiveMs(env.ZAICODE_TASK_OUTPUT_SILENCE_MS, ZAICODE_TASK_OUTPUT_SILENCE_MS),
    guidance: true,
  };
}

export interface TaskOutputWaitResult {
  task: RuntimeTaskSnapshot | undefined;
  waitedMs: number;
  /** Set when the wait ended because the background shell wrote nothing for this long. */
  silentForMs?: number;
}

export const isTaskActive = (status: string): boolean =>
  status === "running" || status === "pending";

async function outputFileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function waitForTask(
  taskId: string,
  timeoutMs: number,
  context: ToolExecutionContext,
  policy: TaskOutputWaitPolicy = resolveTaskOutputWaitPolicy(),
  now: () => number = Date.now,
): Promise<TaskOutputWaitResult> {
  const startedAt = now();
  const limitMs = Math.min(timeoutMs, policy.maxWaitMs);
  let lastSize: number | null = null;
  let lastGrowthAt = startedAt;
  let lastSizeCheckAt = Number.NEGATIVE_INFINITY;
  while (now() - startedAt < limitMs) {
    throwIfAborted(context.abortSignal);
    const task = context.runtimeTaskRegistry?.get(taskId);
    if (!task) return { task: undefined, waitedMs: now() - startedAt };
    if (!isTaskActive(task.status)) return { task, waitedMs: now() - startedAt };
    const current = now();
    if (
      policy.silenceMs > 0 &&
      task.type === "local_bash" &&
      task.outputFile &&
      current - lastSizeCheckAt >= OUTPUT_SIZE_CHECK_INTERVAL_MS
    ) {
      lastSizeCheckAt = current;
      const size = await outputFileSize(task.outputFile);
      if (size !== null && size !== lastSize) {
        if (lastSize !== null) lastGrowthAt = current;
        lastSize = size;
      }
      if (size !== null && current - lastGrowthAt >= policy.silenceMs) {
        return { task, waitedMs: current - startedAt, silentForMs: current - lastGrowthAt };
      }
    }
    await delay(TASK_OUTPUT_POLL_INTERVAL_MS);
  }
  return { task: context.runtimeTaskRegistry?.get(taskId), waitedMs: now() - startedAt };
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** What the model reads next to a wait that ended while the task still runs. */
export function describeUnfinishedWait(result: TaskOutputWaitResult): string {
  const silence =
    result.silentForMs !== undefined
      ? ` It has written no new output for ${seconds(result.silentForMs)}: it may be waiting for input or be hung.`
      : "";
  return (
    `The task is still running after this ${seconds(result.waitedMs)} wait.${silence} ` +
    "You will receive a <task-notification> when it finishes, so do not wait for it again in a loop: " +
    "continue with other work or end your turn. If it is stuck or waiting for input, stop it with TaskStop " +
    "and run it differently (non-interactive flags, a timeout)."
  );
}
