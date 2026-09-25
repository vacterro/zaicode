import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ZaicodeAgentDefinition, ZaicodeJob, ZaicodeJobCreateInput } from "@zcode/shared";
import { ZAICODE_JOB_HEARTBEAT_STALE_MS } from "@zcode/shared";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import type { ZaicodeJobExecutor } from "../src/zaicode/zaicodeJobs.js";

interface Harness {
  dir: string;
  dbPath: string;
  agentService: ZaicodeAgentService;
  jobService: ZaicodeJobService;
  jobRepo: ZaicodeJobRepo;
  executorCalls: string[];
  dispose: () => Promise<void>;
}

async function createHarness(options?: {
  executor?: ZaicodeJobExecutor;
  now?: () => number;
  autoRun?: boolean;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-test-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const agentRepo = new ZaicodeAgentRepo(dbPath, 500);
  const agentService = new ZaicodeAgentService({ repo: agentRepo });
  const jobRepo = new ZaicodeJobRepo(dbPath, 500);
  const executorCalls: string[] = [];
  const executor: ZaicodeJobExecutor =
    options?.executor ??
    (async ({ job }) => {
      executorCalls.push(job.id);
      return { sessionId: `session-${job.id}` };
    });
  const jobService = new ZaicodeJobService({
    repo: jobRepo,
    getAgent: (agentId) => agentService.get(agentId),
    getExecutor: () => executor,
    ...(options?.now ? { now: options.now } : {}),
  });
  await jobService.ensureReady();
  // 既有用例验证手动派发语义；自动驾驶由专门用例开启。
  await jobService.setAutoRun(options?.autoRun ?? false);
  return {
    dir,
    dbPath,
    agentService,
    jobService,
    jobRepo,
    executorCalls,
    dispose: async () => {
      jobService.dispose();
      agentRepo.close();
      jobRepo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function workspaceOf() {
  return {
    workspaceKey: "ws-key-1",
    workspacePath: "C:\\zaicode\\workspace",
  };
}

async function seedAgent(
  harness: Harness,
  overrides: Partial<ZaicodeAgentDefinition> = {},
): Promise<ZaicodeAgentDefinition> {
  return harness.agentService.create({
    name: overrides.name ?? "Test Agent",
    role: overrides.role ?? "implementer",
    instructions: overrides.instructions ?? "Do the work.",
    enabled: overrides.enabled ?? true,
  });
}

async function createJob(
  harness: Harness,
  agentId: string,
  overrides: Partial<ZaicodeJobCreateInput> = {},
): Promise<ZaicodeJob> {
  return harness.jobService.create({
    ...workspaceOf(harness),
    agentId,
    title: overrides.title ?? "Test job",
    instructions: overrides.instructions ?? "Perform the test job.",
    ...overrides,
  });
}

test("ZAICODE agent definitions: CRUD, stable id, malformed rows become diagnostics", async () => {
  const harness = await createHarness();
  try {
    const agent = await seedAgent(harness, { name: "Coordinator", role: "coordinator" });
    assert.match(agent.id, /^zaicode-agent:/);
    const renamed = await harness.agentService.update(agent.id, { name: "Coordinator v2" });
    assert.equal(renamed?.id, agent.id);
    assert.equal(renamed?.name, "Coordinator v2");
    const copy = await harness.agentService.duplicate(agent.id);
    assert.equal(copy?.name, "Coordinator v2 (copy)");
    assert.notEqual(copy?.id, agent.id);

    const fromTemplate = await harness.agentService.createFromTemplate("zaicode-template:auditor");
    assert.equal(fromTemplate.role, "auditor");
    assert.equal(fromTemplate.templateId, "zaicode-template:auditor");

    // 直接写入损坏行：列表必须给出诊断而不是静默丢弃。
    const db = new DatabaseSync(harness.dbPath);
    db.prepare(
      `INSERT INTO zaicode_agents (agent_id, name, role, instructions, enabled, tool_policy_json, created_at, updated_at)
       VALUES ('broken-agent', '', 'not-a-role', '', 1, '{', 1, 1)`,
    ).run();
    db.close();
    const listed = await harness.agentService.list();
    assert.equal(listed.agents.length, 3);
    assert.equal(listed.diagnostics.length, 1);
    assert.equal(listed.diagnostics[0]?.agentId, "broken-agent");
    assert.equal(listed.diagnostics[0]?.code, "invalid-definition");

    assert.equal(await harness.agentService.remove(agent.id), true);
    assert.equal(await harness.agentService.get(agent.id), null);
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE agent tool policy: omitted patch preserves policy and explicit patches can change or clear it", async () => {
  const harness = await createHarness();
  try {
    const agent = await harness.agentService.create({
      name: "Restricted Agent",
      role: "implementer",
      instructions: "Do the work.",
      toolPolicy: {
        allowedTools: ["ReadFile"],
        disallowedTools: ["Bash"],
      },
    });

    const renamed = await harness.agentService.update(agent.id, { name: "Renamed Agent" });
    assert.deepEqual(renamed?.toolPolicy, agent.toolPolicy);

    const intentionallyChanged = await harness.agentService.update(agent.id, {
      toolPolicy: {
        allowedTools: ["Glob"],
        disallowedTools: ["Network"],
        permissionMode: "plan",
      },
    });
    assert.deepEqual(intentionallyChanged?.toolPolicy, {
      allowedTools: ["Glob"],
      disallowedTools: ["Network"],
      permissionMode: "plan",
    });

    const intentionallyCleared = await harness.agentService.update(agent.id, { toolPolicy: {} });
    assert.deepEqual(intentionallyCleared?.toolPolicy, {});
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: dispatch is single-flight and terminal writes are idempotent", async () => {
  const harness = await createHarness();
  try {
    const agent = await seedAgent(harness);
    const job = await createJob(harness, agent.id);
    assert.equal(job.status, "queued");

    const running = await harness.jobService.dispatch(job.id);
    assert.equal(running?.status, "running");
    assert.equal(harness.executorCalls.length, 1);

    // 重复派发：不产生第二次执行。
    const again = await harness.jobService.dispatch(job.id);
    assert.equal(again?.status, "running");
    assert.equal(harness.executorCalls.length, 1);

    const runId = running?.runId ?? "";
    const attempt = running?.attempt ?? 0;
    const completed = await harness.jobService.reportRunOutcome({
      jobId: job.id,
      runId,
      attempt,
      outcome: "succeeded",
      resultSummary: "done",
    });
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.resultSummary, "done");

    // 幂等：重复完成写入不改状态。
    const duplicate = await harness.jobService.reportRunOutcome({
      jobId: job.id,
      runId,
      attempt,
      outcome: "failed",
      error: "late duplicate",
    });
    assert.equal(duplicate?.status, "completed");
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: stale completion cannot overwrite a newer retry", async () => {
  const harness = await createHarness();
  try {
    const agent = await seedAgent(harness);
    const job = await createJob(harness, agent.id);
    const running = await harness.jobService.dispatch(job.id);
    assert.equal(running?.status, "running");
    const staleRunId = running?.runId ?? "";
    const staleAttempt = running?.attempt ?? 0;
    await harness.jobService.reportRunOutcome({
      jobId: job.id,
      runId: staleRunId,
      attempt: staleAttempt,
      outcome: "failed",
      error: "first attempt failed",
    });

    const retry = await harness.jobService.retry(job.id);
    assert.equal(retry.status, "queued");
    assert.equal(retry.retryOfJobId, job.id);
    const retryRunning = await harness.jobService.dispatch(retry.id);
    assert.equal(retryRunning?.status, "running");

    // 旧 run 的完成到达：必须被拒绝，不覆盖新重试的 running。
    const staleWrite = await harness.jobService.reportRunOutcome({
      jobId: retry.id,
      runId: staleRunId,
      attempt: staleAttempt,
      outcome: "succeeded",
    });
    assert.equal(staleWrite?.status, "running");

    const original = await harness.jobService.get(job.id);
    assert.equal(original?.status, "failed");
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: cancel is idempotent and stops the running session", async () => {
  let stopCalls = 0;
  const harness = await createHarness({
    executor: async ({ job }) => ({
      sessionId: `session-${job.id}`,
      stop: async () => {
        stopCalls += 1;
      },
    }),
  });
  try {
    const agent = await seedAgent(harness);
    const job = await createJob(harness, agent.id);
    await harness.jobService.dispatch(job.id);
    const cancelled = await harness.jobService.cancel(job.id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(stopCalls, 1);
    const cancelledAgain = await harness.jobService.cancel(job.id);
    assert.equal(cancelledAgain?.status, "cancelled");
    assert.equal(stopCalls, 1);
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: restart reconciliation blocks stale running jobs and resume requeues them", async () => {
  let now = 1_000_000;
  const harness = await createHarness({ now: () => now });
  try {
    const agent = await seedAgent(harness);
    const job = await createJob(harness, agent.id);
    await harness.jobService.dispatch(job.id);

    // 心跳过期（进程死亡）：回收为 blocked，绝不静默变成 completed。
    now += ZAICODE_JOB_HEARTBEAT_STALE_MS + 1;
    const reclaimed = await harness.jobService.reconcileStaleRuns();
    assert.equal(reclaimed, 1);
    const blocked = await harness.jobService.get(job.id);
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.error, "interrupted_by_restart");

    const resumed = await harness.jobService.resume(job.id);
    assert.equal(resumed?.status, "queued");
    const redispatch = await harness.jobService.dispatch(job.id);
    assert.equal(redispatch?.status, "running");
    assert.equal(redispatch?.attempt, 2);
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: concurrency gate is storage-backed and configurable", async () => {
  const harness = await createHarness();
  try {
    const agent = await seedAgent(harness);
    const first = await createJob(harness, agent.id, { title: "first" });
    const second = await createJob(harness, agent.id, { title: "second" });

    assert.equal(await harness.jobService.getMaxConcurrency(), 1);
    const pumped = await harness.jobService.pump(workspaceOf().workspaceKey);
    assert.equal(pumped.length, 1);
    assert.equal(await harness.jobRepo.countRunning(workspaceOf().workspaceKey), 1);

    const running = await harness.jobService.get(pumped[0]?.id ?? "");
    await harness.jobService.reportRunOutcome({
      jobId: running?.id ?? "",
      runId: running?.runId ?? "",
      attempt: running?.attempt ?? 0,
      outcome: "succeeded",
    });
    const pumpedAgain = await harness.jobService.pump(workspaceOf().workspaceKey);
    assert.equal(pumpedAgain.length, 1);
    assert.equal(pumpedAgain[0]?.id, second.id);
    assert.notEqual(pumpedAgain[0]?.id, first.id);

    // 上限可配置且被钳制在保守范围内。
    assert.equal(await harness.jobService.setMaxConcurrency(99), 4);
    assert.equal(await harness.jobService.getMaxConcurrency(), 4);
    assert.equal(await harness.jobService.setMaxConcurrency(0), 1);
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: disabled or missing agent blocks dispatch with a reason", async () => {
  const harness = await createHarness();
  try {
    const agent = await seedAgent(harness, { enabled: false });
    const job = await createJob(harness, agent.id);
    const blocked = await harness.jobService.dispatch(job.id);
    assert.equal(blocked?.status, "blocked");
    assert.match(blocked?.error ?? "", /agent_disabled/);

    const orphan = await createJob(harness, "zaicode-agent:missing");
    const orphanBlocked = await harness.jobService.dispatch(orphan.id);
    assert.equal(orphanBlocked?.status, "blocked");
    assert.match(orphanBlocked?.error ?? "", /agent_missing/);

    // 恢复：重新启用 agent 后可继续派发。
    await harness.agentService.update(agent.id, { enabled: true });
    const resumed = await harness.jobService.resume(job.id);
    assert.equal(resumed?.status, "queued");
    const dispatched = await harness.jobService.dispatch(job.id);
    assert.equal(dispatched?.status, "running");
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: bounded orchestration probe delegates one child through the real path", async () => {
  const harness = await createHarness();
  try {
    const coordinator = await seedAgent(harness, { name: "Coordinator", role: "coordinator" });
    const implementer = await seedAgent(harness, { name: "Implementer", role: "implementer" });
    const parent = await createJob(harness, coordinator.id, {
      title: "operator task",
      delegation: { targetAgentId: implementer.id, instructions: "Implement the child task." },
    });
    const running = await harness.jobService.dispatch(parent.id);
    assert.equal(running?.status, "running");
    await harness.jobService.reportRunOutcome({
      jobId: parent.id,
      runId: running?.runId ?? "",
      attempt: running?.attempt ?? 0,
      outcome: "succeeded",
    });
    // 委托子任务经真实队列路径创建并自动派发到目标 agent。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const jobs = await harness.jobService.list({ workspaceKey: workspaceOf().workspaceKey });
    const child = jobs.jobs.find((job) => job.parentJobId === parent.id);
    assert.ok(child, "child job must exist");
    assert.equal(child?.agentId, implementer.id);
    assert.equal(child?.status, "running");

    // 深度恒为 1：子任务即使带 delegation 也不会再派生。
    const grandchild = await harness.jobService.create({
      ...workspaceOf(harness),
      agentId: coordinator.id,
      title: "grandchild attempt",
      instructions: "should not delegate",
      parentJobId: child?.id,
      delegation: { targetAgentId: implementer.id, instructions: "nested" },
    });
    assert.equal(grandchild.delegation, undefined);
    // 完成该子任务：delegation 已被丢弃，队列不得再派生任何下一层任务。
    const childDone = await harness.jobService.get(child?.id ?? "");
    await harness.jobService.reportRunOutcome({
      jobId: childDone?.id ?? "",
      runId: childDone?.runId ?? "",
      attempt: childDone?.attempt ?? 0,
      outcome: "succeeded",
    });
    const grandchildRunning = await harness.jobService.dispatch(grandchild.id);
    assert.equal(grandchildRunning?.status, "running");
    await harness.jobService.reportRunOutcome({
      jobId: grandchild.id,
      runId: grandchildRunning?.runId ?? "",
      attempt: grandchildRunning?.attempt ?? 0,
      outcome: "succeeded",
    });
    const afterAll = await harness.jobService.list({ workspaceKey: workspaceOf().workspaceKey });
    assert.equal(afterAll.jobs.filter((job) => job.parentJobId === grandchild.id).length, 0);
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: malformed persisted rows are reported, not executed", async () => {
  const harness = await createHarness();
  try {
    const db = new DatabaseSync(harness.dbPath);
    db.prepare(
      `INSERT INTO zaicode_jobs (job_id, workspace_key, workspace_path, agent_id, title, instructions, status, priority, sort_order, created_at, updated_at, attempt)
       VALUES ('broken-job', 'ws', 'C:\\ws', 'agent', '', '', 'nonsense', 0, 0, 1, 1, 0)`,
    ).run();
    db.close();
    const listed = await harness.jobService.list();
    assert.equal(listed.jobs.length, 0);
    assert.equal(listed.diagnostics.length, 1);
    assert.equal(listed.diagnostics[0]?.jobId, "broken-job");
    // 派发损坏行：找不到合法任务，明确报错而不是猜测语义。
    await assert.rejects(() => harness.jobService.dispatch("broken-job"), /任务不存在/);
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: jobs are isolated per workspace and executor failures are terminal", async () => {
  const harness = await createHarness({
    executor: async ({ job }) => {
      if (job.title === "explode") throw new Error("executor exploded");
      return { sessionId: `session-${job.id}` };
    },
  });
  try {
    const agent = await seedAgent(harness);
    const first = await createJob(harness, agent.id, { title: "first" });
    await harness.jobService.create({
      workspaceKey: "ws-key-2",
      workspacePath: "C:\\zaicode\\other",
      agentId: agent.id,
      title: "foreign",
      instructions: "must stay in its own workspace",
    });
    const pumped = await harness.jobService.pump("ws-key-1");
    assert.equal(pumped.length, 1);
    assert.equal(pumped[0]?.id, first.id);
    const foreignJobs = await harness.jobService.list({ workspaceKey: "ws-key-2" });
    assert.equal(foreignJobs.jobs[0]?.status, "queued");

    const exploding = await createJob(harness, agent.id, { title: "explode" });
    const failed = await harness.jobService.dispatch(exploding.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /dispatch_failed: executor exploded/);
  } finally {
    await harness.dispose();
  }
});

test("ZAICODE job queue: autopilot starts queued work and refills freed slots", async () => {
  const harness = await createHarness({ autoRun: true });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  try {
    assert.equal(await harness.jobService.getAutoRun(), true);
    const agent = await seedAgent(harness);
    const first = await createJob(harness, agent.id, { title: "first" });
    const second = await createJob(harness, agent.id, { title: "second" });
    await settle();
    assert.equal((await harness.jobService.get(first.id))?.status, "running");
    assert.equal((await harness.jobService.get(second.id))?.status, "queued");

    const running = await harness.jobService.get(first.id);
    await harness.jobService.reportRunOutcome({
      jobId: first.id,
      runId: running!.runId!,
      attempt: running!.attempt,
      outcome: "succeeded",
    });
    await settle();
    assert.equal((await harness.jobService.get(second.id))?.status, "running");

    await harness.jobService.setAutoRun(false);
    const third = await createJob(harness, agent.id, { title: "third" });
    await settle();
    assert.equal((await harness.jobService.get(third.id))?.status, "queued");
  } finally {
    await harness.dispose();
  }
});
