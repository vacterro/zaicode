import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import { ZaicodeAuditService } from "../src/zaicode/zaicodeAuditService.js";
import type { ZaicodeJobExecutor } from "../src/zaicode/zaicodeJobs.js";

// T-66 (SRC-049): AUDAPACK's A3 campaign machine on the ZAICODE queue.
// Generate-first (planned, no job), work (dispatch wave 1), the AUDAPACK wave
// gate (STATUS line + done marker), the SHA chain to the next wave, and smart
// mode (empty board + nothing running -> the project audits itself).

interface Harness {
  dir: string;
  auditRoot: string;
  agentService: ZaicodeAgentService;
  jobService: ZaicodeJobService;
  audits: ZaicodeAuditService;
  /** Reports the fake executor should write for a wave prompt, keyed by wave slug. */
  reports: Map<string, string>;
  dispose: () => Promise<void>;
}

const WS = { workspaceKey: "ws-1", workspacePath: "C:\\proj\\_ZAICODE", projectName: "_ZAICODE" };

/**
 * The executor writes the report file the wave prompt names, then completes the
 * job the way a real agent session does: after dispatch has attached the
 * session it reports the run outcome, which drives the job to `completed`.
 */
function makeExecutor(
  reports: Map<string, string>,
  writes: string[],
  getJobService: () => ZaicodeJobService,
): ZaicodeJobExecutor {
  return async ({ job }) => {
    const match = /Write the report EXACTLY to this file[^\n]*\n(.+)/.exec(job.instructions);
    const reportPath = match?.[1]?.trim();
    let hasBody = false;
    if (reportPath) {
      const slug = /__0\d_([A-Z_]+)\.md$/.exec(reportPath)?.[1] ?? "";
      const body = reports.get(slug) ?? "";
      if (body) {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(join(reportPath, ".."), { recursive: true });
        writeFileSync(reportPath, body, "utf8");
        writes.push(slug);
        hasBody = true;
      }
    }
    // Only a wave that produced a report completes; a wave with no configured
    // report stays running (mirrors a session still working) so tests that do
    // not care about completion tear down without racing a late DB write.
    if (hasBody) {
      const runId = job.runId ?? "";
      const attempt = job.attempt;
      setTimeout(() => {
        void getJobService()
          .reportRunOutcome({ jobId: job.id, runId, attempt, outcome: "succeeded", resultSummary: "audit wave done" })
          .catch(() => undefined);
      }, 0);
    }
    return { sessionId: `session-${job.id}` };
  };
}

async function createHarness(reports: Map<string, string>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-audit-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const auditRoot = join(dir, "audits");
  const agentRepo = new ZaicodeAgentRepo(dbPath, 500);
  const agentService = new ZaicodeAgentService({ repo: agentRepo });
  const jobRepo = new ZaicodeJobRepo(dbPath, 500);
  const writes: string[] = [];
  let jobServiceRef: ZaicodeJobService | null = null;
  const jobService = new ZaicodeJobService({
    repo: jobRepo,
    getAgent: (agentId) => agentService.get(agentId),
    getExecutor: () => makeExecutor(reports, writes, () => jobServiceRef!),
  });
  jobServiceRef = jobService;
  await jobService.ensureReady();
  await jobService.setAutoRun(true);
  const audits = new ZaicodeAuditService({ jobService, agentService, rootDir: () => auditRoot });
  return {
    dir,
    auditRoot,
    agentService,
    jobService,
    audits,
    reports,
    dispose: async () => {
      jobService.dispose();
      agentRepo.close();
      jobRepo.close();
      // Smart mode dispatches real wave jobs whose executor writes reports on a
      // later tick; let those settle so rm() does not race a concurrent write.
      await new Promise((resolve) => setTimeout(resolve, 30));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    },
  };
}

/** A report that passes the AUDAPACK gate for a given wave. */
function goodReport(statusKey: string, doneMarker: string): string {
  return ["# Findings", "| sev | file:line | what |", "", `STATUS: ${statusKey}: COMPLETE`, doneMarker, ""].join("\n");
}

const A3 = {
  core: { statusKey: "AUDIT_CORE", done: "AUDIT_CORE_DONE", slug: "AUDIT_CORE" },
  second: { statusKey: "AUDIT_SECOND", done: "AUDIT_SECOND_DONE", slug: "AUDIT_SECOND_WAVE" },
  performance: { statusKey: "AUDIT_PERFORMANCE", done: "AUDIT_PERFORMANCE_DONE", slug: "AUDIT_PERFORMANCE" },
} as const;

function allGood(): Map<string, string> {
  return new Map([
    [A3.core.slug, goodReport(A3.core.statusKey, A3.core.done)],
    [A3.second.slug, goodReport(A3.second.statusKey, A3.second.done)],
    [A3.performance.slug, goodReport(A3.performance.statusKey, A3.performance.done)],
  ]);
}

async function settle(): Promise<void> {
  // The executor runs on autopilot; give the microtask queue a couple of turns.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("generate is generate-first: planned, no job dispatched", async () => {
  const h = await createHarness(new Map());
  try {
    const campaign = await h.audits.generate(WS);
    assert.ok(campaign);
    assert.equal(campaign!.status, "planned");
    assert.equal(campaign!.workspaceKey, WS.workspaceKey);
    assert.equal(campaign!.waves.length, 3);
    assert.ok(campaign!.waves.every((wave) => wave.jobId === null));
    const jobs = await h.jobService.list({});
    assert.equal(jobs.jobs.length, 0, "a planned campaign dispatches nothing");
  } finally {
    await h.dispose();
  }
});

test("work dispatches wave 1 and the campaign starts running", async () => {
  const h = await createHarness(new Map());
  try {
    const planned = await h.audits.generate(WS);
    const worked = await h.audits.work(planned!.campaignId);
    assert.equal(worked!.status, "running");
    assert.equal(worked!.waves[0]!.status, "running");
    assert.ok(worked!.waves[0]!.jobId, "wave 1 has a queue job");
    const jobs = await h.jobService.list({});
    assert.equal(jobs.jobs.length, 1, "exactly one wave job exists");
  } finally {
    await h.dispose();
  }
});

test("full A3: three good reports chain to complete with the finalizer handoff", async () => {
  const h = await createHarness(allGood());
  try {
    const campaign = await h.audits.start(WS);
    let state = campaign!;
    // Reconcile drives each completed wave to the next (executor already wrote reports).
    for (let i = 0; i < 6 && state.status !== "complete"; i += 1) {
      await settle();
      const next = await h.audits.getState();
      state = next.campaigns.find((c) => c.campaignId === campaign!.campaignId)!;
    }
    assert.equal(state.status, "complete", `expected complete, got ${state.status}`);
    assert.ok(state.waves.every((wave) => wave.status === "complete"));
    assert.ok(state.waves.every((wave) => wave.resultSha256 && wave.resultSha256.length === 64));
    assert.ok(state.finalHandoffFile?.includes("AUDIT_PERFORMANCE"), "handoff is the finalizer wave report");
  } finally {
    await h.dispose();
  }
});

test("AUDAPACK gate: a report missing the STATUS line blocks the campaign", async () => {
  const reports = new Map([[A3.core.slug, "# Findings\nno machine lines here\n"]]);
  const h = await createHarness(reports);
  try {
    const campaign = await h.audits.start(WS);
    let state = campaign!;
    for (let i = 0; i < 4 && state.status === "running"; i += 1) {
      await settle();
      const next = await h.audits.getState();
      state = next.campaigns.find((c) => c.campaignId === campaign!.campaignId)!;
    }
    assert.equal(state.status, "blocked", "a partial wave blocks");
    assert.equal(state.waves[0]!.status, "partial");
    assert.equal(state.waves[1]!.jobId, null, "the second wave is never dispatched");
  } finally {
    await h.dispose();
  }
});

test("cancel stops a running campaign and its wave job", async () => {
  const h = await createHarness(new Map());
  try {
    const campaign = await h.audits.start(WS);
    const cancelled = await h.audits.cancel(campaign!.campaignId);
    assert.equal(cancelled!.status, "cancelled");
  } finally {
    await h.dispose();
  }
});

test("SRC-058: a reconcile queued behind cancel does not turn the cancelled campaign into blocked", async () => {
  const h = await createHarness(new Map());
  try {
    const campaign = await h.audits.start(WS);
    // The poller's getState() snapshots every campaign before it takes the
    // campaign's lock. Issued right after cancel(), it waits for that lock
    // while holding the pre-cancel "running" copy.
    const cancelling = h.audits.cancel(campaign!.campaignId);
    const polling = h.audits.getState();
    await Promise.all([cancelling, polling]);
    const stored = JSON.parse(
      await readFile(join(h.auditRoot, campaign!.campaignId, "campaign.json"), "utf8"),
    ) as { status: string };
    assert.equal(stored.status, "cancelled");
  } finally {
    await h.dispose();
  }
});

test("SRC-060: getState says who audits, on which model, and where the running wave is", async () => {
  const h = await createHarness(new Map());
  try {
    const before = await h.audits.getState();
    assert.equal(before.auditor, null, "no auditor agent exists before the first audit");
    const campaign = await h.audits.start(WS);
    await settle();
    const state = await h.audits.getState();
    assert.ok(state.auditor, "the first audit created the auditor");
    assert.equal(typeof state.auditor!.name, "string");
    const running = state.campaigns.find((entry) => entry.campaignId === campaign!.campaignId)!;
    assert.equal(running.status, "running");
    assert.ok(running.startedAt, "the campaign records its first dispatch");
    assert.ok(running.waves[0]!.startedAt, "the wave records when it was queued");
    assert.ok(running.live, "the running wave's job is read out");
    assert.equal(running.live!.jobId, running.waves[0]!.jobId);
    assert.equal(running.live!.agentName, state.auditor!.name);
    // `live` is a view of the queue, never written into campaign.json.
    const stored = JSON.parse(
      await readFile(join(h.auditRoot, campaign!.campaignId, "campaign.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal("live" in stored, false);
  } finally {
    await h.dispose();
  }
});

test("smart mode: empty board + nothing running starts a campaign; a full board does not", async () => {
  const h = await createHarness(allGood());
  try {
    // Smart mode off -> no sweep effect.
    await h.audits.publishProjects([WS]);
    let report = await h.audits.smartSweep();
    assert.deepEqual(report.started, [], "smart mode off starts nothing");

    await h.audits.setSmartMode(true);
    // A board with open tickets is not empty -> no campaign.
    const busy = new ZaicodeAuditService({
      jobService: h.jobService,
      agentService: h.agentService,
      rootDir: () => join(h.dir, "audits-busy"),
      readBoard: () => "## DOING\n- [/] T-1 something | verify: x\n",
    });
    await busy.publishProjects([WS]);
    await busy.setSmartMode(true);
    report = await busy.smartSweep();
    assert.deepEqual(report.started, [], "a non-empty board is not audited");

    // An empty board with nothing running -> one campaign starts.
    const empty = new ZaicodeAuditService({
      jobService: h.jobService,
      agentService: h.agentService,
      rootDir: () => join(h.dir, "audits-empty"),
      readBoard: () => "## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n",
    });
    await empty.publishProjects([{ ...WS, noWorkConfirmed: true }]);
    await empty.setSmartMode(true);
    report = await empty.smartSweep();
    assert.deepEqual(report.started, [WS.workspacePath], "an empty board starts exactly one campaign");
    // No board (.saipen absent) -> null -> skipped.
    const noBoard = new ZaicodeAuditService({
      jobService: h.jobService,
      agentService: h.agentService,
      rootDir: () => join(h.dir, "audits-none"),
      readBoard: () => null,
    });
    await noBoard.publishProjects([WS]);
    await noBoard.setSmartMode(true);
    report = await noBoard.smartSweep();
    assert.deepEqual(report.started, [], "a project without a SAIPEN board is skipped");
  } finally {
    await h.dispose();
  }
});

test("parallel: an audit campaign runs alongside other queue work (own jobs, shared queue)", async () => {
  const h = await createHarness(new Map());
  try {
    const agent = await h.agentService.create({ name: "Worker", role: "implementer", instructions: "work", enabled: true });
    // Ordinary project work already queued.
    await h.jobService.create({ ...WS, agentId: agent.id, title: "normal work", instructions: "do a thing" });
    // An audit campaign starts in parallel; it creates its own wave job.
    const campaign = await h.audits.start(WS);
    assert.equal(campaign!.status, "running");
    const jobs = await h.jobService.list({});
    const auditJobs = jobs.jobs.filter((job) => job.title.startsWith("A3 "));
    assert.equal(auditJobs.length, 1, "the campaign added its own wave job to the shared queue");
    assert.ok(jobs.jobs.length >= 2, "audit work and normal work coexist");
  } finally {
    await h.dispose();
  }
});

test("state persists to campaign.json under the audit root", async () => {
  const h = await createHarness(new Map());
  try {
    const campaign = await h.audits.generate(WS);
    const dirs = readdirSync(h.auditRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(dirs.length, 1);
    const raw = await readFile(join(h.auditRoot, campaign!.campaignId, "campaign.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.status, "planned");
    assert.equal(parsed.projectName, WS.projectName);
  } finally {
    await h.dispose();
  }
});

test("T-67: the campaign history is capped; every active campaign always reconciles", async () => {
  const h = await createHarness(new Map());
  try {
    for (let i = 0; i < 40; i += 1) {
      const campaign = await h.audits.generate(WS);
      await h.audits.cancel(campaign!.campaignId);
    }
    let state = await h.audits.getState();
    assert.equal(state.campaigns.length, 30, "finished history caps at 30");
    // Active campaigns are never dropped by the cap, however many finished ones exist.
    const active = await h.audits.generate(WS);
    state = await h.audits.getState();
    assert.equal(state.campaigns.length, 31);
    assert.ok(state.campaigns.some((c) => c.campaignId === active!.campaignId));
  } finally {
    await h.dispose();
  }
});
