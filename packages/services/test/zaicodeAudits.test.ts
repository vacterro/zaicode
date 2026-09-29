import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import { ZaicodeAuditService } from "../src/zaicode/zaicodeAuditService.js";
import type { ZaicodeJobExecutor } from "../src/zaicode/zaicodeJobs.js";

/**
 * T-66 (SRC-049) + Wave 5: the A3 campaign machine on the ZAICODE queue, under
 * the AUDAPACK Quick3 contract.
 *
 * The fake executor is the model's stand-in, and it behaves like one: it reads
 * what the wave prompt TOLD it — where to write, which run it belongs to, which
 * predecessor digest it must chain to — and writes a report that obeys the
 * contract. A test that wants an invalid report simply writes one that does
 * not, and the service has to refuse it.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const WS = { workspaceKey: "ws-1", workspacePath: "C:\\proj\\_ZAICODE", projectName: "_ZAICODE" };

/** What the prompt tells the auditor, as the auditor reads it back. */
interface WaveCtx {
  slug: string;
  projectName: string;
  runId: string;
  predecessorSha: string | null;
  path: string;
  title: string;
  ticketPrefix: string;
  fields: string[];
  noFindings: string;
  doneMarker: string;
  terminalLine: string;
  classifications: string[] | null;
}

/** null = the wave produces nothing and stays running, like a session at work. */
type ReportFactory = (ctx: WaveCtx) => string | null;

const QUICK3: Record<string, Omit<WaveCtx, "slug" | "projectName" | "runId" | "predecessorSha" | "path">> = {
  core: {
    title: "AUDIT CORE",
    ticketPrefix: "CORE-",
    fields: ["EVIDENCE", "DEFECT", "REPAIR", "VERIFY"],
    noFindings: "NO VERIFIED CORE DEFECTS.",
    doneMarker: "CORE_DONE_WHEN:",
    terminalLine: "STATUS: AUDIT_CORE: COMPLETE",
    classifications: null,
  },
  second: {
    title: "AUDIT SECOND WAVE",
    ticketPrefix: "W2-",
    fields: ["EVIDENCE", "DEFECT", "REPAIR", "VERIFY"],
    noFindings: "NO NEW VERIFIED SECOND-WAVE DEFECTS.",
    doneMarker: "SECOND_WAVE_DONE_WHEN:",
    terminalLine: "STATUS: SECOND_WAVE: COMPLETE",
    classifications: null,
  },
  performance: {
    title: "AUDIT PERFORMANCE / STABILITY / EFFECTIVENESS",
    ticketPrefix: "PERF-",
    fields: ["EVIDENCE", "ISSUE", "OPTIMIZE", "GUARDRAIL", "VERIFY"],
    noFindings: "NO MATERIAL PERFORMANCE/STABILITY FINDINGS.",
    doneMarker: "PERFORMANCE_DONE_WHEN:",
    terminalLine: "STATUS: PERFORMANCE: COMPLETE",
    classifications: ["PROVEN BOTTLENECK", "STRONGLY EVIDENCED WASTE", "LOW-RISK SIMPLIFICATION"],
  },
};

const SLUGS: Record<string, string> = {
  core: "AUDIT_CORE",
  second: "AUDIT_SECOND_WAVE",
  performance: "AUDIT_PERFORMANCE",
};

/** Read the wave's own contract back out of the prompt the model was given. */
function readWaveCtx(instructions: string): WaveCtx | null {
  const path = /Write the report to this exact file[^\n]*\n(.+)/.exec(instructions)?.[1]?.trim();
  if (!path) return null;
  const slug = /__0\d_([A-Z_]+)\.md$/.exec(path)?.[1] ?? "";
  const waveId = Object.keys(SLUGS).find((key) => SLUGS[key] === slug);
  if (!waveId) return null;
  const spec = QUICK3[waveId]!;
  return {
    slug,
    projectName: /- Project: (.*?) \(/.exec(instructions)?.[1] ?? "",
    runId: /- Run id: (\S+)/.exec(instructions)?.[1] ?? "",
    predecessorSha: /predecessor artifact sha256 `([0-9a-f]{64})`/.exec(instructions)?.[1] ?? null,
    path,
    ...spec,
  };
}

/** A report that satisfies the Quick3 gate: identity, findings, machine lines. */
function validReport(ctx: WaveCtx, withFindings = true): string {
  const lines: string[] = [`# ${ctx.title}`, "", `- Project: ${ctx.projectName}`, `- Run id: ${ctx.runId}`];
  if (withFindings) {
    // The fields are this wave's OWN list, verbatim. Emitting Core's names into
    // a Performance report is exactly the defect the gate exists to catch, so
    // the fixture walks the profile rather than hard-coding a shape.
    const body: Record<string, string> = {
      EVIDENCE: "packages/services/src/zaicode/zaicodeJobService.ts:210",
      DEFECT: "a completed job leaves the campaign on running until the next poll",
      ISSUE: "each completed wave costs one extra poll before the campaign advances",
      OPTIMIZE: "reconcile inside reportRunOutcome",
      REPAIR: "reconcile the terminal state inside reportRunOutcome",
      GUARDRAIL: "a regression that polls twice must still see one dispatch",
      VERIFY: "the focused service suite covers the double poll",
    };
    lines.push(
      "",
      `### ${ctx.ticketPrefix}1 the job queue never releases a finished wave`,
      ...ctx.fields.map((field) => `${field}: ${body[field] ?? "see the evidence"}`),
    );
    if (ctx.classifications) {
      lines.push(`Classification: ${ctx.classifications[2]} — the poll interval is the only cost`);
    }
  } else {
    lines.push("", ctx.noFindings);
  }
  if (ctx.predecessorSha) lines.push(`- Predecessor sha256: ${ctx.predecessorSha}`);
  lines.push("", `${ctx.doneMarker} every finding names a file, a line and a check`, "");
  // The terminal line is LAST. That is the whole gate: a report that merely
  // mentions it is not a finished wave.
  lines.push(ctx.terminalLine);
  return lines.join("\n");
}

function allValid(): ReportFactory {
  return (ctx) => validReport(ctx);
}

function makeExecutor(
  factory: ReportFactory,
  writes: string[],
  getJobService: () => ZaicodeJobService,
): ZaicodeJobExecutor {
  return async ({ job }) => {
    const ctx = readWaveCtx(job.instructions);
    if (!ctx) return { sessionId: `session-${job.id}` };
    const body = factory(ctx);
    if (body === null) {
      // A wave that produced nothing stays running, like a session at work.
      return { sessionId: `session-${job.id}` };
    }
    await mkdir(join(ctx.path, ".."), { recursive: true });
    await writeFile(ctx.path, body, "utf8");
    writes.push(ctx.slug);
    const runId = job.runId ?? "";
    const attempt = job.attempt;
    setTimeout(() => {
      void getJobService()
        .reportRunOutcome({ jobId: job.id, runId, attempt, outcome: "succeeded", resultSummary: "audit wave done" })
        .catch(() => undefined);
    }, 0);
    return { sessionId: `session-${job.id}` };
  };
}

interface Harness {
  dir: string;
  auditRoot: string;
  agentService: ZaicodeAgentService;
  jobService: ZaicodeJobService;
  audits: ZaicodeAuditService;
  writes: string[];
  dispose: () => Promise<void>;
}

async function createHarness(factory: ReportFactory): Promise<Harness> {
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
    getExecutor: () => makeExecutor(factory, writes, () => jobServiceRef!),
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
    writes,
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function drive(h: Harness, campaignId: string, rounds = 8) {
  let state = (await h.audits.getCampaign(campaignId))!;
  for (let i = 0; i < rounds && state.status !== "complete" && state.status !== "blocked"; i += 1) {
    await settle();
    state = (await h.audits.getState()).campaigns.find((c) => c.campaignId === campaignId)!;
  }
  return state;
}

test("generate is generate-first: planned, no job dispatched", async () => {
  const h = await createHarness(allValid());
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
  const h = await createHarness(allValid());
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

test("a campaign is bound to one run, one profile manifest and one source identity", async () => {
  const h = await createHarness(allValid());
  try {
    const campaign = await h.audits.generate(WS);
    assert.equal(campaign!.profileId, "quick3");
    assert.equal(campaign!.profileVersion, "1.0.0");
    assert.match(campaign!.manifestHash!, /^fnv1a64:/);
    assert.ok(campaign!.runId, "the run is identified at generate time");
    assert.ok(campaign!.sourceIdentity, "the audited source is frozen at generate time");
    // The per-wave key is stable per (run, wave) -- that is what makes a retry
    // the same dispatch rather than a new one.
    const keys = campaign!.waves.map((wave) => wave.idempotencyKey);
    assert.equal(new Set(keys).size, 3, "one key per wave");
    assert.ok(keys.every((key) => key.includes(campaign!.runId!)));
  } finally {
    await h.dispose();
  }
});

test("full A3: three valid reports chain to complete AND write the combined handoff", async () => {
  const h = await createHarness(allValid());
  try {
    const campaign = await h.audits.start(WS);
    const state = await drive(h, campaign!.campaignId);
    assert.equal(state.status, "complete", `expected complete, got ${state.status}`);
    assert.ok(state.waves.every((wave) => wave.status === "complete"));
    assert.ok(state.waves.every((wave) => wave.resultSha256 && wave.resultSha256.length === 64));
    assert.equal(state.waves[1]!.findings, 1, "the gate counted the finding it validated");

    // The combined file is the deliverable, and it is what makes the campaign
    // complete -- not the third wave on its own.
    assert.ok(state.combined, "the campaign records the combined artifact");
    assert.match(state.combined!.file, /__00_AUDIT_ALL_3\.md$/);
    assert.equal(state.combined!.kind, "quick3_combined");
    assert.match(state.combined!.sha256, /^[0-9a-f]{64}$/);
    assert.equal(state.finalHandoffFile, state.combined!.file);

    const path = join(h.auditRoot, campaign!.campaignId, state.combined!.file);
    assert.ok(existsSync(path), "the combined file is on disk");
    const markdown = await readFile(path, "utf8");
    assert.match(markdown, /- Artifact kind: quick3_combined/);
    assert.ok(markdown.includes(state.runId!), "the handoff names the run");
    for (const slug of Object.values(SLUGS)) {
      assert.ok(markdown.includes(slug), `the handoff carries the ${slug} report verbatim`);
    }
    // Findings are carried, not summarised away.
    assert.ok(markdown.includes("the job queue never releases a finished wave"));
  } finally {
    await h.dispose();
  }
});

test("the combined handoff is byte-stable: its recorded digest IS the file on disk", async () => {
  const h = await createHarness(allValid());
  try {
    const campaign = await h.audits.start(WS);
    const state = await drive(h, campaign!.campaignId);
    assert.equal(state.status, "complete");
    const path = join(h.auditRoot, campaign!.campaignId, state.combined!.file);
    const onDisk = await readFile(path, "utf8");
    // The digest the campaign published is the digest of these exact bytes.
    // That is what makes the handoff citable by identity.
    assert.equal(sha256(onDisk), state.combined!.sha256);
    // Re-reconciling a complete campaign changes nothing: no rewrite, no new
    // timestamp, no drift in the file the fix job will later be handed.
    await h.audits.getState();
    await h.audits.getState();
    assert.equal(await readFile(path, "utf8"), onDisk);
    assert.equal((await h.audits.getCampaign(campaign!.campaignId))!.combined!.sha256, state.combined!.sha256);
  } finally {
    await h.dispose();
  }
});

test("a report missing the terminal line blocks the campaign and never advances", async () => {
  const h = await createHarness(() => "# Findings\n\nno machine lines here\n");
  try {
    const campaign = await h.audits.start(WS);
    const state = await drive(h, campaign!.campaignId);
    assert.equal(state.status, "blocked", "a partial wave blocks");
    assert.equal(state.waves[0]!.status, "partial");
    assert.ok(state.waves[0]!.rejectReason, "the operator is told WHY");
    assert.match(state.waves[0]!.rejectReason!, /AUDIT_CORE: COMPLETE/);
    assert.equal(state.waves[1]!.jobId, null, "the second wave is never dispatched");
    assert.equal(state.combined, null, "no handoff without three valid waves");
  } finally {
    await h.dispose();
  }
});

test("plan-shaped output is rejected by name and does not advance the wave", async () => {
  const h = await createHarness(
    (ctx) =>
      [
        "# AUDIT CORE",
        `- Project: ${ctx.projectName}`,
        `- Run id: ${ctx.runId}`,
        "",
        "Here's how I would audit this: first I would run the tests, then I would map the modules.",
        "",
        `${ctx.doneMarker} nothing yet`,
        ctx.terminalLine,
      ].join("\n"),
  );
  try {
    const campaign = await h.audits.start(WS);
    const state = await drive(h, campaign!.campaignId);
    assert.equal(state.status, "blocked");
    assert.equal(state.waves[0]!.status, "partial");
    assert.match(state.waves[0]!.rejectReason!, /plan/i);
    assert.equal(state.waves[1]!.jobId, null);
  } finally {
    await h.dispose();
  }
});

test("a report from another run cannot satisfy this campaign", async () => {
  const h = await createHarness((ctx) => validReport(ctx).replace(ctx.runId, "some-older-run"));
  try {
    const campaign = await h.audits.start(WS);
    const state = await drive(h, campaign!.campaignId);
    assert.equal(state.status, "blocked");
    assert.match(state.waves[0]!.rejectReason!, /run/i);
  } finally {
    await h.dispose();
  }
});

test("a chained wave must carry its predecessor's hash", async () => {
  let seen = 0;
  const h = await createHarness((ctx) => {
    seen += 1;
    // Wave 2 answers honestly but drops the digest the gate requires.
    return seen === 2 ? validReport(ctx).replace(/^- Predecessor sha256: .*$/m, "") : validReport(ctx);
  });
  try {
    const campaign = await h.audits.start(WS);
    const state = await drive(h, campaign!.campaignId, 12);
    assert.equal(state.status, "blocked");
    assert.equal(state.waves[1]!.status, "partial");
    assert.match(state.waves[1]!.rejectReason!, /predecessor/i);
    assert.equal(state.waves[2]!.jobId, null, "Performance is never dispatched on an unchained Second");
  } finally {
    await h.dispose();
  }
});

test("retry re-runs the SAME wave and never moves the wave index", async () => {
  let coreAttempt = 0;
  const h = await createHarness((ctx) => {
    if (ctx.slug !== SLUGS.core) return null; // stop after Core
    coreAttempt += 1;
    return coreAttempt === 1 ? "# nothing useful\n" : validReport(ctx);
  });
  try {
    const campaign = await h.audits.start(WS);
    const blocked = await drive(h, campaign!.campaignId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.currentWaveIndex, 0, "still on wave 1");

    const retried = await h.audits.retry(campaign!.campaignId);
    assert.equal(retried!.currentWaveIndex, 0, "a retry does not advance the index");
    assert.equal(retried!.waves[0]!.attempt, 2, "the attempt number is what changed");
    assert.equal(retried!.waves[1]!.jobId, null, "wave 2 is not dispatched by a retry of wave 1");
    assert.equal(
      retried!.waves[0]!.idempotencyKey,
      blocked!.waves[0]!.idempotencyKey,
      "the idempotency key is per (run, wave), so it survives the retry",
    );
    const advanced = await drive(h, campaign!.campaignId, 12);
    assert.equal(advanced.waves[0]!.status, "complete", "the second attempt produced a valid Core");
  } finally {
    await h.dispose();
  }
});

test("a restart before dispatch produces exactly one Core", async () => {
  const h = await createHarness(allValid());
  try {
    const campaign = await h.audits.generate(WS);
    // A brand new service instance over the same root: this is a cold start
    // reading campaign.json, not the process that wrote it.
    const cold = new ZaicodeAuditService({
      jobService: h.jobService,
      agentService: h.agentService,
      rootDir: () => h.auditRoot,
    });
    await cold.work(campaign!.campaignId);
    await cold.getState();
    const jobs = await h.jobService.list({});
    const cores = jobs.jobs.filter((job) => job.title.startsWith("A3 1/3 "));
    assert.equal(cores.length, 1, "recovery adopts the wave, it does not send a second Core");
  } finally {
    await h.dispose();
  }
});

test("a restart after dispatch never duplicates the Core", async () => {
  const h = await createHarness(null);
  try {
    const campaign = await h.audits.start(WS);
    await settle();
    const cold = new ZaicodeAuditService({
      jobService: h.jobService,
      agentService: h.agentService,
      rootDir: () => h.auditRoot,
    });
    for (let i = 0; i < 3; i += 1) {
      await settle();
      await cold.getState();
    }
    const jobs = await h.jobService.list({});
    const cores = jobs.jobs.filter((job) => job.title.startsWith("A3 1/3 "));
    assert.equal(cores.length, 1, `three cold reconciles made ${cores.length} Core jobs`);
    const state = await cold.getCampaign(campaign!.campaignId);
    assert.equal(state!.currentWaveIndex, 0, "still the first wave");
  } finally {
    await h.dispose();
  }
});

test("cancel stops a running campaign and its wave job", async () => {
  const h = await createHarness(allValid());
  try {
    const campaign = await h.audits.start(WS);
    const cancelled = await h.audits.cancel(campaign!.campaignId);
    assert.equal(cancelled!.status, "cancelled");
  } finally {
    await h.dispose();
  }
});

test("a cancelled campaign keeps the artifacts it already proved", async () => {
  const h = await createHarness((ctx) => (ctx.slug === SLUGS.core ? validReport(ctx) : null));
  try {
    const campaign = await h.audits.start(WS);
    let state = await drive(h, campaign!.campaignId, 4);
    assert.equal(state.waves[0]!.status, "complete");
    const digest = state.waves[0]!.resultSha256;
    state = (await h.audits.cancel(campaign!.campaignId))!;
    assert.equal(state.status, "cancelled");
    assert.equal(state.waves[0]!.resultSha256, digest, "cancelling does not undo what was proven");
    const after = (await h.audits.getCampaign(campaign!.campaignId))!;
    assert.equal(after.waves[0]!.resultSha256, digest);
  } finally {
    await h.dispose();
  }
});

test("SRC-058: a reconcile queued behind cancel does not turn the cancelled campaign into blocked", async () => {
  const h = await createHarness(allValid());
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

test("Fix with SAIPEN consumes the exact combined artifact and records the drift", async () => {
  const h = await createHarness(allValid());
  try {
    const campaign = await h.audits.start(WS);
    const state = await drive(h, campaign!.campaignId);
    assert.equal(state.status, "complete");

    const fixed = await h.audits.fixWithSaipen(campaign!.campaignId);
    assert.ok(fixed!.fixJobId, "one implementation job is created");
    assert.ok(fixed!.sourceDrift, "the drift against the audited source is recorded");
    assert.equal(typeof fixed!.sourceDrift!.changed, "boolean");

    const jobs = await h.jobService.list({});
    const fixJob = jobs.jobs.find((job) => job.id === fixed!.fixJobId)!;
    assert.ok(fixJob, "the fix job is on the queue");
    // The audit input is named by identity AND digest, and the drift is stated
    // so the implementer verifies before it changes anything.
    assert.ok(fixJob.instructions.includes(state.combined!.sha256), "the fix names the artifact digest");
    assert.ok(fixJob.instructions.includes(state.combined!.file), "the fix names the artifact file");
    assert.match(fixJob.instructions, /Verify every finding against the current source/i);
    assert.match(fixJob.instructions, /Do not edit the audit artifacts/i);

    // A second press must not dispatch the same findings to a second agent.
    const again = await h.audits.fixWithSaipen(campaign!.campaignId);
    assert.equal(again!.fixJobId, fixed!.fixJobId, "the fix is started once");
  } finally {
    await h.dispose();
  }
});

test("Fix with SAIPEN refuses before the combined artifact exists", async () => {
  const h = await createHarness(null);
  try {
    const campaign = await h.audits.start(WS);
    await settle();
    await assert.rejects(
      () => h.audits.fixWithSaipen(campaign!.campaignId),
      /not ready/i,
      "there is nothing to hand over at 0/3",
    );
  } finally {
    await h.dispose();
  }
});

test("an old campaign's artifacts cannot satisfy a new run", async () => {
  const h = await createHarness(allValid());
  try {
    const first = await h.audits.start(WS);
    const done = await drive(h, first!.campaignId);
    assert.equal(done.status, "complete");
    const second = await h.audits.start(WS);
    assert.notEqual(second!.runId, first!.runId, "a new campaign is a new run");
    assert.notEqual(second!.campaignId, first!.campaignId);
    // The first campaign's directory is untouched evidence for its own run.
    assert.ok(existsSync(join(h.auditRoot, first!.campaignId, done.combined!.file)));
    assert.equal(existsSync(join(h.auditRoot, second!.campaignId, done.combined!.file)), false);
  } finally {
    await h.dispose();
  }
});

test("SRC-060: getState says who audits, on which model, and where the running wave is", async () => {
  // No reports: every wave stays running, so the readout is about a campaign
  // that is still on its first wave.
  const h = await createHarness(() => null);
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
  const h = await createHarness(allValid());
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
  const h = await createHarness(allValid());
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
  const h = await createHarness(allValid());
  try {
    const campaign = await h.audits.generate(WS);
    const dirs = readdirSync(h.auditRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(dirs.length, 1);
    const raw = await readFile(join(h.auditRoot, campaign!.campaignId, "campaign.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.status, "planned");
    assert.equal(parsed.projectName, WS.projectName);
    assert.equal(parsed.runId, campaign!.runId);
    assert.equal(parsed.manifestHash, campaign!.manifestHash);
  } finally {
    await h.dispose();
  }
});

test("T-67: the campaign history is capped; every active campaign always reconciles", async () => {
  const h = await createHarness(allValid());
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
