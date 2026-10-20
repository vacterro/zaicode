import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import { ZaicodeAuditService } from "../src/zaicode/zaicodeAuditService.js";
import type { ZaicodeJobExecutor } from "../src/zaicode/zaicodeJobs.js";
import {
  ZAICODE_JOB_GLOBAL_CONCURRENCY_DEFAULT,
  type ZaicodeAuditBatch,
} from "@zcode/shared";

interface Harness {
  dir: string;
  auditRoot: string;
  agentService: ZaicodeAgentService;
  jobService: ZaicodeJobService;
  audits: ZaicodeAuditService;
  dispose: () => Promise<void>;
}

async function createBatchHarness(
  executor?: ZaicodeJobExecutor,
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-batch-"));
  const dbPath = join(dir, "tasks.sqlite");
  const auditRoot = join(dir, "audits");
  const agentRepo = new ZaicodeAgentRepo(dbPath, 500);
  const agentService = new ZaicodeAgentService({ repo: agentRepo });
  const jobRepo = new ZaicodeJobRepo(dbPath, 500);
  const jobService = new ZaicodeJobService({
    repo: jobRepo,
    getAgent: (agentId) => agentService.get(agentId),
    getExecutor: () => executor ?? (async ({ job }) => ({ sessionId: `session-${job.id}` })),
  });
  await jobService.ensureReady();
  await jobService.setAutoRun(false);

  const audits = new ZaicodeAuditService({
    jobService,
    agentService,
    rootDir: () => auditRoot,
  });

  return {
    dir,
    auditRoot,
    agentService,
    jobService,
    audits,
    dispose: async () => {
      audits.dispose();
      jobService.dispose();
      agentRepo.close();
      jobRepo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Quick3 Batch: creation and idempotent admission accounting", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-1", workspacePath: "C:\\p1", projectName: "Project1" };
    const p2 = { workspaceKey: "ws-2", workspacePath: "C:\\p2", projectName: "Project2" };
    const p3 = { workspaceKey: "ws-3", workspacePath: "C:\\p3", projectName: "Project3" };

    // Initial batch creation with planOnly: true
    const result = await h.audits.createBatch({
      projects: [p1, p2, p1, { workspaceKey: "", workspacePath: "", projectName: "Bad" }],
      planOnly: true,
      workerCapacity: 6,
    });

    assert.equal(result.admittedCount, 2, "2 unique valid projects admitted");
    assert.equal(result.duplicateCount, 1, "1 duplicate rejected");
    assert.equal(result.rejectedCount, 1, "1 invalid project rejected");
    assert.equal(result.batch.status, "planned");
    assert.equal(result.batch.workerCapacity, 6);
    assert.equal(await h.jobService.getGlobalConcurrency(), ZAICODE_JOB_GLOBAL_CONCURRENCY_DEFAULT, "global concurrency untouched");

    // Second batch attempting to admit p1 which already has an active planned campaign
    const result2 = await h.audits.createBatch({
      projects: [p1, p3],
      planOnly: true,
    });
    assert.equal(result2.admittedCount, 1, "only p3 admitted");
    assert.equal(result2.skippedCount, 1, "p1 skipped because active campaign exists");

    const loaded = await h.audits.getBatch(result.batch.batchId);
    assert.ok(loaded);
    assert.equal(loaded?.batchId, result.batch.batchId);
    assert.equal(loaded?.projects.length, 4);

    const list = await h.audits.listBatches();
    assert.equal(list.length, 2);
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: global worker capacity limits concurrent dispatches across workspaces", async () => {
  const h = await createBatchHarness();
  try {
    // Set global concurrency to 2, per-workspace concurrency to 1
    await h.jobService.setGlobalConcurrency(2);
    await h.jobService.setMaxConcurrency(1);

    const p1 = { workspaceKey: "ws-a", workspacePath: "C:\\pa", projectName: "ProjA" };
    const p2 = { workspaceKey: "ws-b", workspacePath: "C:\\pb", projectName: "ProjB" };
    const p3 = { workspaceKey: "ws-c", workspacePath: "C:\\pc", projectName: "ProjC" };
    const p4 = { workspaceKey: "ws-d", workspacePath: "C:\\pd", projectName: "ProjD" };

    const admission = await h.audits.createBatch({
      projects: [p1, p2, p3, p4],
      planOnly: false,
      workerCapacity: 4,
    });
    assert.equal(admission.admittedCount, 4);

    // Initial dispatch by createBatch dispatched up to global limit (2)
    const runningJobs = await h.jobService.list({ status: "running" });
    assert.equal(runningJobs.jobs.length, 2, "exactly 2 jobs dispatched across all workspaces");

    // Additional pumpAll should dispatch nothing since global limit of 2 is reached
    const secondPump = await h.jobService.pumpAll();
    assert.equal(secondPump.length, 0, "no extra dispatch when at global capacity");

    // Increase global concurrency to 4 and pumpAll
    await h.jobService.setGlobalConcurrency(4);
    const thirdPump = await h.jobService.pumpAll();
    assert.equal(thirdPump.length, 2, "now remaining 2 workspaces can dispatch");
    const allRunning = await h.jobService.list({ status: "running" });
    assert.equal(allRunning.jobs.length, 4);
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: batch lifecycle (pause, resume, stop, retry)", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-x", workspacePath: "C:\\px", projectName: "ProjX" };
    const p2 = { workspaceKey: "ws-y", workspacePath: "C:\\py", projectName: "ProjY" };

    const { batch } = await h.audits.createBatch({
      projects: [p1, p2],
      planOnly: true,
    });
    assert.equal(batch.status, "planned");

    // Resume starts planned campaigns
    const resumed = await h.audits.resumeBatch(batch.batchId);
    assert.ok(resumed);
    assert.equal(resumed?.status, "running");

    // Pause batch
    const paused = await h.audits.pauseBatch(batch.batchId);
    assert.equal(paused?.status, "paused");

    // Stop batch
    const stopped = await h.audits.stopBatch(batch.batchId);
    assert.equal(stopped?.status, "cancelled");

    for (const cId of batch.campaignIds) {
      const c = await h.audits.getCampaign(cId);
      assert.equal(c?.status, "cancelled");
    }
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: getActiveWorkers reports running worker identities truthfully", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-m", workspacePath: "C:\\pm", projectName: "ProjM" };
    const p2 = { workspaceKey: "ws-n", workspacePath: "C:\\pn", projectName: "ProjN" };

    await h.audits.createBatch({
      projects: [p1, p2],
      planOnly: false,
      workerCapacity: 2,
    });

    const workers = await h.audits.getActiveWorkers();
    assert.equal(workers.length, 2);
    for (const w of workers) {
      assert.ok(w.workerId.startsWith("worker-"));
      assert.ok(w.sessionId.startsWith("session-"));
      assert.equal(w.status, "running");
      assert.equal(w.waveId, "core");
      assert.equal(w.waveOrdinal, 1);
    }
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: pause establishes dispatch fence and resume releases it", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-p1", workspacePath: "C:\\p1", projectName: "Proj1" };
    const p2 = { workspaceKey: "ws-p2", workspacePath: "C:\\p2", projectName: "Proj2" };
    const p3 = { workspaceKey: "ws-p3", workspacePath: "C:\\p3", projectName: "Proj3" };
    const p4 = { workspaceKey: "ws-p4", workspacePath: "C:\\p4", projectName: "Proj4" };

    // Batch with workerCapacity: 2, planOnly: false
    const admission = await h.audits.createBatch({
      projects: [p1, p2, p3, p4],
      planOnly: false,
      workerCapacity: 2,
    });
    assert.equal(admission.admittedCount, 4);

    // Initial dispatch by createBatch dispatched 2 jobs (since batch workerCapacity = 2)
    const running = await h.jobService.list({ status: "running" });
    assert.equal(running.jobs.length, 2);

    // 2 jobs are queued
    const queuedBefore = await h.jobService.list({ status: "queued" });
    assert.equal(queuedBefore.jobs.length, 2);

    // Now PAUSE the batch!
    const paused = await h.audits.pauseBatch(admission.batch.batchId);
    assert.equal(paused?.status, "paused");

    // Attempting pumpAll while paused MUST NOT dispatch the queued jobs
    const pumpedWhilePaused = await h.jobService.pumpAll();
    assert.equal(pumpedWhilePaused.length, 0, "no jobs dispatched while batch is paused");

    const queuedStill = await h.jobService.list({ status: "queued" });
    assert.equal(queuedStill.jobs.length, 2, "queued jobs remain untouched");

    // Complete the 2 running jobs
    for (const job of running.jobs) {
      await h.jobService.reportRunOutcome({
        jobId: job.id,
        runId: job.runId!,
        attempt: job.attempt,
        outcome: "succeeded",
      });
    }

    // Now running is 0, but batch is still paused
    // Calling pumpAll still MUST NOT dispatch queued jobs
    const pumpedAgain = await h.jobService.pumpAll();
    assert.equal(pumpedAgain.length, 0, "queued jobs still held while batch is paused");

    // RESUME the batch
    const resumed = await h.audits.resumeBatch(admission.batch.batchId);
    assert.equal(resumed?.status, "running");

    // Now the dispatch fence is released! pumpAll dispatches the remaining jobs up to capacity (2)
    const runningAfterResume = await h.jobService.list({ status: "running" });
    assert.equal(runningAfterResume.jobs.length, 2, "queued jobs now dispatched after resume");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: policy isolation between batches and global settings", async () => {
  const h = await createBatchHarness();
  try {
    await h.jobService.setGlobalConcurrency(6);

    const pA1 = { workspaceKey: "ws-a1", workspacePath: "C:\\pa1", projectName: "PA1" };
    const pA2 = { workspaceKey: "ws-a2", workspacePath: "C:\\pa2", projectName: "PA2" };
    const pB1 = { workspaceKey: "ws-b1", workspacePath: "C:\\pb1", projectName: "PB1" };
    const pB2 = { workspaceKey: "ws-b2", workspacePath: "C:\\pb2", projectName: "PB2" };

    // Batch A with capacity 4, autoWaves: false
    const batchA = await h.audits.createBatch({
      projects: [pA1, pA2],
      planOnly: true,
      workerCapacity: 4,
      autoWaves: false,
    });
    // Global concurrency and global autoWaves MUST NOT be mutated!
    assert.equal(await h.jobService.getGlobalConcurrency(), 6, "global concurrency untouched");
    assert.equal(batchA.batch.workerCapacity, 4);
    assert.equal(batchA.batch.autoWaves, false);

    // Batch B with capacity 2, autoWaves: true
    const batchB = await h.audits.createBatch({
      projects: [pB1, pB2],
      planOnly: false,
      workerCapacity: 2,
      autoWaves: true,
    });
    assert.equal(await h.jobService.getGlobalConcurrency(), 6, "global concurrency still 6");
    assert.equal(batchB.batch.workerCapacity, 2);
    assert.equal(batchB.batch.autoWaves, true);
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: request idempotency and write-ahead admission recovery", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-idem1", workspacePath: "C:\\pi1", projectName: "ProjIdem1" };
    const p2 = { workspaceKey: "ws-idem2", workspacePath: "C:\\pi2", projectName: "ProjIdem2" };

    const requestId = "req-custom-unique-123";

    // Concurrent batch creation with identical requestId
    const [res1, res2] = await Promise.all([
      h.audits.createBatch({
        requestId,
        projects: [p1, p2],
        planOnly: true,
      }),
      h.audits.createBatch({
        requestId,
        projects: [p1, p2],
        planOnly: true,
      }),
    ]);

    assert.equal(res1.batch.batchId, res2.batch.batchId, "both returned identical batch identity");
    assert.equal(res1.admittedCount, 2);
    assert.equal(res2.admittedCount, 2);

    const allBatches = await h.audits.listBatches();
    const matching = allBatches.filter((b) => b.requestId === requestId);
    assert.equal(matching.length, 1, "exactly one batch recorded on disk");

    // Write-ahead crash recovery: simulate a batch interrupted in 'admitting' status
    const crashedBatchId = "batch-crashed-test";
    const crashPath = join(h.auditRoot, "batches", `${crashedBatchId}.json`);
    const crashedBatch: ZaicodeAuditBatch = {
      schemaVersion: 1,
      batchId: crashedBatchId,
      requestId: "req-crashed-recovery",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requestProvenance: "operator_ui",
      profileId: "quick3",
      profileVersion: "1.0",
      manifestHash: "hash",
      planOnly: false,
      autoWaves: true,
      workerCapacity: 4,
      modelPolicy: {},
      projects: [
        {
          workspaceKey: p1.workspaceKey,
          workspacePath: p1.workspacePath,
          projectName: p1.projectName,
          campaignId: res1.batch.campaignIds[0],
          status: "admitted",
        },
      ],
      campaignIds: [res1.batch.campaignIds[0]],
      status: "admitting",
    };
    writeFileSync(crashPath, JSON.stringify(crashedBatch, null, 2), "utf8");

    // Loading/getting the batch reconciles 'admitting' to 'running'
    const recovered = await h.audits.getBatch(crashedBatchId);
    assert.ok(recovered);
    assert.equal(recovered?.status, "running", "recovered from admitting to running");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: 40 completed campaigns reconcile to COMPLETE without history cap truncation", async () => {
  const h = await createBatchHarness();
  try {
    // Generate 40 projects
    const projects = Array.from({ length: 40 }, (_, i) => ({
      workspaceKey: `ws-hist-${i}`,
      workspacePath: `C:\\p_hist_${i}`,
      projectName: `HistProj_${i}`,
    }));

    const { batch } = await h.audits.createBatch({
      projects,
      planOnly: true,
    });
    assert.equal(batch.campaignIds.length, 40);

    // Mark all 40 campaigns complete directly on disk
    for (const cId of batch.campaignIds) {
      const c = await h.audits.getCampaign(cId);
      assert.ok(c);
      c!.status = "complete";
      const campaignPath = join(h.auditRoot, cId, "campaign.json");
      writeFileSync(campaignPath, JSON.stringify(c, null, 2), "utf8");
    }

    // Direct campaign lookup finds the 40th campaign
    const c40 = await h.audits.getCampaign(batch.campaignIds[39]!);
    assert.ok(c40, "40th campaign is accessible by exact ID");
    assert.equal(c40?.status, "complete");

    // Reconcile batch status: with uncapped findCampaign, all 40 completed members are resolved
    const reconciled = await h.audits.getBatch(batch.batchId);
    assert.equal(reconciled?.status, "complete", "batch reconciles to complete with 40 campaigns");
    assert.equal(reconciled?.campaignIds.length, 40);
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: per-wave model policy resolves distinct models across waves", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-model", workspacePath: "C:\\p_model", projectName: "ModelProj" };

    const { batch } = await h.audits.createBatch({
      projects: [p1],
      planOnly: false,
      modelPolicy: {
        defaultModel: "anthropic/claude-3-5-haiku",
        waveModels: {
          core: "openai/gpt-4o",
          second: "anthropic/claude-3-5-sonnet",
          performance: "google/gemini-2.0-flash",
        },
      },
    });

    const cId = batch.campaignIds[0]!;
    const campaign = await h.audits.getCampaign(cId);
    assert.ok(campaign);

    // Wave 1 should use modelPolicy.waveModels.core: "openai/gpt-4o"
    const wave1 = campaign!.waves[0]!;
    assert.ok(wave1.jobId);
    const job1 = await h.jobService.get(wave1.jobId!);
    assert.ok(job1);
    const agent1 = await h.agentService.get(job1!.agentId);
    assert.equal(agent1?.modelRef, "gpt-4o");
    assert.equal(agent1?.providerRef, "openai");

    const workers = await h.audits.getActiveWorkers();
    assert.equal(workers.length, 1);
    assert.ok(workers[0]!.model.includes("gpt-4o"));
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: repeated launch creates new batch and detects request conflicts", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-rep", workspacePath: "C:\\prep", projectName: "RepProj" };

    // 1. Launch Quick3 without requestId
    const res1 = await h.audits.createBatch({
      projects: [p1],
      planOnly: true,
    });
    // 2. Mark complete
    const c1Path = join(h.auditRoot, res1.batch.campaignIds[0]!, "campaign.json");
    const c1 = JSON.parse(readFileSync(c1Path, "utf8"));
    c1.status = "complete";
    writeFileSync(c1Path, JSON.stringify(c1, null, 2), "utf8");

    // 3. Launch again with same project, no requestId
    const res2 = await h.audits.createBatch({
      projects: [p1],
      planOnly: true,
    });
    assert.notEqual(res1.batch.batchId, res2.batch.batchId, "new batch created for repeated launch");
    assert.notEqual(res1.batch.campaignIds[0], res2.batch.campaignIds[0], "new campaign created");

    // 4. Repeat with same explicit requestId
    const explicitReqId = "req-fixed-action-123";
    const res3 = await h.audits.createBatch({
      requestId: explicitReqId,
      projects: [p1],
      planOnly: true,
    });
    const res4 = await h.audits.createBatch({
      requestId: explicitReqId,
      projects: [p1],
      planOnly: true,
    });
    assert.equal(res3.batch.batchId, res4.batch.batchId, "same requestId returns original receipt");

    // 5. Send same requestId with conflicting project content -> throws conflict
    const p2 = { workspaceKey: "ws-diff", workspacePath: "C:\\pdiff", projectName: "DiffProj" };
    await assert.rejects(
      () =>
        h.audits.createBatch({
          requestId: explicitReqId,
          projects: [p1, p2],
          planOnly: true,
        }),
      /conflict/i,
    );
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: crash-safe admission reconciliation adopts existing and completes missing members", async () => {
  const h = await createBatchHarness();
  try {
    const projects = [
      { workspaceKey: "ws-c1", workspacePath: "C:\\pc1", projectName: "P1" },
      { workspaceKey: "ws-c2", workspacePath: "C:\\pc2", projectName: "P2" },
      { workspaceKey: "ws-c3", workspacePath: "C:\\pc3", projectName: "P3" },
      { workspaceKey: "ws-c4", workspacePath: "C:\\pc4", projectName: "P4" },
      { workspaceKey: "ws-c5", workspacePath: "C:\\pc5", projectName: "P5" },
    ];

    // Pre-create campaign for P1 and P2 under batch "batch-crash-5"
    const crashedBatchId = "batch-crash-5";
    const c1 = await h.audits.generate(projects[0]!, undefined, { batchId: crashedBatchId });
    const c2 = await h.audits.generate(projects[1]!, undefined, { batchId: crashedBatchId });
    assert.ok(c1 && c2);

    // Simulate batch record written ahead with 5 projects, where 2 were admitted and 3 still pending
    mkdirSync(join(h.auditRoot, "batches"), { recursive: true });
    const crashPath = join(h.auditRoot, "batches", `${crashedBatchId}.json`);
    const crashedBatch: ZaicodeAuditBatch = {
      schemaVersion: 1,
      batchId: crashedBatchId,
      requestId: "req-crash-5",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requestProvenance: "operator_ui",
      profileId: "quick3",
      profileVersion: "1.0",
      manifestHash: "hash",
      planOnly: true,
      autoWaves: true,
      workerCapacity: 4,
      modelPolicy: {},
      projects: [
        { ...projects[0]!, campaignId: c1!.campaignId, status: "admitted" },
        { ...projects[1]!, campaignId: c2!.campaignId, status: "admitted" },
        { ...projects[2]!, campaignId: null, status: "pending" },
        { ...projects[3]!, campaignId: null, status: "pending" },
        { ...projects[4]!, campaignId: null, status: "pending" },
      ],
      campaignIds: [c1!.campaignId, c2!.campaignId],
      status: "admitting",
    };
    writeFileSync(crashPath, JSON.stringify(crashedBatch, null, 2), "utf8");

    // Reconcile on restart (getBatch)
    const recovered = await h.audits.getBatch(crashedBatchId);
    assert.ok(recovered);
    assert.equal(recovered?.projects.length, 5, "all 5 projects remain in batch");
    assert.equal(recovered?.projects.every((p) => p.status === "admitted"), true, "all 5 projects reconciled to admitted");
    assert.equal(recovered?.campaignIds.length, 5, "all 5 campaigns linked");
    assert.equal(recovered?.campaignIds[0], c1!.campaignId, "adopted existing c1");
    assert.equal(recovered?.campaignIds[1], c2!.campaignId, "adopted existing c2");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: batch pause fence holds after job title is renamed", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-rename-1", workspacePath: "C:\\prename1", projectName: "RenameProj1" };
    const p2 = { workspaceKey: "ws-rename-2", workspacePath: "C:\\prename2", projectName: "RenameProj2" };
    const { batch } = await h.audits.createBatch({
      projects: [p1, p2],
      planOnly: false,
      workerCapacity: 1,
    });

    const c1Id = batch.campaignIds[0]!;
    const c2Id = batch.campaignIds[1]!;
    const c1 = await h.audits.getCampaign(c1Id);
    const c2 = await h.audits.getCampaign(c2Id);
    const j1Id = c1!.waves[0]!.jobId!;
    const j2Id = c2!.waves[0]!.jobId!;

    // j1 was dispatched, j2 is queued due to workerCapacity: 1
    const j2 = await h.jobService.get(j2Id);
    assert.equal(j2?.status, "queued");

    // Rename j2 title to strip all campaign markers
    await h.jobService.update(j2Id, { title: "Arbitrary renamed operator title with no brackets" });

    // Complete j1 so capacity frees up
    const j1 = await h.jobService.get(j1Id);
    if (j1?.runId) {
      await h.jobService.reportRunOutcome({
        jobId: j1Id,
        runId: j1.runId,
        attempt: j1.attempt,
        outcome: "succeeded",
      });
    }

    // Pause batch
    await h.audits.pauseBatch(batch.batchId);

    // Attempt dispatch - should be blocked by pause fence despite renamed title
    const dispatchedWhenPaused = await h.jobService.pumpAll();
    assert.equal(dispatchedWhenPaused.length, 0, "no dispatch while batch is paused even if title was renamed");

    // Resume batch (resumeBatch triggers pumpAll)
    await h.audits.resumeBatch(batch.batchId);
    const runningAfterResume = await h.jobService.list({ status: "running" });
    assert.equal(runningAfterResume.jobs.length, 1, "exactly one job running on resume");
    assert.equal(runningAfterResume.jobs[0]!.id, j2Id, "dispatched the renamed job");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: blocked project does not prevent other batch members from dispatching", async () => {
  const h = await createBatchHarness();
  try {
    await h.jobService.setGlobalConcurrency(1); // sequential dispatch
    const p1 = { workspaceKey: "ws-b1", workspacePath: "C:\\pb1", projectName: "Proj1" };
    const p2 = { workspaceKey: "ws-b2", workspacePath: "C:\\pb2", projectName: "Proj2" };
    const p3 = { workspaceKey: "ws-b3", workspacePath: "C:\\pb3", projectName: "Proj3" };

    const { batch } = await h.audits.createBatch({
      projects: [p1, p2, p3],
      planOnly: false,
      workerCapacity: 3,
    });

    const c1Id = batch.campaignIds[0]!;
    const c1 = (await h.audits.getCampaign(c1Id))!;

    // Make project 1 fail / become blocked
    const c1Path = join(h.auditRoot, c1Id, "campaign.json");
    c1.status = "blocked";
    c1.waves[0]!.status = "blocked";
    c1.waves[0]!.rejectReason = "Simulated invalid audit report";
    writeFileSync(c1Path, JSON.stringify(c1, null, 2), "utf8");

    // Reconcile batch - batch should not disable dispatch for p2 and p3!
    const batchState = await h.audits.getBatch(batch.batchId);
    assert.notEqual(batchState?.status, "blocked", "batch is not fully blocked while other members are pending");

    // Increase global concurrency and pump
    await h.jobService.setGlobalConcurrency(4);
    const dispatched = await h.jobService.pumpAll();
    assert.equal(dispatched.length, 2, "projects 2 and 3 dispatched despite project 1 being blocked");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: model policy fails honestly without dispatch and respects fallback when enabled", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-m-fail", workspacePath: "C:\\pmf", projectName: "MProjFail" };

    // 1. Unavailable model with fallback disabled: blocks wave truthfully
    const resNoFallback = await h.audits.createBatch({
      projects: [p1],
      planOnly: false,
      modelPolicy: {
        defaultModel: "unavailable-provider/bad-model",
        allowFallback: false,
      },
    });

    const cFail = await h.audits.getCampaign(resNoFallback.batch.campaignIds[0]!);
    assert.ok(cFail);
    assert.equal(cFail?.status, "blocked", "campaign is blocked truthfully");
    assert.ok(cFail?.waves[0]!.rejectReason?.includes("unavailable"), "reject reason records model failure");
    assert.equal(cFail?.waves[0]!.jobId, null, "no job was dispatched");

    // 2. Unavailable model with fallback enabled: uses fallback model
    const p2 = { workspaceKey: "ws-m-fallback", workspacePath: "C:\\pmfb", projectName: "MProjFallback" };
    const resFallback = await h.audits.createBatch({
      projects: [p2],
      planOnly: false,
      modelPolicy: {
        defaultModel: "unavailable-provider/bad-model",
        allowFallback: true,
        fallbackModel: "default",
      },
    });

    const cFallback = await h.audits.getCampaign(resFallback.batch.campaignIds[0]!);
    assert.ok(cFallback);
    assert.equal(cFallback?.status, "running", "campaign runs on fallback model");
    assert.equal(cFallback?.modelIdentity, "unavailable-provider/bad-model", "requested model recorded");
    assert.equal(cFallback?.effectiveModelIdentity, "default", "effective fallback model recorded");
    assert.ok(cFallback?.waves[0]!.jobId, "job dispatched for fallback worker");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch: admission locks memory remains bounded after settlement", async () => {
  const h = await createBatchHarness();
  try {
    const projects = [{ workspaceKey: "ws-lock", workspacePath: "C:\\plock", projectName: "LockProj" }];
    for (let i = 0; i < 10; i++) {
      await h.audits.createBatch({
        requestId: `req-bounded-lock-${i}`,
        projects,
        planOnly: true,
      });
    }

    // Access private batchAdmissionLocks via reflection
    const locksMap = (h.audits as unknown as { batchAdmissionLocks: Map<string, unknown> }).batchAdmissionLocks;
    assert.equal(locksMap.size, 0, "all settled admission locks were deleted from memory");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch DEFECT A1: pause during in-flight admission preserves PAUSED and prevents dispatch", async () => {
  const h = await createBatchHarness();
  try {
    const projects = [
      { workspaceKey: "p1", workspacePath: "C:\\p1", projectName: "Project 1" },
      { workspaceKey: "p2", workspacePath: "C:\\p2", projectName: "Project 2" },
      { workspaceKey: "p3", workspacePath: "C:\\p3", projectName: "Project 3" },
      { workspaceKey: "p4", workspacePath: "C:\\p4", projectName: "Project 4" },
      { workspaceKey: "p5", workspacePath: "C:\\p5", projectName: "Project 5" },
    ];

    let generatedCount = 0;
    const origGenerate = (h.audits as unknown as { generate: (...args: unknown[]) => Promise<unknown> }).generate.bind(h.audits);
    (h.audits as unknown as { generate: (...args: unknown[]) => Promise<unknown> }).generate = async (...args: unknown[]) => {
      const res = await origGenerate(...args);
      generatedCount++;
      if (generatedCount === 2) {
        const batchId = (args[2] as { batchId?: string } | undefined)?.batchId;
        if (batchId) {
          await h.audits.pauseBatch(batchId);
        }
      }
      return res;
    };

    const res = await h.audits.createBatch({
      projects,
      planOnly: false,
    });

    assert.equal(res.batch.status, "paused", "batch status remains paused despite createBatch continuation");
    const loaded = await h.audits.getBatch(res.batch.batchId);
    assert.equal(loaded?.status, "paused", "persisted batch remains paused");

    assert.equal(res.batch.campaignIds.length, 2, "only 2 campaigns created before pause interrupted");
    const pendingCount = res.batch.projects.filter((p) => p.status === "pending").length;
    assert.equal(pendingCount, 3, "3 remaining projects stay pending");

    const restartAudits = new ZaicodeAuditService({
      jobService: h.jobService,
      agentService: h.agentService,
      rootDir: () => h.auditRoot,
    });

    const restartedBatch = await restartAudits.getBatch(res.batch.batchId);
    assert.equal(restartedBatch?.status, "paused", "batch remains paused across host restart");
    assert.equal(restartedBatch?.campaignIds.length, 2, "no unadmitted campaigns created during restart reconciliation");

    const resumed = await restartAudits.resumeBatch(res.batch.batchId);
    assert.equal(resumed?.status, "running", "resumed batch is running");
    assert.equal(resumed?.campaignIds.length, 5, "all 5 campaigns admitted and working after resume");
    assert.ok(resumed?.projects.every((p) => p.status === "admitted"), "all 5 projects now admitted");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch DEFECT A2: reconciliation preserves PAUSED and CANCELLED without resurrecting work", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "p1", workspacePath: "C:\\p1", projectName: "Project 1" };
    const p2 = { workspaceKey: "p2", workspacePath: "C:\\p2", projectName: "Project 2" };

    const batchId = "batch-paused-reconcile";
    const batchFile = join(h.auditRoot, "batches", `${batchId}.json`);
    mkdirSync(join(h.auditRoot, "batches"), { recursive: true });

    const c1 = await (h.audits as unknown as { generate: (...args: unknown[]) => Promise<{ campaignId: string }> }).generate(
      p1,
      undefined,
      { batchId, batchAutoWaves: true },
    );
    assert.ok(c1);

    const pausedBatch: ZaicodeAuditBatch = {
      schemaVersion: 1,
      batchId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requestProvenance: "operator_ui",
      profileId: "zaicode-audit",
      profileVersion: "1.0",
      manifestHash: "hash",
      planOnly: false,
      autoWaves: true,
      workerCapacity: 4,
      modelPolicy: {},
      projects: [
        { ...p1, campaignId: c1.campaignId, status: "admitted" },
        { ...p2, campaignId: null, status: "pending" },
      ],
      campaignIds: [c1.campaignId],
      status: "paused",
    };
    writeFileSync(batchFile, JSON.stringify(pausedBatch, null, 2), "utf8");

    const reconciledPaused = await h.audits.getBatch(batchId);
    assert.equal(reconciledPaused?.status, "paused", "paused batch remains paused");
    assert.equal(reconciledPaused?.campaignIds.length, 1, "does not generate missing campaign for p2 while paused");
    assert.equal(reconciledPaused?.projects[1]?.status, "pending", "p2 remains pending");

    const cancelledId = "batch-cancelled-reconcile";
    const cancelledFile = join(h.auditRoot, "batches", `${cancelledId}.json`);
    const cancelledBatch: ZaicodeAuditBatch = {
      ...pausedBatch,
      batchId: cancelledId,
      status: "cancelled",
    };
    writeFileSync(cancelledFile, JSON.stringify(cancelledBatch, null, 2), "utf8");

    const reconciledCancelled = await h.audits.getBatch(cancelledId);
    assert.equal(reconciledCancelled?.status, "cancelled", "cancelled batch remains cancelled");
    assert.equal(reconciledCancelled?.campaignIds.length, 1, "cancelled batch never resurrects missing campaigns");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch DEFECT A3: terminal status is PARTIAL when selected projects are rejected or blocked", async () => {
  const h = await createBatchHarness();
  try {
    const projects = [
      { workspaceKey: "p1", workspacePath: "C:\\p1", projectName: "Project 1" },
      { workspaceKey: "p2", workspacePath: "C:\\p2", projectName: "Project 2" },
      { workspaceKey: "p3", workspacePath: "C:\\p3", projectName: "Project 3" },
      { workspaceKey: "p4", workspacePath: "C:\\p4", projectName: "Project 4" },
      { workspaceKey: "", workspacePath: "", projectName: "Bad Project 5" },
    ];

    const result = await h.audits.createBatch({
      projects,
      planOnly: true,
    });

    assert.equal(result.admittedCount, 4);
    assert.equal(result.rejectedCount, 1);
    assert.equal(result.batch.campaignIds.length, 4);

    for (const cid of result.batch.campaignIds) {
      const camp = await h.audits.getCampaign(cid);
      assert.ok(camp);
      camp.status = "complete";
      (h.audits as unknown as { saveCampaign: (c: unknown) => void }).saveCampaign(camp);
    }

    const terminalBatch = await h.audits.getBatch(result.batch.batchId);
    assert.ok(terminalBatch);

    assert.equal(terminalBatch?.status, "partial", "batch status is partial when some projects were rejected");
    assert.ok(terminalBatch?.completedAt, "completedAt is recorded for partial batch");

    const rejectedProj = terminalBatch?.projects.find((p) => p.projectName === "Bad Project 5");
    assert.ok(rejectedProj);
    assert.equal(rejectedProj?.status, "rejected");
    assert.equal(rejectedProj?.reason, "Missing workspaceKey or workspacePath");

    const cleanResult = await h.audits.createBatch({
      projects: projects.slice(0, 4),
      planOnly: true,
    });
    for (const cid of cleanResult.batch.campaignIds) {
      const camp = await h.audits.getCampaign(cid);
      assert.ok(camp);
      camp.status = "complete";
      (h.audits as unknown as { saveCampaign: (c: unknown) => void }).saveCampaign(camp);
    }
    const cleanTerminal = await h.audits.getBatch(cleanResult.batch.batchId);
    assert.equal(cleanTerminal?.status, "complete", "batch is complete when all admitted projects complete with no rejections");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-280:R001: CAS lifecycle revision prevents stale resume continuation from overriding newer pause or stop", async () => {
  const h = await createBatchHarness();
  try {
    const projects = [
      { workspaceKey: "p1", workspacePath: "C:\\p1", projectName: "Project 1" },
      { workspaceKey: "p2", workspacePath: "C:\\p2", projectName: "Project 2" },
      { workspaceKey: "p3", workspacePath: "C:\\p3", projectName: "Project 3" },
      { workspaceKey: "p4", workspacePath: "C:\\p4", projectName: "Project 4" },
      { workspaceKey: "p5", workspacePath: "C:\\p5", projectName: "Project 5" },
    ];

    // 1. Create a five-project batch as planned
    const created = await h.audits.createBatch({
      projects,
      planOnly: true,
    });
    assert.equal(created.batch.status, "planned");
    const batchId = created.batch.batchId;

    // 2. Pause the batch
    const paused = await h.audits.pauseBatch(batchId);
    assert.equal(paused?.status, "paused");
    const initialRev = paused?.lifecycleRevision ?? 1;

    // 3. Begin Resume with delayed generation after the first project
    let releaseGate: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let genCount = 0;
    const origGenerate = (h.audits as unknown as { generate: (...args: unknown[]) => Promise<unknown> }).generate.bind(h.audits);
    (h.audits as unknown as { generate: (...args: unknown[]) => Promise<unknown> }).generate = async (...args: unknown[]) => {
      genCount++;
      if (genCount === 1) {
        // First generation proceeds normally
        return origGenerate(...args);
      }
      if (genCount === 2) {
        // Second generation blocks until gate is released
        await gatePromise;
        return origGenerate(...args);
      }
      return origGenerate(...args);
    };

    // Mark p2..p5 as pending so resumeBatch will attempt generation
    const currentBatch = (await h.audits.getBatch(batchId))!;
    for (let i = 1; i < currentBatch.projects.length; i++) {
      currentBatch.projects[i].status = "pending";
      currentBatch.projects[i].campaignId = null;
    }
    currentBatch.campaignIds = [currentBatch.projects[0].campaignId!];
    (h.audits as unknown as { saveBatch: (b: unknown) => void }).saveBatch(currentBatch);

    // Launch resumeBatch asynchronously
    const resumePromise = h.audits.resumeBatch(batchId);

    // Yield to let resumeBatch start and block in the second generate
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 5. Issue Pause again while resumeBatch is blocked in generation
    const pausedAgain = await h.audits.pauseBatch(batchId);
    assert.equal(pausedAgain?.status, "paused");
    assert.ok((pausedAgain?.lifecycleRevision ?? 0) > initialRev, "lifecycle revision incremented on pause");

    // 6. Release the delayed generation
    releaseGate!();
    const resumeResult = await resumePromise;

    // 7. Verify PAUSED remains authoritative
    assert.equal(resumeResult?.status, "paused", "stale resume aborted and returned paused batch");
    const durableAfterResume = await h.audits.getBatch(batchId);
    assert.equal(durableAfterResume?.status, "paused", "durable status on disk remains paused");

    // 8. Now repeat scenario with STOP / CANCELLED
    // Reset p2..p5 to pending so resumeBatch will attempt generation and block
    const batchForStop = (await h.audits.getBatch(batchId))!;
    for (let i = 1; i < batchForStop.projects.length; i++) {
      batchForStop.projects[i].status = "pending";
      batchForStop.projects[i].campaignId = null;
    }
    batchForStop.campaignIds = [batchForStop.projects[0].campaignId!];
    batchForStop.status = "paused";
    (h.audits as unknown as { saveBatch: (b: unknown) => void }).saveBatch(batchForStop);

    let stopReleaseGate: () => void;
    const stopGatePromise = new Promise<void>((resolve) => {
      stopReleaseGate = resolve;
    });
    genCount = 0;
    (h.audits as unknown as { generate: (...args: unknown[]) => Promise<unknown> }).generate = async (...args: unknown[]) => {
      genCount++;
      if (genCount === 1) {
        await stopGatePromise;
      }
      return origGenerate(...args);
    };

    const stopResumePromise = h.audits.resumeBatch(batchId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Issue Stop while resume is blocked
    const stopped = await h.audits.stopBatch(batchId);
    assert.equal(stopped?.status, "cancelled", "batch is cancelled by stopBatch");

    // Release delayed generation
    stopReleaseGate!();
    const stopResumeResult = await stopResumePromise;

    // 10. Verify CANCELLED remains authoritative
    assert.equal(stopResumeResult?.status, "cancelled", "stale resume aborted on cancelled batch");
    const durableAfterStop = await h.audits.getBatch(batchId);
    assert.equal(durableAfterStop?.status, "cancelled", "durable state remains cancelled");

    // 11. Attempting resume on cancelled batch must not revive it
    const revived = await h.audits.resumeBatch(batchId);
    assert.equal(revived?.status, "cancelled", "cancelled batch cannot be resumed");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-280:R002: idempotent createBatch retry during admitting adopts existing campaigns without duplicate generation", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "p1", workspacePath: "C:\\p1", projectName: "Project 1" };
    const p2 = { workspaceKey: "p2", workspacePath: "C:\\p2", projectName: "Project 2" };
    const p3 = { workspaceKey: "p3", workspacePath: "C:\\p3", projectName: "Project 3" };
    const p4 = { workspaceKey: "p4", workspacePath: "C:\\p4", projectName: "Project 4" };
    const p5 = { workspaceKey: "p5", workspacePath: "C:\\p5", projectName: "Project 5" };
    const projects = [p1, p2, p3, p4, p5];
    const requestId = "req-idempotent-adopt-test";

    // 1. Persist a five-project batch in ADMITTING status with partial unwritten campaign associations
    const batchId = "batch-admit-recovery-1";
    const campA = await h.audits.generate(p1, undefined, { batchId });
    const campB = await h.audits.generate(p2, undefined, { batchId });
    assert.ok(campA);
    assert.ok(campB);

    // Simulate campA having already completed before admission recovery
    campA!.status = "complete";
    (h.audits as unknown as { saveCampaign: (c: unknown) => void }).saveCampaign(campA);

    const initialBatch: ZaicodeAuditBatch = {
      schemaVersion: 1,
      batchId,
      requestId,
      contentFingerprint: null,
      lifecycleRevision: 1,
      operatorActionId: requestId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requestProvenance: "operator_ui",
      profileId: "quick3-audit",
      profileVersion: "1.0.0",
      manifestHash: "hash-test",
      planOnly: true,
      autoWaves: true,
      workerCapacity: 4,
      modelPolicy: {},
      projects: [
        { workspaceKey: "p1", workspacePath: "C:\\p1", projectName: "Project 1", campaignId: campA!.campaignId, status: "admitted" },
        { workspaceKey: "p2", workspacePath: "C:\\p2", projectName: "Project 2", campaignId: null, status: "pending" }, // partially unwritten
        { workspaceKey: "p3", workspacePath: "C:\\p3", projectName: "Project 3", campaignId: null, status: "pending" },
        { workspaceKey: "p4", workspacePath: "C:\\p4", projectName: "Project 4", campaignId: null, status: "pending" },
        { workspaceKey: "p5", workspacePath: "C:\\p5", projectName: "Project 5", campaignId: null, status: "pending" },
      ],
      campaignIds: [campA!.campaignId], // campB not yet recorded in batch.campaignIds
      status: "admitting",
      startedAt: null,
    };
    (h.audits as unknown as { saveBatch: (b: unknown) => void }).saveBatch(initialBatch);

    // Track generate calls to ensure A and B are NOT re-generated
    const generatedWorkspaceKeys: string[] = [];
    const origGenerate = (h.audits as unknown as { generate: (...args: unknown[]) => Promise<unknown> }).generate.bind(h.audits);
    (h.audits as unknown as { generate: (...args: unknown[]) => Promise<unknown> }).generate = async (...args: unknown[]) => {
      const proj = args[0] as { workspaceKey: string };
      generatedWorkspaceKeys.push(proj.workspaceKey);
      return origGenerate(...args);
    };

    // 5. Retry createBatch with the same requestId
    const retryResult = await h.audits.createBatch({
      requestId,
      projects,
      planOnly: true,
    });

    // 6. Verify five original projects remain
    assert.equal(retryResult.batch.projects.length, 5, "5 projects remain");
    assert.equal(retryResult.batch.batchId, batchId, "original batch ID preserved");

    // 7. Verify A and B are adopted
    assert.ok(retryResult.batch.campaignIds.includes(campA!.campaignId), "campA adopted");
    assert.ok(retryResult.batch.campaignIds.includes(campB!.campaignId), "campB adopted");

    // 8. Verify no extra campaigns generated for A or B
    assert.ok(!generatedWorkspaceKeys.includes("p1"), "campA was not re-generated");
    assert.ok(!generatedWorkspaceKeys.includes("p2"), "campB was adopted by lineage without re-generation");
    assert.ok(generatedWorkspaceKeys.includes("p3"), "p3 was generated");
    assert.ok(generatedWorkspaceKeys.includes("p4"), "p4 was generated");
    assert.ok(generatedWorkspaceKeys.includes("p5"), "p5 was generated");

    // 9. Verify campA remains complete and valid
    const loadedA = await h.audits.getCampaign(campA!.campaignId);
    assert.equal(loadedA?.status, "complete", "completed campaign A remains complete");

    // 10. Verify all 5 projects are admitted in the final reconciled batch
    assert.equal(retryResult.admittedCount, 5, "all 5 projects admitted");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-280:R004: canDispatchJob fails closed on orphaned batch jobs", async () => {
  const h = await createBatchHarness();
  try {
    const canDispatch = (job: unknown) =>
      (h.audits as unknown as { canDispatchJob: (j: unknown) => Promise<boolean> }).canDispatchJob(job);

    // 1. Orphan job with non-existent campaign and declared batchId
    const orphanJob1 = {
      id: "job-orphan-1",
      title: "Core wave audit",
      workspaceKey: "ws-orphan",
      auditMetadata: {
        campaignId: "camp-nonexistent",
        waveId: "core",
        attempt: 0,
        batchId: "batch-orphan",
      },
    };
    const canDispatchOrphan1 = await canDispatch(orphanJob1);
    assert.equal(canDispatchOrphan1, false, "orphan batch job refused dispatch when campaign is missing");

    // 2. Orphan job where campaign exists but parent batch is missing from disk
    const standaloneCamp = await h.audits.generate({
      workspaceKey: "ws-standalone",
      workspacePath: "C:\\standalone",
      projectName: "Standalone",
    }, undefined, { batchId: "missing-batch-999" });
    assert.ok(standaloneCamp);

    const orphanJob2 = {
      id: "job-orphan-2",
      title: `[${standaloneCamp!.campaignId}#1] Core wave`,
      workspaceKey: "ws-standalone",
      auditMetadata: {
        campaignId: standaloneCamp!.campaignId,
        waveId: "core",
        attempt: 0,
        batchId: "missing-batch-999",
      },
    };
    const canDispatchOrphan2 = await canDispatch(orphanJob2);
    assert.equal(canDispatchOrphan2, false, "orphan batch job refused dispatch when parent batch is missing from disk");

    // 3. Valid batch-owned job with running batch
    const p1 = { workspaceKey: "ws-valid", workspacePath: "C:\\valid", projectName: "Valid" };
    const batchRes = await h.audits.createBatch({
      projects: [p1],
      planOnly: false,
    });
    const validCampId = batchRes.batch.campaignIds[0];
    assert.ok(validCampId);

    const validJob = {
      id: "job-valid-1",
      title: `[${validCampId}#1] Core wave`,
      workspaceKey: "ws-valid",
      auditMetadata: {
        campaignId: validCampId,
        waveId: "core",
        attempt: 0,
        batchId: batchRes.batch.batchId,
      },
    };
    const canDispatchValid = await canDispatch(validJob);
    assert.equal(canDispatchValid, true, "valid batch job is dispatched when batch is running");

    // 4. Pausing the batch refuses dispatch
    await h.audits.pauseBatch(batchRes.batch.batchId);
    const canDispatchPaused = await canDispatch(validJob);
    assert.equal(canDispatchPaused, false, "batch job dispatch refused when batch is paused");

    // 5. Standalone audit job without batchId is permitted
    const pureStandaloneCamp = await h.audits.generate({
      workspaceKey: "ws-pure-standalone",
      workspacePath: "C:\\pure-standalone",
      projectName: "Pure Standalone",
    });
    assert.ok(pureStandaloneCamp);
    const standaloneJob = {
      id: "job-standalone-1",
      title: `[${pureStandaloneCamp!.campaignId}#1] Core wave`,
      workspaceKey: "ws-pure-standalone",
      auditMetadata: {
        campaignId: pureStandaloneCamp!.campaignId,
        waveId: "core",
        attempt: 0,
      },
    };
    const canDispatchPure = await canDispatch(standaloneJob);
    assert.equal(canDispatchPure, true, "pure standalone audit job without batchId is permitted");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-280:R005: complete request fingerprint detects changed project workspacePath on same requestId", async () => {
  const h = await createBatchHarness();
  try {
    const requestId = "req-fingerprint-conflict-test";
    const initialProjects = [
      { workspaceKey: "ws-key-1", workspacePath: "C:\\original-path", projectName: "Project 1" },
    ];

    // Initial batch created with original path
    const initial = await h.audits.createBatch({
      requestId,
      projects: initialProjects,
      planOnly: true,
    });
    assert.ok(initial.batch);

    // Same requestId with different workspacePath for the same workspaceKey
    const modifiedProjects = [
      { workspaceKey: "ws-key-1", workspacePath: "C:\\changed-path-different", projectName: "Project 1" },
    ];

    await assert.rejects(
      async () => {
        await h.audits.createBatch({
          requestId,
          projects: modifiedProjects,
          planOnly: true,
        });
      },
      /Request conflict: requestId 'req-fingerprint-conflict-test' already exists with different project content/,
      "conflict detected when project path changes for same requestId",
    );
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-281:R001: truthful termination lifecycle and stopDetails reporting", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-stop-1", workspacePath: "C:\\stop1", projectName: "Stop1" };
    const p2 = { workspaceKey: "ws-stop-2", workspacePath: "C:\\stop2", projectName: "Stop2" };

    const batchRes = await h.audits.createBatch({
      projects: [p1, p2],
      planOnly: false,
    });
    const batchId = batchRes.batch.batchId;
    assert.equal(batchRes.batch.campaignIds.length, 2);
    const camp1Id = batchRes.batch.campaignIds[0];
    const camp2Id = batchRes.batch.campaignIds[1];

    // Case 1: Partial stop when one campaign cancel fails / returns still active
    const originalCancel = h.audits.cancel.bind(h.audits);
    h.audits.cancel = async (cId: string) => {
      if (cId === camp2Id) {
        const c = await h.audits.getCampaign(cId);
        return c ? { ...c, status: "running" } : null;
      }
      return originalCancel(cId);
    };

    const stoppedPartial = await h.audits.stopBatch(batchId);
    assert.ok(stoppedPartial);
    assert.equal(stoppedPartial?.status, "stop_partial", "batch marked stop_partial when a campaign fails to cancel");
    assert.ok(stoppedPartial?.stopDetails);
    assert.deepEqual(stoppedPartial?.stopDetails?.stoppedCampaignIds, [camp1Id]);
    assert.deepEqual(stoppedPartial?.stopDetails?.failedCampaignIds, [camp2Id]);

    // Case 2: Clean stop when all campaigns cancel
    h.audits.cancel = originalCancel;
    const batchResClean = await h.audits.createBatch({
      projects: [{ workspaceKey: "ws-stop-clean", workspacePath: "C:\\stop-clean", projectName: "StopClean" }],
      planOnly: false,
    });
    const cleanId = batchResClean.batch.batchId;
    const cleanStopped = await h.audits.stopBatch(cleanId);
    assert.ok(cleanStopped);
    assert.equal(cleanStopped?.status, "cancelled", "clean stop transitions batch to cancelled");
    assert.ok(cleanStopped?.completedAt, "completedAt recorded on cancelled batch");
    assert.equal(cleanStopped?.stopDetails?.failedCampaignIds.length, 0);
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-281:R003: strict lineage and attempt validation in canDispatchJob", async () => {
  const h = await createBatchHarness();
  try {
    const canDispatch = (job: unknown) =>
      (h.audits as unknown as { canDispatchJob: (j: unknown) => Promise<boolean> }).canDispatchJob(job);

    const p1 = { workspaceKey: "ws-lineage-1", workspacePath: "C:\\lineage1", projectName: "Lineage1" };
    const batchRes = await h.audits.createBatch({
      projects: [p1],
      planOnly: false,
    });
    const campId = batchRes.batch.campaignIds[0];
    const camp = await h.audits.getCampaign(campId);
    assert.ok(camp);
    assert.ok(camp.waves.length > 0);
    const wave = camp.waves[0];

    // Valid job with full lineage agreement
    const validJob = {
      id: "job-lineage-valid",
      title: `[${campId}#${wave.waveNumber}] ${wave.title}`,
      workspaceKey: p1.workspaceKey,
      workspacePath: p1.workspacePath,
      auditMetadata: {
        campaignId: campId,
        waveId: wave.waveId,
        attempt: wave.attempt,
        batchId: batchRes.batch.batchId,
      },
    };
    assert.equal(await canDispatch(validJob), true, "valid lineage job allowed");

    // Lineage failure 1: attempt mismatch (stale retried job)
    const staleJob = {
      ...validJob,
      id: "job-lineage-stale",
      auditMetadata: {
        ...validJob.auditMetadata,
        attempt: wave.attempt + 1,
      },
    };
    assert.equal(await canDispatch(staleJob), false, "stale attempt job rejected");

    // Lineage failure 2: waveId does not exist in campaign
    const nonExistentWaveJob = {
      ...validJob,
      id: "job-lineage-badwave",
      auditMetadata: {
        ...validJob.auditMetadata,
        waveId: "non-existent-wave-99",
      },
    };
    assert.equal(await canDispatch(nonExistentWaveJob), false, "non-existent wave rejected");

    // Lineage failure 3: workspacePath mismatch
    const badPathJob = {
      ...validJob,
      id: "job-lineage-badpath",
      workspacePath: "C:\\wrong-path",
    };
    assert.equal(await canDispatch(badPathJob), false, "mismatched workspacePath rejected");

    // Lineage failure 4: workspaceKey mismatch
    const badKeyJob = {
      ...validJob,
      id: "job-lineage-badkey",
      workspaceKey: "ws-wrong-key",
    };
    assert.equal(await canDispatch(badKeyJob), false, "mismatched workspaceKey rejected");

    // Lineage failure 5: campaign not admitted in batch
    const unadmittedBatchJob = {
      ...validJob,
      id: "job-lineage-unadmitted",
      auditMetadata: {
        ...validJob.auditMetadata,
        batchId: "other-batch-id",
      },
    };
    assert.equal(await canDispatch(unadmittedBatchJob), false, "job with foreign batchId rejected");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-281:R004: authoritative worker projections with batchId, campaignId, generation", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-worker-1", workspacePath: "C:\\worker1", projectName: "Worker1" };
    const batchRes = await h.audits.createBatch({
      projects: [p1],
      planOnly: false,
    });
    const campId = batchRes.batch.campaignIds[0];
    const camp = await h.audits.getCampaign(campId);
    assert.ok(camp);
    const wave = camp.waves[0];
    assert.ok(wave.jobId);

    const workers = await h.audits.getActiveWorkers();
    assert.equal(workers.length, 1, "1 worker projected");
    const w = workers[0];
    assert.equal(w.batchId, batchRes.batch.batchId, "worker carries batchId");
    assert.equal(w.campaignId, campId, "worker carries campaignId");
    assert.equal(w.jobId, wave.jobId, "worker carries jobId");
    assert.equal(w.generation, wave.attempt ?? 1, "worker carries execution generation");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-281:R005: authoritative aggregated batch stats for large batch (40 projects)", async () => {
  const h = await createBatchHarness();
  try {
    const projects = Array.from({ length: 40 }, (_, i) => ({
      workspaceKey: `ws-large-${i}`,
      workspacePath: `C:\\large\\project-${i}`,
      projectName: `Project ${i}`,
    }));

    const batchRes = await h.audits.createBatch({
      projects,
      planOnly: false,
    });
    assert.equal(batchRes.admittedCount, 40);
    assert.ok(batchRes.batch.stats, "batch.stats computed on creation");
    assert.equal(batchRes.batch.stats?.totalProjects, 40);
    assert.equal(batchRes.batch.stats?.admittedCount, 40);
    assert.equal(batchRes.batch.stats?.runningCount, 40);
    assert.equal(batchRes.batch.stats?.completedCount, 0);

    // Complete 10 campaigns, block 5 campaigns
    for (let i = 0; i < 10; i++) {
      const camp = await h.audits.getCampaign(batchRes.batch.campaignIds[i]);
      if (camp) {
        camp.status = "complete";
        (h.audits as unknown as { saveCampaign: (c: unknown) => void }).saveCampaign(camp);
      }
    }
    for (let i = 10; i < 15; i++) {
      const camp = await h.audits.getCampaign(batchRes.batch.campaignIds[i]);
      if (camp) {
        camp.status = "blocked";
        (h.audits as unknown as { saveCampaign: (c: unknown) => void }).saveCampaign(camp);
      }
    }

    // Reconcile batch
    const reconciled = await h.audits.getBatch(batchRes.batch.batchId);
    assert.ok(reconciled?.stats);
    assert.equal(reconciled?.stats?.totalProjects, 40);
    assert.equal(reconciled?.stats?.admittedCount, 40);
    assert.equal(reconciled?.stats?.completedCount, 10, "10 completed campaigns reflected in authoritative stats");
    assert.equal(reconciled?.stats?.blockedCount, 5, "5 blocked campaigns reflected in authoritative stats");
    assert.equal(reconciled?.stats?.runningCount, 25, "25 remaining running campaigns in authoritative stats");
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-282:R001: stopping reconciliation tracks confirmed Host execution state and preserves stop_partial/stop_failed across restarts", async () => {
  const h = await createBatchHarness();
  try {
    const p1 = { workspaceKey: "ws-r1-1", workspacePath: "C:\\r1-1", projectName: "R1Project1" };
    const p2 = { workspaceKey: "ws-r1-2", workspacePath: "C:\\r1-2", projectName: "R1Project2" };

    const batchRes = await h.audits.createBatch({
      projects: [p1, p2],
      planOnly: false,
    });
    const batchId = batchRes.batch.batchId;
    const [camp1Id, camp2Id] = batchRes.batch.campaignIds;

    // Simulate delayed cancellation for camp2: cancel succeeds for camp1, but camp2 wave job stays running in jobService
    const camp2 = await h.audits.getCampaign(camp2Id!);
    const camp2JobId = camp2!.waves[0]!.jobId!;
    assert.ok(camp2JobId);

    // Hold camp2 worker job so it remains running in jobService while cancellation succeeds at campaign level
    const origCancel = h.audits.cancel.bind(h.audits);
    let holdJob = true;
    h.audits.cancel = async (cId: string) => {
      if (cId === camp2Id && holdJob) {
        // Campaign acknowledges stop intent, but host worker in jobService is still active
        const c = await h.audits.getCampaign(cId);
        return c ? { ...c, status: "cancelled" } : null;
      }
      return origCancel(cId);
    };

    const stoppingBatch = await h.audits.stopBatch(batchId);
    assert.ok(stoppingBatch);
    assert.equal(stoppingBatch.status, "stopping", "STOPPING remains nonterminal while owned job is active");

    // Reconciliation during routine getBatch or listBatches MUST keep stopping nonterminal
    const duringReconcile = await h.audits.getBatch(batchId);
    assert.equal(duringReconcile?.status, "stopping", "reconcileBatch maintains STOPPING while job is active");

    // Simulate crash and restart: create fresh service instance pointing to same storage
    const restartedAudits = new ZaicodeAuditService({
      jobService: h.jobService,
      agentService: h.agentService,
      rootDir: () => h.auditRoot,
    });
    const recoveredBatch = await restartedAudits.getBatch(batchId);
    assert.equal(recoveredBatch?.status, "stopping", "crash restart preserves STOPPING state");

    // Now release hold and terminate remaining job and campaign
    holdJob = false;
    await restartedAudits.cancel(camp2Id);
    await h.jobService.cancel(camp2JobId);
    const finalized = await restartedAudits.getBatch(batchId);
    assert.equal(finalized?.status, "cancelled", "transitions to cancelled once all owned jobs terminate");
    assert.ok(finalized?.completedAt);

    // Test preservation of stop_partial: once marked stop_partial, routine reconciliation never overwrites it
    const batchPartialRes = await restartedAudits.createBatch({
      projects: [
        { workspaceKey: "ws-p-1", workspacePath: "C:\\p-1", projectName: "P1" },
        { workspaceKey: "ws-p-2", workspacePath: "C:\\p-2", projectName: "P2" },
      ],
      planOnly: false,
    });
    const partialBatchId = batchPartialRes.batch.batchId;
    const [, p2CampId] = batchPartialRes.batch.campaignIds;

    // Fail cancel for p2
    const prevCancel = restartedAudits.cancel.bind(restartedAudits);
    restartedAudits.cancel = async (cId: string) => {
      if (cId === p2CampId) {
        const c = await restartedAudits.getCampaign(cId);
        return c ? { ...c, status: "blocked" } : null;
      }
      return prevCancel(cId);
    };

    const stoppedPartial = await restartedAudits.stopBatch(partialBatchId);
    assert.equal(stoppedPartial?.status, "stop_partial", "stopBatch sets stop_partial when a campaign fails to cancel");

    const preservedPartial = await restartedAudits.getBatch(partialBatchId);
    assert.equal(preservedPartial?.status, "stop_partial", "getBatch/reconcile preserves stop_partial and does not overwrite to cancelled");

    const listedBatches = await restartedAudits.listBatches();
    const batchInList = listedBatches.find((b) => b.batchId === partialBatchId);
    assert.equal(batchInList?.status, "stop_partial", "listBatches preserves stop_partial");
    restartedAudits.dispose();
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-282:R002: atomic capacity reservation prevents oversubscription races across pump, pumpAll, and direct dispatch", async () => {
  const h = await createBatchHarness();
  try {
    // Set global concurrency to 3
    await h.jobService.setGlobalConcurrency(3);
    assert.equal(await h.jobService.getGlobalConcurrency(), 3);

    // Create batch with capacity = 2 across 4 projects
    const projects = Array.from({ length: 4 }, (_, i) => ({
      workspaceKey: `ws-cap-${i}`,
      workspacePath: `C:\\cap\\p${i}`,
      projectName: `CapP${i}`,
    }));

    const batchRes = await h.audits.createBatch({
      projects,
      planOnly: false,
      workerCapacity: 2,
    });
    const batchId = batchRes.batch.batchId;

    // Collect all created wave jobs
    const jobsToDispatch: string[] = [];
    for (const cId of batchRes.batch.campaignIds) {
      const camp = await h.audits.getCampaign(cId);
      if (camp?.waves[0]?.jobId) {
        jobsToDispatch.push(camp.waves[0].jobId);
      }
    }
    assert.equal(jobsToDispatch.length, 4);

    // Concurrently race direct dispatch, pump, and pumpAll simultaneously
    await Promise.all([
      h.jobService.dispatch(jobsToDispatch[0]!),
      h.jobService.dispatch(jobsToDispatch[1]!),
      h.jobService.dispatch(jobsToDispatch[2]!),
      h.jobService.dispatch(jobsToDispatch[3]!),
      h.jobService.pump("ws-cap-0"),
      h.jobService.pump("ws-cap-1"),
      h.jobService.pumpAll(),
    ]);

    // Check active workers for this batch: MUST NOT exceed batch workerCapacity (2)
    const workers = await h.audits.getActiveWorkers();
    const batchWorkers = workers.filter((w) => w.batchId === batchId);
    assert.ok(
      batchWorkers.length <= 2,
      `batch workers (${batchWorkers.length}) must not exceed batch workerCapacity (2)`,
    );

    // Global running jobs MUST NOT exceed globalConcurrency (3)
    const allRunning = await h.jobService.list({ status: "running" });
    assert.ok(
      allRunning.jobs.length <= 3,
      `global running jobs (${allRunning.jobs.length}) must not exceed globalConcurrency (3)`,
    );
  } finally {
    await h.dispose();
  }
});

test("Quick3 Batch SRC-282:R003 & R004: bounded reconciliation cost and indexed worker projections", async () => {
  const h = await createBatchHarness();
  try {
    const projects = Array.from({ length: 6 }, (_, i) => ({
      workspaceKey: `ws-cost-${i}`,
      workspacePath: `C:\\cost\\p${i}`,
      projectName: `CostP${i}`,
    }));

    const batchRes = await h.audits.createBatch({
      projects,
      planOnly: true,
    });
    const batchId = batchRes.batch.batchId;
    const batchFile = join(h.auditRoot, "batches", `${batchId}.json`);
    assert.ok(existsSync(batchFile));

    // Measure mtime of batch file
    const mtimeBefore = statSync(batchFile).mtimeMs;

    // Small delay to ensure timestamp resolution if modified
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Call listBatches() multiple times (routine UI refreshes)
    const list1 = await h.audits.listBatches();
    assert.equal(list1.length, 1);
    const list2 = await h.audits.listBatches();
    assert.equal(list2.length, 1);

    // File mtime MUST be unchanged (zero disk rewrites on steady-state reads)
    const mtimeAfter = statSync(batchFile).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, "routine listBatches must not rewrite unchanged batch files");

    // R004: worker lookup performance - getActiveWorkers projects directly from running jobs
    const workers = await h.audits.getActiveWorkers();
    assert.equal(workers.length, 0, "no running workers projected for planOnly batch");
  } finally {
    await h.dispose();
  }
});

