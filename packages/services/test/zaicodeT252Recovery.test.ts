// T-252 — 恢复时只展示本次运行事实；close/dispose 必须拦住仍在 await 的旧初始化。
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canTransitionZaicodeJob, ZAICODE_JOB_STATUSES, type ZaicodeJob } from "@zcode/shared";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import { ZaicodeStatsRepo } from "../src/zaicode/zaicodeStatsRepo.js";

const seed = (id: string, status: ZaicodeJob["status"] = "queued"): ZaicodeJob => ({
  id,
  status,
  workspaceKey: "recovery",
  workspacePath: "C:/test/recovery",
  agentId: "worker",
  title: "Recovery",
  instructions: "Work",
  priority: 0,
  sortOrder: 0,
  createdAt: 100,
  updatedAt: 100,
  attempt: 1,
  runId: "old-run",
  hostId: "host",
  heartbeatAt: 100,
});

async function withJobRepo(run: (repo: ZaicodeJobRepo) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-t252-queue-"));
  const repo = new ZaicodeJobRepo(join(dir, "tasks-index.sqlite"));
  try {
    await repo.ensureReady();
    await run(repo);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("T-252: direct dispatch cannot bypass blocked recovery, legal resume still runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-t252-service-"));
  const path = join(dir, "tasks-index.sqlite");
  const agents = new ZaicodeAgentRepo(path);
  const agentService = new ZaicodeAgentService({ repo: agents });
  const jobs = new ZaicodeJobRepo(path);
  let calls = 0;
  const service = new ZaicodeJobService({
    repo: jobs,
    getAgent: (id) => agentService.get(id),
    getExecutor: () => async () => {
      calls += 1;
      return { sessionId: "fresh-session" };
    },
  });
  try {
    await service.ensureReady();
    await service.setAutoRun(false);
    const agent = await agentService.create({
      name: "Worker",
      role: "implementer",
      instructions: "Work",
    });
    const job = await service.create({
      workspaceKey: "recovery",
      workspacePath: "C:/test/recovery",
      agentId: agent.id,
      title: "Recover",
      instructions: "Work",
    });
    await jobs.blockForDispatch(job.id, "explicit recovery required", 200);
    assert.equal((await service.dispatch(job.id))?.status, "blocked");
    assert.equal(calls, 0);
    assert.equal((await service.resume(job.id))?.status, "queued");
    assert.equal((await service.dispatch(job.id))?.status, "running");
    assert.equal(calls, 1);
  } finally {
    service.dispose();
    agents.close();
    jobs.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("T-252: resume and claim clear old attempt fields; only the new attach can become current", async () => {
  await withJobRepo(async (repo) => {
    const oldModel = { providerId: "old-provider", modelId: "old-model" };
    const old = {
      ...seed("resume", "blocked"),
      startedAt: 110,
      finishedAt: 190,
      sessionId: "old-session",
      actualModelSelection: oldModel,
      resultSummary: "old answer",
      error: "old failure",
    };
    await repo.create(old);
    const queued = await repo.resumeBlocked(old.id, 200);
    assert.ok(queued);
    for (const key of [
      "startedAt",
      "finishedAt",
      "sessionId",
      "actualModelSelection",
      "resultSummary",
      "error",
      "hostId",
      "heartbeatAt",
    ] as const)
      assert.equal(queued[key], undefined, `queued ${key} is current-attempt only`);
    assert.equal(queued.attempt, old.attempt);
    assert.equal(queued.queuedAt, 200);
    assert.equal(queued.runId, old.runId);
    const claimed = await repo.claimForDispatch({
      jobId: old.id,
      runId: "new-run",
      hostId: "new-host",
      now: 300,
    });
    assert.ok(claimed);
    assert.equal(claimed.attempt, old.attempt + 1);
    assert.equal(claimed.startedAt, 300);
    for (const key of [
      "finishedAt",
      "sessionId",
      "actualModelSelection",
      "resultSummary",
      "error",
    ] as const)
      assert.equal(claimed[key], undefined, `running ${key} cannot describe the previous run`);
    const stale = await repo.markTerminal({
      jobId: old.id,
      runId: "old-run",
      attempt: old.attempt,
      status: "completed",
      resultSummary: "late old answer",
      now: 310,
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.stale, true);
    await repo.attachSession({
      jobId: old.id,
      runId: "old-run",
      sessionId: "late-old-session",
      actualModelSelection: oldModel,
      now: 320,
    });
    assert.equal((await repo.get(old.id))?.sessionId, undefined);
    const newModel = { providerId: "new-provider", modelId: "new-model" };
    await repo.attachSession({
      jobId: old.id,
      runId: "new-run",
      sessionId: "new-session",
      actualModelSelection: newModel,
      now: 330,
    });
    assert.equal((await repo.get(old.id))?.sessionId, "new-session");
    assert.deepEqual((await repo.get(old.id))?.actualModelSelection, newModel);
  });
});

test("T-252: a queued legacy row is cleaned atomically by the claim even without resume", async () => {
  await withJobRepo(async (repo) => {
    await repo.create({
      ...seed("legacy"),
      startedAt: 110,
      finishedAt: 190,
      sessionId: "old",
      actualModelSelection: { providerId: "old", modelId: "old" },
      resultSummary: "old",
      error: "old",
    });
    const current = await repo.claimForDispatch({
      jobId: "legacy",
      runId: "new-run",
      hostId: "new-host",
      now: 300,
    });
    assert.ok(current);
    for (const key of [
      "finishedAt",
      "sessionId",
      "actualModelSelection",
      "resultSummary",
      "error",
    ] as const)
      assert.equal(current[key], undefined, key);
  });
});

const mutations: {
  name: string;
  apply: (repo: ZaicodeJobRepo, job: ZaicodeJob) => Promise<unknown> | unknown;
}[] = [
  {
    name: "claim",
    apply: (repo, job) =>
      repo.claimForDispatch({ jobId: job.id, runId: "new", hostId: "host", now: 300 }),
  },
  {
    name: "block before dispatch",
    apply: (repo, job) => repo.blockForDispatch(job.id, "blocked", 300),
  },
  {
    name: "block run",
    apply: (repo, job) =>
      repo.markBlocked({
        jobId: job.id,
        runId: job.runId!,
        attempt: job.attempt,
        error: "blocked",
        now: 300,
      }),
  },
  { name: "cancel", apply: (repo, job) => repo.cancel(job.id, 300) },
  { name: "resume", apply: (repo, job) => repo.resumeBlocked(job.id, 300) },
  {
    name: "complete",
    apply: (repo, job) =>
      repo.markTerminal({
        jobId: job.id,
        runId: job.runId!,
        attempt: job.attempt,
        status: "completed",
        now: 300,
      }),
  },
  {
    name: "fail",
    apply: (repo, job) =>
      repo.markTerminal({
        jobId: job.id,
        runId: job.runId!,
        attempt: job.attempt,
        status: "failed",
        now: 300,
      }),
  },
  {
    name: "stop outcome",
    apply: (repo, job) =>
      repo.markTerminal({
        jobId: job.id,
        runId: job.runId!,
        attempt: job.attempt,
        status: "cancelled",
        now: 300,
      }),
  },
  { name: "reclaim stale", apply: (repo) => repo.reclaimStaleRunning(300, 100) },
  { name: "release owned", apply: (repo) => repo.releaseRunningForHost("host", 300, "shutdown") },
];

test("T-252: every repository state writer stays inside the shared transition matrix", async (t) => {
  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      await withJobRepo(async (repo) => {
        for (const status of ZAICODE_JOB_STATUSES) {
          const job = seed(`${mutation.name}-${status}`, status);
          await repo.create(job);
          const before = await repo.get(job.id);
          await mutation.apply(repo, job);
          const after = await repo.get(job.id);
          assert.ok(after);
          if (after.status !== status)
            assert.equal(
              canTransitionZaicodeJob(status, after.status),
              true,
              `${mutation.name}: ${status} -> ${after.status}`,
            );
          if (["completed", "failed", "cancelled"].includes(status))
            assert.deepEqual(after, before, `terminal ${status} must remain unchanged`);
        }
      });
    });
  }
});

const repositories = [
  {
    name: "agent",
    create: (path: string) => {
      const repo = new ZaicodeAgentRepo(path);
      return { repo, read: () => repo.list() };
    },
  },
  {
    name: "job",
    create: (path: string) => {
      const repo = new ZaicodeJobRepo(path);
      return { repo, read: () => repo.list() };
    },
  },
  {
    name: "statistics",
    create: (path: string) => {
      const repo = new ZaicodeStatsRepo(path);
      return { repo, read: () => repo.getCursor("probe") };
    },
  },
];

for (const factory of repositories) {
  test(`T-252: closing pending ${factory.name} initialization cannot reopen SQLite`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zaicode-t252-close-"));
    const path = join(dir, "tasks-index.sqlite");
    const { repo, read } = factory.create(path);
    try {
      // await mkdir 必定让出当前 JS 栈；同栈 close 是确定性屏障，不依赖 sleep 或磁盘速度。
      const pending = repo.ensureReady();
      repo.close();
      await assert.rejects(pending, /initialization_cancelled/);
      await assert.rejects(Promise.resolve().then(read), /not ready|未初始化/);
      await assert.rejects(stat(path), { code: "ENOENT" });
      await Promise.all([repo.ensureReady(), repo.ensureReady(), repo.ensureReady()]);
      await read();
      repo.close();
      await rm(dir, { recursive: true });
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`T-252: stale ${factory.name} initialization cannot close a fresh post-close generation`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zaicode-t252-reopen-"));
    const { repo, read } = factory.create(join(dir, "tasks-index.sqlite"));
    try {
      const stale = repo.ensureReady();
      repo.close();
      const fresh = repo.ensureReady();
      const [oldResult, newResult] = await Promise.allSettled([stale, fresh]);
      assert.equal(oldResult?.status, "rejected");
      assert.equal(newResult?.status, "fulfilled");
      await read();
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const alreadyReady of [false, true]) {
  test(`T-252: fire-and-forget service startup cannot reopen after shutdown (repo ready=${alreadyReady})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zaicode-t252-shutdown-"));
    const repo = new ZaicodeJobRepo(join(dir, "tasks-index.sqlite"));
    const service = new ZaicodeJobService({
      repo,
      getAgent: async () => null,
      getExecutor: () => null,
    });
    const heartbeats = t.mock.method(globalThis, "setInterval");
    try {
      if (alreadyReady) await repo.ensureReady();
      const startup = service.ensureReady();
      service.dispose();
      repo.close();
      await assert.rejects(startup, /initialization_cancelled|service_disposed/);
      assert.equal(heartbeats.mock.callCount(), 0, "shutdown must not start a heartbeat");
      await assert.rejects(service.getAutoRun(), /service_disposed/);
      await assert.rejects(service.reconcileStaleRuns(), /service_disposed/);
      await assert.rejects(service.cancel("missing"), /service_disposed/);
      await assert.rejects(service.getMaxConcurrency(), /service_disposed/);
      await assert.rejects(service.setMaxConcurrency(2), /service_disposed/);
      await assert.rejects(
        service.delegateFromRun({ parentJobId: "missing", runId: "missing", request: {} }),
        /service_disposed/,
      );
      await assert.rejects(repo.list(), /未初始化/);
      await rm(dir, { recursive: true });
    } finally {
      service.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("T-252: a cold workspace can read and change concurrency before startup finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-t252-cold-settings-"));
  const repo = new ZaicodeJobRepo(join(dir, "tasks-index.sqlite"));
  const service = new ZaicodeJobService({
    repo,
    getAgent: async () => null,
    getExecutor: () => null,
  });
  try {
    assert.equal(await service.getMaxConcurrency(), 1);
    assert.equal(await service.setMaxConcurrency(2), 2);
    assert.equal(await service.getMaxConcurrency(), 2);
  } finally {
    service.dispose();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
