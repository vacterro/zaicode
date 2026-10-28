import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ZAICODE_COMPACT_CONTEXT_TOKENS,
  resolveZaicodeCompactCeiling,
  zaicodeCompactContextWindow,
} from "../src/compact/zaicode-context-ceiling.js";
import { getAutoCompactThreshold } from "../src/compact/policy.js";
import {
  ZAICODE_TASK_OUTPUT_MAX_WAIT_MS,
  ZAICODE_TASK_OUTPUT_SILENCE_MS,
  describeUnfinishedWait,
  resolveTaskOutputWaitPolicy,
  waitForTask,
} from "../src/tool/handlers/task-output-wait.js";
import type { RuntimeTaskSnapshot } from "../src/runtime-task/registry.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

/**
 * T-136 (SRC-100): token economy and the "Task output exec_... Wait timed out" hang.
 */

const ZAICODE_ENV = { ZCODE_ZAICODE_MODE: "1" } as NodeJS.ProcessEnv;

test("ZAICODE compacts a 1M-token model as if its window were 200k", () => {
  assert.equal(zaicodeCompactContextWindow(1_000_000, ZAICODE_ENV), ZAICODE_COMPACT_CONTEXT_TOKENS);
  assert.equal(zaicodeCompactContextWindow(128_000, ZAICODE_ENV), 128_000);
  assert.equal(zaicodeCompactContextWindow(undefined, ZAICODE_ENV), undefined);
  // The threshold the runtime compares provider usage with drops from ~966k to ~166k.
  const before = getAutoCompactThreshold({ contextWindow: 1_000_000, maxOutputTokens: 32_000 });
  const after = getAutoCompactThreshold({
    contextWindow: zaicodeCompactContextWindow(1_000_000, ZAICODE_ENV),
    maxOutputTokens: 32_000,
  });
  assert.ok(before > 900_000, `before ${before}`);
  assert.ok(after < 200_000 && after > 150_000, `after ${after}`);
});

test("the compaction ceiling is ZAICODE-only and can be moved or switched off", () => {
  assert.equal(zaicodeCompactContextWindow(1_000_000, {} as NodeJS.ProcessEnv), 1_000_000);
  assert.equal(resolveZaicodeCompactCeiling({ ...ZAICODE_ENV, ZAICODE_COMPACT_CONTEXT_TOKENS: "0" }), null);
  assert.equal(
    resolveZaicodeCompactCeiling({ ...ZAICODE_ENV, ZAICODE_COMPACT_CONTEXT_TOKENS: "400000" }),
    400_000,
  );
  // A ceiling so small it would compact every step is ignored.
  assert.equal(
    resolveZaicodeCompactCeiling({ ...ZAICODE_ENV, ZAICODE_COMPACT_CONTEXT_TOKENS: "1000" }),
    ZAICODE_COMPACT_CONTEXT_TOKENS,
  );
});

test("a TaskOutput wait is capped in ZAICODE only", () => {
  assert.deepEqual(resolveTaskOutputWaitPolicy(ZAICODE_ENV), {
    maxWaitMs: ZAICODE_TASK_OUTPUT_MAX_WAIT_MS,
    silenceMs: ZAICODE_TASK_OUTPUT_SILENCE_MS,
    guidance: true,
  });
  const upstream = resolveTaskOutputWaitPolicy({} as NodeJS.ProcessEnv);
  assert.equal(upstream.maxWaitMs, Number.POSITIVE_INFINITY);
  assert.equal(upstream.silenceMs, 0);
  assert.equal(upstream.guidance, false);
});

function contextWith(task: RuntimeTaskSnapshot): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    runtimeTaskRegistry: { get: (id: string) => (id === task.taskId ? task : undefined) },
  } as unknown as ToolExecutionContext;
}

function fakeClock(stepMs: number): () => number {
  let current = 1_000_000;
  return () => {
    current += stepMs;
    return current;
  };
}

test("a background shell that writes nothing ends the wait long before the model's 600 s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zaicode-t136-"));
  const outputFile = join(dir, "exec.output");
  writeFileSync(outputFile, "waiting for input> ");
  const task = {
    taskId: "exec_hung",
    type: "local_bash",
    status: "running",
    description: "npm init",
    outputFile,
  } as unknown as RuntimeTaskSnapshot;
  // Each clock read advances 2 s: the loop sees silence without real sleeping for minutes.
  const result = await waitForTask(
    "exec_hung",
    600_000,
    contextWith(task),
    { maxWaitMs: 120_000, silenceMs: 60_000, guidance: true },
    fakeClock(2_000),
  );
  assert.equal(result.task?.status, "running");
  assert.ok(result.silentForMs !== undefined && result.silentForMs >= 60_000, `silent ${result.silentForMs}`);
  assert.ok(result.waitedMs < 120_000, `waited ${result.waitedMs}`);
  const note = describeUnfinishedWait(result);
  assert.match(note, /no new output/);
  assert.match(note, /<task-notification>/);
  assert.match(note, /TaskStop/);
});

test("a background shell that keeps writing is waited for up to the cap, not cut as silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zaicode-t136-"));
  const outputFile = join(dir, "exec.output");
  writeFileSync(outputFile, "");
  const task = {
    taskId: "exec_busy",
    type: "local_bash",
    status: "running",
    description: "pnpm build",
    outputFile,
  } as unknown as RuntimeTaskSnapshot;
  const clock = fakeClock(2_000);
  const busyClock = () => {
    appendFileSync(outputFile, "x");
    return clock();
  };
  const result = await waitForTask(
    "exec_busy",
    600_000,
    contextWith(task),
    { maxWaitMs: 120_000, silenceMs: 60_000, guidance: true },
    busyClock,
  );
  assert.equal(result.silentForMs, undefined);
  assert.ok(result.waitedMs >= 120_000, `waited ${result.waitedMs}`);
  assert.doesNotMatch(describeUnfinishedWait(result), /no new output/);
});

test("a finished task returns at once", async () => {
  const task = {
    taskId: "exec_done",
    type: "local_bash",
    status: "completed",
    description: "echo ok",
  } as unknown as RuntimeTaskSnapshot;
  const result = await waitForTask("exec_done", 600_000, contextWith(task), {
    maxWaitMs: 120_000,
    silenceMs: 60_000,
    guidance: true,
  });
  assert.equal(result.task?.status, "completed");
});
