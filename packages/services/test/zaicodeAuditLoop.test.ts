import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildZaicodeAuditEvidencePackage,
  zaicodeAuditEvidenceFingerprint,
  zaicodeAuditLoopCleanConfirmed,
  zaicodeAuditLoopFeedbackProvenance,
  zaicodeAuditLoopNewRun,
  type ZaicodeAuditLoopReviewReceipt,
  type ZaicodeAuditLoopRun,
} from "@zcode/shared";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import {
  ZaicodeAuditLoopService,
  zaicodeAuditLoopSourceFingerprintOf,
  type ZaicodeAuditLoopOwnershipAnswer,
} from "../src/zaicode/zaicodeAuditLoopService.js";
import type { IZaicodeAgentService } from "../src/zaicode/zaicodeAgents.js";
import type { ZaicodeJobExecutor } from "../src/zaicode/zaicodeJobs.js";
import { createZaicodeAuditGateRunner, readZaicodeAuditGateConfig } from "../src/zaicode/zaicodeAuditGates.js";

/**
 * T-289 (SRC-202) — the Audit Loop, Milestone 1.
 *
 * The fake executor is the model's stand-in and behaves like one: it reads what
 * the loop TOLD it — which file to write, which loop/cycle/source identity to
 * echo — and writes a review artifact that either obeys the contract or does
 * not. A fix job mutates the workspace, because that is what a fix is.
 *
 * Everything else is real: a real SQLite queue, real agent templates, a real
 * workspace on disk, the real evidence walk and policy, real SHA-256 digests,
 * and a real child process for the acceptance gate.
 */

const PARKED = new Set(["CLEAN_CONFIRMED", "CANCELLED", "WAITING_OPERATOR", "FAILED_RECOVERABLE", "STOPPED_LIMIT"]);

const REVIEW_FILE_RE = /Write the review artifact to this exact file, creating it:\r?\n(.+)/;
const IDENTITY_RE = /(AUDIT_LOOP_REVIEW_IDENTITY: .+)/;
const JOB_RE = /AuditLoop (\S+) c(\d+) (review|fix)/;
const FIX_FILE_RE = /Write one remediation report to this exact file, creating it:\r?\n(.+)/;
const FIX_FINDING_RE = /^### (\S+) \(/gm;

interface JobContext {
  loopId: string;
  cycle: number;
  kind: "review" | "fix";
  reviewFile: string;
  /** The exact identity line the loop told this job to echo, prefix included. */
  identityLine: string;
  /** Where a fix job is told to write its per-finding report. */
  fixReportFile: string;
  /** The finding ids the loop asked this fix to address. */
  findingIds: string[];
}

function readJobContext(job: { title: string; instructions: string }): JobContext | null {
  const match = JOB_RE.exec(job.title);
  if (!match) return null;
  const reviewFile = REVIEW_FILE_RE.exec(job.instructions)?.[1]?.trim() ?? "";
  const identityLine = IDENTITY_RE.exec(job.instructions)?.[1]?.trim() ?? "";
  const fixReportFile = FIX_FILE_RE.exec(job.instructions)?.[1]?.trim() ?? "";
  const findingIds = [...job.instructions.matchAll(FIX_FINDING_RE)].map((hit) => hit[1]!);
  return {
    loopId: match[1]!,
    cycle: Number(match[2]!),
    kind: match[3] as "review" | "fix",
    reviewFile,
    identityLine,
    fixReportFile,
    findingIds,
  };
}

type FixEntry = { id: string; claim: string; evidence: string; command?: string; exitCode?: number };

/** The remediation executor owns the report; the verification layer judges its claims. */
function renderFixReport(ctx: JobContext, entries: FixEntry[]): string {
  return [
    `AUDIT_LOOP_FIX_IDENTITY: ${ctx.loopId}#${ctx.cycle}`,
    "",
    "AUDIT_LOOP_FIX_BEGIN",
    JSON.stringify({ findings: entries }, null, 2),
    "AUDIT_LOOP_FIX_END",
    "",
    "STATUS: AUDIT_LOOP_FIX: COMPLETE",
  ].join("\n");
}

/** The default claim: each finding the loop named is fixed, with the command that shows it. */
function defaultFixEntries(ctx: JobContext): FixEntry[] {
  return ctx.findingIds.map((id) => ({
    id,
    claim: "fixed",
    evidence: "the reported condition no longer reproduces against the current source",
    command: "node -e process.exit(0)",
    exitCode: 0,
  }));
}

interface ReviewBody {
  verdict: string;
  findings?: unknown[];
  deterministicChecks?: unknown[];
  unknowns?: string[];
  requiredValidation?: string[];
  remainingRisks?: string[];
  stopRecommendation?: string | null;
}

function renderReview(ctx: JobContext, body: ReviewBody): string {
  return [
    `# Audit loop review ${ctx.loopId} cycle ${ctx.cycle}`,
    ctx.identityLine,
    "",
    "AUDIT_LOOP_REVIEW_BEGIN",
    JSON.stringify(body, null, 2),
    "AUDIT_LOOP_REVIEW_END",
    "",
    "STATUS: AUDIT_LOOP_REVIEW: COMPLETE",
  ].join("\n");
}

function finding(observed: string) {
  return {
    severity: "high",
    location: "src/app.ts:3",
    evidence: "src/app.ts:3 returns undefined when the list is empty",
    expected: "an empty list returns an empty result",
    observed,
    reproduction: "node -e \"require('./src/app.ts').run([])\"",
    acceptance: "run([]) returns an empty array",
  };
}

const CLEAN_CHECKS = [{ command: "node -e process.exit(0)", exitCode: 0 }];

interface Plan {
  /** Per cycle, what the reviewer writes. `null` = write nothing at all. */
  reviews: (ctx: JobContext) => string | null;
  /** What a fix job does to the workspace before reporting success. */
  fix: (ctx: JobContext) => void;
  /**
   * The per-finding report a fix job writes. The default reports every finding as
   * fixed with evidence; null writes nothing, which must leave every finding
   * unresolved rather than closing it.
   */
  fixReport?: (ctx: JobContext, entries: FixEntry[]) => string | null;
  /** The canonical SAIPEN ownership answer the loop may consult. */
  queryOwnership?: (workspacePath: string) => Promise<ZaicodeAuditLoopOwnershipAnswer | null>;
  /** The deterministic gate, run by the service itself. */
  gates: () => Promise<{ command: string; exitCode: number }[]>;
  /**
   * How long the fake model takes to report its terminal outcome. A non-zero
   * value makes "the step is still pending" a deterministic observation rather
   * than a race against the queue.
   */
  reviewDelayMs?: number;
  fixDelayMs?: number;
}

export interface LoopHarness {
  dir: string;
  workspace: string;
  loopRoot: string;
  workspaceKey: string;
  loops: ZaicodeAuditLoopService;
  jobService: ZaicodeJobService;
  agentService: ZaicodeAgentService;
  /** Build a fresh service over the SAME root: the host-restart case. */
  reopen: (overrides?: { agentService?: IZaicodeAgentService }) => ZaicodeAuditLoopService;
  createExecutorJob: (title?: string) => Promise<{ id: string; agentId: string }>;
  jobsWithPrefix: (needle: string) => Promise<{ id: string; title: string }[]>;
  writeFile: (relativePath: string, text: string) => void;
  dispose: () => Promise<void>;
}

/** A real child process, so the gate's exit status is a real exit status. */
async function runRealGate(): Promise<{ command: string; exitCode: number }[]> {
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
  return [{ command: "node -e process.exit(0)", exitCode }];
}

async function createHarness(plan: Plan): Promise<LoopHarness> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-audit-loop-"));
  const workspace = join(dir, "workspace");
  const loopRoot = join(dir, "loops");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), "export function run(list: unknown[]) {\n  return list;\n}\n", "utf8");
  writeFileSync(join(workspace, "README.md"), "# workspace\n", "utf8");

  const dbPath = join(dir, "tasks-index.sqlite");
  const agentRepo = new ZaicodeAgentRepo(dbPath, 500);
  const agentService = new ZaicodeAgentService({ repo: agentRepo });
  const jobRepo = new ZaicodeJobRepo(dbPath, 500);
  let jobServiceRef: ZaicodeJobService | null = null;

  function scheduleOutcome(job: { id: string; runId?: string; attempt: number }, delayMs = 0): void {
    setTimeout(() => {
      void jobServiceRef
        ?.reportRunOutcome({
          jobId: job.id,
          runId: job.runId ?? "",
          attempt: job.attempt,
          outcome: "succeeded",
          resultSummary: "done",
        })
        .catch(() => undefined);
    }, delayMs);
  }

  const executor: ZaicodeJobExecutor = async ({ job }) => {
    const ctx = readJobContext(job);
    if (!ctx) {
      // The audited executor task itself: it just succeeds.
      scheduleOutcome(job, 0);
      return { sessionId: `session-${job.id}` };
    }
    if (ctx.kind === "review") {
      const body = plan.reviews(ctx);
      if (body !== null) {
        mkdirSync(join(ctx.reviewFile, ".."), { recursive: true });
        writeFileSync(ctx.reviewFile, body, "utf8");
      }
      scheduleOutcome(job, plan.reviewDelayMs ?? 0);
      return { sessionId: `session-${job.id}` };
    }
    plan.fix(ctx);
    if (ctx.fixReportFile) {
      const body = plan.fixReport ? plan.fixReport(ctx, defaultFixEntries(ctx)) : renderFixReport(ctx, defaultFixEntries(ctx));
      if (body !== null) {
        mkdirSync(join(ctx.fixReportFile, ".."), { recursive: true });
        writeFileSync(ctx.fixReportFile, body, "utf8");
      }
    }
    scheduleOutcome(job, plan.fixDelayMs ?? 0);
    return { sessionId: `session-${job.id}` };
  };

  const jobService = new ZaicodeJobService({
    repo: jobRepo,
    getAgent: (agentId) => agentService.get(agentId),
    getExecutor: () => executor,
  });
  jobServiceRef = jobService;
  await jobService.ensureReady();
  await jobService.setAutoRun(true);

  const build = (agents: IZaicodeAgentService) =>
    new ZaicodeAuditLoopService({
      jobService,
      agentService: agents,
      rootDir: () => loopRoot,
      runGates: () => plan.gates(),
      ...(plan.queryOwnership ? { queryOwnership: plan.queryOwnership } : {}),
    });

  const loops = build(agentService);
  await loops.setEnabled(true);

  const workspaceKey = `ws-${dir.replace(/[^a-z0-9]+/gi, "").slice(-12)}`;

  return {
    dir,
    workspace,
    loopRoot,
    workspaceKey,
    loops,
    jobService,
    agentService,
    reopen: (overrides) => build(overrides?.agentService ?? agentService),
    createExecutorJob: async (title = "executor task") => {
      const agent = await agentService.createFromTemplate("zaicode-template:implementer");
      const job = await jobService.create({
        workspaceKey,
        workspacePath: workspace,
        agentId: agent.id,
        title,
        instructions: "do the work",
      });
      return { id: job.id, agentId: agent.id };
    },
    jobsWithPrefix: async (needle) => {
      const result = await jobService.list({ workspaceKey });
      return result.jobs.filter((job) => job.title.includes(needle)).map((job) => ({ id: job.id, title: job.title }));
    },
    writeFile: (relativePath, text) => {
      const absolute = join(workspace, relativePath);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, text, "utf8");
    },
    dispose: async () => {
      jobService.dispose();
      agentRepo.close();
      jobRepo.close();
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
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/** Wait past a deliberately delayed terminal outcome. */
async function waitOutcome(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms + 40));
}

/**
 * Wait until every job in this workspace has reached a terminal state. Admission
 * refuses while another worker is live -- that refusal is the guard, not a
 * verdict -- so a test that admits a finished job must first let the queue
 * settle, or a loaded machine turns the guard into a coin flip.
 */
const TERMINAL_JOB_STATUS = new Set(["completed", "failed", "cancelled", "blocked"]);

async function waitForQuietQueue(h: LoopHarness, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listing = await h.jobService.list({ workspaceKey: h.workspaceKey });
    if (listing.jobs.length > 0 && listing.jobs.every((job) => TERMINAL_JOB_STATUS.has(job.status))) return;
    await settle();
  }
  throw new Error("the queue never settled: a worker stayed live past the wait budget");
}

/** Admit a run for a finished executor job and return it. */
async function admitFor(h: LoopHarness, executor: { id: string; agentId: string }): Promise<ZaicodeAuditLoopRun> {
  const admitted = await h.loops.admit({
    workspaceKey: h.workspaceKey,
    workspacePath: h.workspace,
    projectName: "workspace",
    executor: { agentId: executor.agentId, jobId: executor.id, sessionId: `session-${executor.id}` },
    taskId: executor.id,
    goalId: "goal-1",
    terminalDisposition: `job ${executor.id} completed`,
    authorityRef: "saipen:SRC-202",
    autoAudits: true,
  });
  assert.equal(admitted.ok, true, admitted.ok ? "" : `${admitted.code}: ${admitted.reason}`);
  if (!admitted.ok) throw new Error("unreachable");
  return admitted.run;
}

async function readyHarness(
  plan: Plan,
): Promise<{ h: LoopHarness; executor: { id: string; agentId: string }; run: ZaicodeAuditLoopRun }> {
  const h = await createHarness(plan);
  const executor = await h.createExecutorJob();
  await waitForQuietQueue(h);
  const run = await admitFor(h, executor);
  return { h, executor, run };
}

/** Everything durable about a run's position, so progress is never a guess. */
function observe(run: ZaicodeAuditLoopRun): string {
  return [
    run.state,
    run.cycle,
    run.reviews.length,
    run.pending?.jobId ?? "-",
    run.remediation?.jobId ?? "-",
    run.evidence?.cycle ?? -1,
  ].join("|");
}

/**
 * Advance until the run parks, finishes, or stops changing. Progress is measured
 * on durable facts only, so a test never depends on how many ticks a job needed.
 *
 * While the run is waiting on a job IT dispatched, the loop is not stalled, it
 * is waiting, so this waits for the queue to settle instead of guessing a tick
 * count: on a loaded machine a fixed number of ticks turns the worker guard into
 * a coin flip. `stopWhen` is for the tests that deliberately freeze the run in
 * the middle of that wait (a crash during remediation).
 */
async function drive(
  h: LoopHarness,
  loopId: string,
  rounds = 60,
  stopWhen?: (run: ZaicodeAuditLoopRun) => boolean,
): Promise<ZaicodeAuditLoopRun> {
  let run = (await h.loops.getRun(loopId))!;
  for (let index = 0; index < rounds; index += 1) {
    if (PARKED.has(run.state) || stopWhen?.(run)) break;
    const before = observe(run);
    if (run.pending?.jobId || run.remediation?.jobId) await waitForQuietQueue(h);
    else await settle();
    run = (await h.loops.advance(loopId)) ?? run;
    if (observe(run) === before) break;
  }
  return run;
}

/** One advance immediately after the executor completed: the admission step. */
async function advanceOnce(h: LoopHarness, loopId: string): Promise<ZaicodeAuditLoopRun> {
  await settle();
  return (await h.loops.advance(loopId))!;
}

function withFindings(): (ctx: JobContext) => string {
  return (ctx) =>
    renderReview(ctx, {
      verdict: "findings",
      findings: [finding("run([]) throws instead of returning an empty list")],
      deterministicChecks: CLEAN_CHECKS,
      unknowns: [],
      requiredValidation: [],
      remainingRisks: [],
      stopRecommendation: null,
    });
}

function withClean(): (ctx: JobContext) => string {
  return (ctx) =>
    renderReview(ctx, {
      verdict: "clean",
      findings: [],
      deterministicChecks: CLEAN_CHECKS,
      unknowns: [],
      requiredValidation: [],
      remainingRisks: [],
      stopRecommendation: "stop",
    });
}

const NO_FIX = () => undefined;

// ---------------------------------------------------------------------------
// 1-7: the happy path
// ---------------------------------------------------------------------------

test("1. a completed executor admits exactly one review", async () => {
  // A review that finds nothing: the whole run is one reviewer and then done,
  // so "exactly one review" is provable rather than a snapshot of a moving run.
  const { h, run } = await readyHarness({ reviews: withClean(), fix: NO_FIX, gates: runRealGate });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "CLEAN_CONFIRMED");
    assert.equal(driven.cycle, 0);
    assert.equal(driven.reviews.length, 1);
    assert.equal(driven.reviews[0]!.verdict, "clean");
    assert.equal((await h.jobsWithPrefix(" review")).length, 1);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("2. an executor that is still running admits nothing", async () => {
  const h = await createHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    const agent = await h.agentService.createFromTemplate("zaicode-template:implementer");
    // A fresh draft: it exists in the queue but has not reached any terminal state.
    const job = await h.jobService.create({
      workspaceKey: h.workspaceKey,
      workspacePath: h.workspace,
      agentId: agent.id,
      title: "still working",
      instructions: "stay running",
      status: "draft",
    });
    const admitted = await h.loops.admit({
      workspaceKey: h.workspaceKey,
      workspacePath: h.workspace,
      projectName: "workspace",
      executor: { agentId: agent.id, jobId: job.id, sessionId: null },
      taskId: job.id,
      goalId: null,
      terminalDisposition: "job completed",
      authorityRef: null,
      autoAudits: true,
    });
    assert.equal(admitted.ok, false);
    if (!admitted.ok) assert.equal(admitted.code, "EXECUTOR_NOT_TERMINAL");
    assert.equal((await h.loops.getState()).runs.length, 0);
    assert.equal((await h.jobsWithPrefix(" review")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("3. a reload does not produce a second review", async () => {
  const { h, run } = await readyHarness({ reviews: withClean(), fix: NO_FIX, gates: runRealGate });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "CLEAN_CONFIRMED");
    const before = await h.jobsWithPrefix(" review");
    const reloaded = h.reopen();
    await reloaded.advance(run.loopId);
    await reloaded.advance(run.loopId);
    const after = await h.jobsWithPrefix(" review");
    assert.equal(before.length, 1);
    assert.equal(after.length, 1);
    assert.equal((await reloaded.getRun(run.loopId))!.state, "CLEAN_CONFIRMED");
  } finally {
    await h.dispose();
  }
});

test("4. a host restart resumes the pending review instead of restarting it", async () => {
  const { h, run } = await readyHarness({
    reviews: withFindings(),
    fix: NO_FIX,
    gates: runRealGate,
    reviewDelayMs: 400,
  });
  try {
    const dispatched = await advanceOnce(h, run.loopId);
    assert.equal(dispatched.state, "REVIEWING");
    assert.equal((await h.jobsWithPrefix(" review")).length, 1);

    // A brand new process over the same durable root: the run file is the state.
    const reopened = h.reopen();
    const stillPending = await reopened.advance(run.loopId);
    assert.equal(stillPending!.state, "REVIEWING");

    await waitOutcome(400);
    const resumed = await drive({ ...h, loops: reopened }, run.loopId);
    assert.equal(resumed.reviews.length >= 1, true);
    assert.equal(resumed.reviews[0]!.cycle, 0);
    // Only ONE cycle-0 reviewer may ever exist, however many restarts occurred.
    const c0Reviews = (await h.jobsWithPrefix(" review")).filter((job) => job.title.includes(" c0 review"));
    assert.equal(c0Reviews.length, 1);
  } finally {
    await h.dispose();
  }
});

test("5. validated findings produce exactly one remediation dispatch", async () => {
  const { h, run } = await readyHarness({
    reviews: withFindings(),
    fix: NO_FIX,
    gates: runRealGate,
    fixDelayMs: 400,
  });
  try {
    // Stop at the dispatch: this test is about that one job, and driving on
    // would only produce the next cycle's dispatch on top of it.
    const driven = await drive(h, run.loopId, 60, (state) => state.state === "REMEDIATING");
    assert.equal(driven.state, "REMEDIATING");
    const fixes = await h.jobsWithPrefix(" fix");
    assert.equal(fixes.length, 1);
    assert.equal(driven.remediation?.jobId, fixes[0]!.id);
    assert.equal(driven.cycle, 0);
    // Nothing may send a second fix while the first is still out.
    await h.loops.advance(run.loopId);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
  } finally {
    await h.dispose();
  }
});

test("6. a completed remediation starts the next cycle", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) => (ctx.cycle === 0 ? withFindings()(ctx) : withClean()(ctx)),
    fix: () => undefined,
    gates: runRealGate,
  });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.cycle, 1);
    assert.equal(driven.lastVerification?.cycle, 1);
    assert.equal(driven.reviews.length, 2);
    assert.equal(driven.unresolvedFindings[0]!.disposition, "FIXED_VERIFIED");
    assert.equal(driven.remediation?.route, "original_executor");
    assert.equal(driven.reviews[1]!.verdict, "clean");
    assert.equal((await h.jobsWithPrefix(" review")).length, 2);
  } finally {
    await h.dispose();
  }
});

test("end to end: REVIEW -> FINDINGS -> FIX -> REVIEW -> CLEAN, on real files", async () => {
  // A real two-cycle fixture: findings in cycle 0, the fix actually rewrites the
  // workspace, and cycle 1 comes back clean against the NEW source.
  let fixed = false;
  const harnessRef: { h?: LoopHarness } = {};
  const { h, run } = await readyHarness({
    reviews: (ctx) => (ctx.cycle === 0 ? withFindings()(ctx) : withClean()(ctx)),
    fix: () => {
      fixed = true;
      writeFileSync(
        join(harnessRef.h!.workspace, "src", "app.ts"),
        "export function run(list: unknown[]) {\n  return list ?? [];\n}\n",
        "utf8",
      );
    },
    gates: runRealGate,
  });
  harnessRef.h = h;
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "CLEAN_CONFIRMED");
    assert.equal(fixed, true);
    assert.equal(driven.cycle, 1);
    assert.equal(driven.reviews.length, 2);
    assert.equal(driven.reviews[0]!.verdict, "findings");
    assert.equal(driven.reviews[1]!.verdict, "clean");
    assert.equal(driven.reviews[1]!.deterministicChecks[0]!.exitCode, 0);
    assert.equal(driven.unresolvedFindings[0]!.disposition, "FIXED_VERIFIED");
    assert.equal(driven.remediation?.route, "original_executor");
    assert.equal((await h.jobsWithPrefix(" review")).length, 2);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
    // The evidence package is really on disk, and its digest is a real digest.
    assert.equal(existsSync(driven.evidence!.packageFile), true);
    const manifest = JSON.parse(readFileSync(driven.evidence!.manifestFile, "utf8")) as {
      digest: string;
      included: { path: string }[];
    };
    assert.ok(manifest.included.some((entry) => entry.path === "src/app.ts"));
    assert.match(manifest.digest, /^[0-9a-f]{64}$/);
    assert.match(driven.sourceFingerprint, /^content-sha256:[0-9a-f]{64}$/);
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// 8-18: the guards
// ---------------------------------------------------------------------------

test("8. a clean claim without deterministic evidence is UNVERIFIED, never clean", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) =>
      renderReview(ctx, {
        verdict: "clean",
        findings: [],
        deterministicChecks: [],
        unknowns: [],
        requiredValidation: [],
        remainingRisks: [],
        stopRecommendation: "stop",
      }),
    fix: NO_FIX,
    gates: runRealGate,
  });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "REVIEW_UNVERIFIED");
    assert.equal(driven.reviews[0]!.verdict, "unverified");
    assert.equal((await h.jobsWithPrefix(" fix")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("9. the same findings twice stop the loop instead of cycling forever", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "NO_PROGRESS");
    assert.equal(driven.cycle, 1);
  } finally {
    await h.dispose();
  }
});

test("10. a cancellation dispatches nothing afterwards", async () => {
  const { h, run } = await readyHarness({
    reviews: withFindings(),
    fix: NO_FIX,
    gates: runRealGate,
    reviewDelayMs: 400,
  });
  try {
    const pending = await advanceOnce(h, run.loopId);
    assert.equal(pending.state, "REVIEWING");
    const cancelled = await h.loops.cancel(run.loopId);
    assert.equal(cancelled!.state, "CANCELLED");
    // The reviewer finishes AFTER the cancel; nothing may happen because of it.
    await waitOutcome(400);
    await h.loops.advance(run.loopId);
    await h.loops.advance(run.loopId);
    const after = (await h.loops.getRun(run.loopId))!;
    assert.equal(after.state, "CANCELLED");
    assert.equal((await h.jobsWithPrefix(" fix")).length, 0);
    assert.equal(after.reviews.length, 0);
  } finally {
    await h.dispose();
  }
});

test("11. an unavailable reviewer agent parks the run recoverably, not silently", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    const broken = new Proxy(h.agentService, {
      get: (target, property, receiver) =>
        property === "list" || property === "createFromTemplate"
          ? async () => {
              throw new Error("agent service unavailable");
            }
          : Reflect.get(target, property, receiver),
    }) as IZaicodeAgentService;
    const loops = h.reopen({ agentService: broken });
    const driven = await drive({ ...h, loops }, run.loopId);
    assert.equal(driven.state, "FAILED_RECOVERABLE");
    assert.equal(driven.blocker?.code, "REVIEWER_AGENT_UNAVAILABLE");
    assert.equal((await h.jobsWithPrefix(" review")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("12. foreign SAIPEN ownership delivers findings but mutates no source", async () => {
  const { h, run } = await readyHarness({
    reviews: withFindings(),
    fix: NO_FIX,
    gates: runRealGate,
    queryOwnership: async () => ({ authoritative: true, foreign: true, detail: "T-900 is claimed by the saihunt seat" }),
  });
  try {
    mkdirSync(join(h.workspace, ".saipen"), { recursive: true });
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "SAIPEN_OWNERSHIP_REJECTED");
    assert.equal((await h.jobsWithPrefix(" fix")).length, 0);
    assert.equal(driven.reviews.length, 1);
  } finally {
    await h.dispose();
  }
});

test("13. evidence that cannot be written never reaches a reviewer", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    // Occupy the cycle directory with a FILE, so the atomic write cannot create
    // its temporary sibling. This is a real write failure, not a mock.
    mkdirSync(join(h.loopRoot, run.loopId), { recursive: true });
    writeFileSync(join(h.loopRoot, run.loopId, "cycle-0"), "not a directory", "utf8");
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "FAILED_RECOVERABLE");
    assert.equal(driven.blocker?.code, "EVIDENCE_WRITE_FAILED");
    assert.equal((await h.jobsWithPrefix(" review")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("14. a review artifact from another identity is rejected, never reconciled", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) =>
      // A perfectly formed report that belongs to a DIFFERENT source revision.
      renderReview(ctx, { verdict: "clean", findings: [], deterministicChecks: CLEAN_CHECKS }).replace(
        ctx.identityLine,
        `AUDIT_LOOP_REVIEW_IDENTITY: ${ctx.loopId}#${ctx.cycle} content-sha256:${"0".repeat(64)}`,
      ),
    fix: NO_FIX,
    gates: runRealGate,
  });
  try {
    const driven = await drive(h, run.loopId);
    // A stale artifact is never reconciled into this run's history.
    assert.equal(driven.reviews.length, 0);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "REVIEWER_INVALID");
    assert.ok(driven.invalidReviewStreak >= 3);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("15. the source identity moves when bytes move, even with an identical file list", async () => {
  const fileList = [{ path: "src/app.ts", text: "const a = 1;\n" }];
  const before = zaicodeAuditLoopSourceFingerprintOf(fileList);
  const after = zaicodeAuditLoopSourceFingerprintOf([{ path: "src/app.ts", text: "const a = 2;\n" }]);
  const sameBytes = zaicodeAuditLoopSourceFingerprintOf(fileList);
  assert.notEqual(before, after);
  assert.equal(before, sameBytes);
  assert.match(before, /^content-sha256:[0-9a-f]{64}$/);
  // Reordering the walk is not a source change.
  const two = [
    { path: "a.ts", text: "1" },
    { path: "b.ts", text: "2" },
  ];
  assert.equal(zaicodeAuditLoopSourceFingerprintOf(two), zaicodeAuditLoopSourceFingerprintOf([...two].reverse()));
  // The evidence package digest follows the bytes, not only the paths.
  const digestOf = (sha: string) => zaicodeAuditEvidenceFingerprint([{ path: "a.ts", sha256: sha }], (t) => t);
  assert.notEqual(digestOf("1"), digestOf("2"));
  assert.equal(digestOf("1"), digestOf("1"));
});

test("16. audit feedback carries agent provenance and grants no human authorization", async () => {
  const { h, run } = await readyHarness({
    reviews: withFindings(),
    fix: NO_FIX,
    gates: runRealGate,
    fixDelayMs: 400,
  });
  try {
    const driven = await drive(h, run.loopId);
    const provenance = zaicodeAuditLoopFeedbackProvenance(driven);
    assert.equal(provenance.origin, "agent_runtime");
    assert.equal(provenance.humanAuthored, false);
    assert.equal(provenance.humanAuthorizationGranted, false);
    assert.equal(provenance.originalUserIntentId, "goal-1");
    const fixJob = (await h.jobService.get(driven.remediation!.jobId))!;
    assert.ok(fixJob.instructions.includes('"origin": "agent_runtime"'));
    assert.ok(fixJob.instructions.includes('"humanAuthorizationGranted": false'));
    assert.ok(fixJob.instructions.includes("This message is AGENT/RUNTIME-ORIGINATED audit feedback."));
  } finally {
    await h.dispose();
  }
});

test("17. the cycle limit is terminal, never extended by itself", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    await h.loops.setMaxCycles(10);
    const fresh = await h.loops.getRun(run.loopId);
    assert.equal(fresh!.maxCycles, 10);
    const driven = await drive(h, run.loopId);
    assert.ok(["WAITING_OPERATOR", "STOPPED_LIMIT"].includes(driven.state), driven.state);
    assert.ok(driven.cycle > 0);
    // A parked run is not advanced again.
    const before = driven.cycle;
    const after = await h.loops.advance(run.loopId);
    assert.equal(after!.cycle, before);
  } finally {
    await h.dispose();
  }
});

test("17b. ten cycles end in STOPPED_LIMIT with the counter intact", async () => {
  const { h, run } = await readyHarness({
    // A distinct finding each cycle: no no-progress stop, only the limit.
    reviews: (ctx) =>
      withFindings()(ctx).replace(
        "run([]) throws instead of returning an empty list",
        `cycle ${ctx.cycle} defect`,
      ),
    fix: NO_FIX,
    gates: runRealGate,
  });
  try {
    const driven = await drive(h, run.loopId, 120);
    assert.equal(driven.state, "STOPPED_LIMIT");
    assert.equal(driven.cycle, 10);
    assert.equal(driven.blocker?.code, "CYCLE_LIMIT");
    assert.equal((await h.jobsWithPrefix(" review")).length, 10);
  } finally {
    await h.dispose();
  }
});

test("18. a crash during remediation reconciles the existing job and never duplicates it", async () => {
  const { h, run } = await readyHarness({
    reviews: withFindings(),
    fix: NO_FIX,
    gates: runRealGate,
    fixDelayMs: 400,
  });
  try {
    // Stop the moment the fix is dispatched: this test is about the queue at
    // that moment, not about where the loop would end up on its own.
    const dispatched = await drive(h, run.loopId, 60, (state) => state.state === "REMEDIATING");
    assert.equal(dispatched.state, "REMEDIATING");
    const fixes = await h.jobsWithPrefix(" fix");
    assert.equal(fixes.length, 1);

    // The process dies here; a new one reads the same durable run and finds the
    // fix already on the queue instead of sending another one.
    const reopened = h.reopen();
    await reopened.advance(run.loopId);
    await reopened.advance(run.loopId);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);

    await waitOutcome(400);
    const resumed = await drive({ ...h, loops: reopened }, run.loopId);
    assert.ok(resumed.reviews.length >= 1);
    assert.notEqual(resumed.state, "REMEDIATING");
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
  } finally {
    await h.dispose();
  }
});

test("recovery: reconcile advances every non-terminal run once", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    const reopened = h.reopen();
    const result = await reopened.reconcile();
    assert.ok(result.advanced.length + result.parked.length >= 1);
    const driven = (await reopened.getRun(run.loopId))!;
    assert.notEqual(driven.state, "WAITING_FOR_EXECUTOR");
  } finally {
    await h.dispose();
  }
});

test("admission refuses a conflicting loop for the same workspace", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    const second = await h.createExecutorJob("executor task two");
    await settle();
    const conflicting = await h.loops.admit({
      workspaceKey: h.workspaceKey,
      workspacePath: h.workspace,
      projectName: "workspace",
      executor: { agentId: second.agentId, jobId: second.id, sessionId: null },
      taskId: second.id,
      goalId: null,
      terminalDisposition: "done",
      authorityRef: null,
      autoAudits: true,
    });
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.code, "CONFLICTING_LOOP");
    assert.equal(run.state, "WAITING_FOR_EXECUTOR");
  } finally {
    await h.dispose();
  }
});

test("admission refuses when the project's automatic audit mode is off, and audit-now still works", async () => {
  const h = await createHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    const executor = await h.createExecutorJob();
    await settle();
    const base = {
      workspaceKey: h.workspaceKey,
      workspacePath: h.workspace,
      projectName: "workspace",
      executor: { agentId: executor.agentId, jobId: executor.id, sessionId: null },
      taskId: executor.id,
      goalId: null,
      terminalDisposition: "done",
      authorityRef: null,
      autoAudits: false,
    } as const;
    const refused = await h.loops.admit(base);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "AUDIT_MODE_DISABLED");
    // Manual "audit now" is independent of the automatic switch.
    const manual = await h.loops.auditNow(base);
    assert.equal(manual.ok, true);
    if (manual.ok) assert.equal(manual.run.admission.mode, "manual");
  } finally {
    await h.dispose();
  }
});

test("evidence packaging excludes secrets, build output and local state by policy", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    h.writeFile(".env", "API_KEY=sk-abcdefghijklmnopqrstuvwx\n");
    h.writeFile("node_modules/pkg/index.js", "module.exports = 1;\n");
    h.writeFile(".saipen/STATE.md", "phase: BUILD\n");
    const driven = await advanceOnce(h, run.loopId);
    const manifest = JSON.parse(readFileSync(driven.evidence!.manifestFile, "utf8")) as {
      included: { path: string }[];
      exclusions: { path: string; ruleId: string }[];
      exclusionSummary: { total: number; byRule: Record<string, number> };
    };
    const included = manifest.included.map((entry) => entry.path);
    assert.ok(included.includes("src/app.ts"));
    assert.ok(!included.includes(".env"));
    assert.ok(!included.some((path) => path.startsWith("node_modules/")));
    assert.ok(!included.some((path) => path.startsWith(".saipen/")));
    assert.ok(manifest.exclusions.some((entry) => entry.path === ".env" && entry.ruleId === "file-secret-or-state"));
    assert.ok(manifest.exclusionSummary.total > 0);
  } finally {
    await h.dispose();
  }
});

test("operator settings clamp cycles to the supported range", async () => {
  const h = await createHarness({ reviews: withClean(), fix: NO_FIX, gates: runRealGate });
  try {
    await h.loops.setMaxCycles(1);
    assert.equal((await h.loops.getState()).settings.maxCycles, 1);
    await assert.rejects(() => h.loops.setMaxCycles(0), /between 1 and 10/);
    await assert.rejects(() => h.loops.setMaxCycles(11), /between 1 and 10/);
    await h.loops.setMaxCycles(10);
    assert.equal((await h.loops.getState()).settings.maxCycles, 10);
    const consent = await h.loops.setExternalConsent({ granted: true, scope: "workspace" });
    assert.equal(consent.externalTransmissionConsent.granted, true);
    assert.ok(consent.externalTransmissionConsent.grantedAt);
  } finally {
    await h.dispose();
  }
});

test("an external reviewer without consent parks instead of silently self-auditing", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    await h.loops.setReviewerMode("external");
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "REVIEWER_CONSENT_REQUIRED");
    assert.equal((await h.jobsWithPrefix(" review")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("an external reviewer with consent falls back to a self-audit and says so", async () => {
  const { h, run } = await readyHarness({
    reviews: withFindings(),
    fix: NO_FIX,
    gates: runRealGate,
    fixDelayMs: 400,
  });
  try {
    await h.loops.setReviewerMode("external");
    await h.loops.setExternalConsent({ granted: true, scope: "workspace" });
    const driven = await drive(h, run.loopId, 60, (state) => state.state === "REMEDIATING");
    assert.equal(driven.reviews.length, 1);
    // The verdict is recorded as a SELF audit; it is never labelled external.
    assert.equal(driven.reviews[0]!.reviewerMode, "self");
    assert.match(driven.reviews[0]!.reviewerIdentity, /^self:/);
    assert.ok(driven.reviewerHistory.every((identity) => !identity.startsWith("external:")));
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
  } finally {
    await h.dispose();
  }
});

test("a malformed reviewer result is retried and then bounded", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) => `${ctx.identityLine}\n\nthe audit looked fine to me.\n`,
    fix: NO_FIX,
    gates: runRealGate,
  });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.ok(driven.invalidReviewStreak >= 3);
    assert.equal(driven.reviews.length, 0);
  } finally {
    await h.dispose();
  }
});
// ---------------------------------------------------------------------------
// The finding ledger, the original-executor route, evidence integrity and the
// ownership capability: the guards that keep a cycle from closing by itself.
// ---------------------------------------------------------------------------

test("19. a finding the fix never reports stays STILL_OPEN and blocks a clean verdict", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) => (ctx.cycle === 0 ? withFindings()(ctx) : withClean()(ctx)),
    fix: NO_FIX,
    gates: runRealGate,
    // A report that mentions nothing: silence is not a fix.
    fixReport: (ctx) => renderFixReport(ctx, []),
  });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.unresolvedFindings[0]!.disposition, "STILL_OPEN");
    // The later clean verdict is refused because the finding was never closed.
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "CLEAN_GATE_FAILED");
    assert.match(driven.blocker!.reason, /still unresolved/);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
  } finally {
    await h.dispose();
  }
});

test("20. a fix claim without evidence is UNVERIFIED, never FIXED_VERIFIED", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) => (ctx.cycle === 0 ? withFindings()(ctx) : withClean()(ctx)),
    fix: NO_FIX,
    gates: runRealGate,
    fixReport: (ctx, entries) => renderFixReport(ctx, entries.map((entry) => ({ ...entry, evidence: "", command: undefined, exitCode: undefined }))),
  });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.unresolvedFindings[0]!.disposition, "UNVERIFIED");
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "CLEAN_GATE_FAILED");
  } finally {
    await h.dispose();
  }
});

test("21. a failing acceptance gate downgrades a fixed claim to UNVERIFIED", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) => (ctx.cycle === 0 ? withFindings()(ctx) : withClean()(ctx)),
    fix: NO_FIX,
    gates: async () => [{ command: "node -e process.exit(1)", exitCode: 1 }],
  });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.unresolvedFindings[0]!.disposition, "UNVERIFIED");
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "CLEAN_GATE_FAILED");
  } finally {
    await h.dispose();
  }
});

test("22. an unavailable original executor is an explicit fallback, never a continuation", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate, fixDelayMs: 400 });
  try {
    const originalAgentId = run.originalExecutor.agentId;
    const proxied = new Proxy(h.agentService, {
      get: (target, property, receiver) => {
        if (property === "get") return async (agentId: string) => (agentId === originalAgentId ? null : target.get(agentId));
        return Reflect.get(target, property, receiver);
      },
    }) as IZaicodeAgentService;
    const loops = h.reopen({ agentService: proxied });
    const driven = await drive({ ...h, loops }, run.loopId, 60, (state) => state.state === "REMEDIATING");
    assert.equal(driven.state, "REMEDIATING");
    // The route records that the ORIGINAL context could not be validated, even
    // though the generic implementer that resolves may be the same agent id.
    assert.equal(driven.remediation?.route, "authorized_fallback");
    const fixJob = (await h.jobService.get(driven.remediation!.jobId))!;
    assert.ok(fixJob.instructions.includes("explicit FALLBACK"));
    assert.ok(fixJob.instructions.includes("This is NOT a continuation of the original session."));
  } finally {
    await h.dispose();
  }
});

test("23. a tampered evidence package is refused before findings are acted on", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate, reviewDelayMs: 400 });
  try {
    const dispatched = await advanceOnce(h, run.loopId);
    assert.equal(dispatched.state, "REVIEWING");
    // Bytes change after the reviewer was handed the package: the artifact the
    // verdict is about is no longer the artifact on disk.
    appendFileSync(dispatched.evidence!.packageFile, "\ntampered\n", "utf8");
    await waitOutcome(400);
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "EVIDENCE_PACKAGE_DRIFT");
    assert.equal((await h.jobsWithPrefix(" fix")).length, 0);
  } finally {
    await h.dispose();
  }
});

test("24. a governed project with no canonical ownership query refuses to mutate source", async () => {
  const { h, run } = await readyHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    mkdirSync(join(h.workspace, ".saipen"), { recursive: true });
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "OWNERSHIP_QUERY_UNAVAILABLE");
    assert.equal((await h.jobsWithPrefix(" fix")).length, 0);
    // The feedback itself is preserved: only the mutation was refused.
    assert.equal(driven.reviews.length, 1);
  } finally {
    await h.dispose();
  }
});

test("25. an incomplete source scan is recorded and refuses a clean verdict", async () => {
  const built = buildZaicodeAuditEvidencePackage({
    projectName: "p",
    workspaceKey: "w",
    taskId: "t",
    goalId: null,
    executorIdentity: "agent-1 job-1",
    loopId: "loop-1",
    cycle: 0,
    sourceFingerprint: "content-sha256:abc",
    sourceHead: null,
    generatedAt: new Date(0).toISOString(),
    candidates: [{ path: "src/a.ts", text: "const a = 1;\n" }],
    scan: { unreadable: ["src/locked/"], oversized: ["src/big.ts"], truncated: true },
    acceptance: { requirements: [], tests: [], receipts: [], reproduction: [] },
    hash: (text) => text.length.toString(16).padStart(64, "0"),
  });
  // The manifest says what the scan could not see instead of implying full cover.
  assert.equal(built.manifest.coverage.complete, false);
  assert.ok(built.manifest.coverage.limitations.length >= 3);
  assert.deepEqual(built.manifest.coverage.unreadable, ["src/locked/"]);

  const run = zaicodeAuditLoopNewRun({
    loopId: "loop-1",
    projectName: "p",
    workspaceKey: "w",
    workspacePath: "C:/w",
    executor: { agentId: "agent-1", jobId: "job-1", sessionId: null },
    taskId: "t",
    goalId: null,
    authorityRef: null,
    mode: "auto",
    terminalDisposition: "done",
    sourceFingerprint: "content-sha256:abc",
    sourceHead: null,
    maxCycles: 3,
    reviewerMode: "self",
    autoAudits: true,
    externalTransmissionConsent: { granted: false, scope: null, grantedAt: null },
    externalFallback: "self",
    now: new Date(0).toISOString(),
  });
  run.evidence = {
    cycle: 0,
    manifestFile: "manifest.json",
    packageFile: "evidence.md",
    digest: built.manifest.digest,
    fileCount: built.manifest.included.length,
    excludedCount: built.manifest.exclusionSummary.total,
    sourceFingerprint: "content-sha256:abc",
    coverageComplete: built.manifest.coverage.complete,
    limitations: built.manifest.coverage.limitations,
    writtenAt: new Date(0).toISOString(),
  };
  const review: ZaicodeAuditLoopReviewReceipt = {
    cycle: 0,
    reviewerMode: "self",
    reviewerIdentity: "self:auditor",
    verdict: "clean",
    artifactSha256: "0".repeat(64),
    deterministicChecks: [{ command: "node -e process.exit(0)", exitCode: 0 }],
    unknowns: [],
    requiredValidation: [],
    remainingRisks: [],
    stopRecommendation: null,
    findings: [],
    receivedAt: new Date(0).toISOString(),
  };
  const gate = zaicodeAuditLoopCleanConfirmed({
    run,
    review,
    gates: [{ command: "node -e process.exit(0)", exitCode: 0 }],
    reviewedSourceFingerprint: run.sourceFingerprint,
  });
  // A clean review over a partial scan cannot close the loop.
  assert.equal(gate.confirmed, false);
  assert.match(gate.reason, /scan was incomplete/);
});
// ---------------------------------------------------------------------------
// The host contract: a terminal EVENT advances the loop, and admission is
// atomic under concurrent events.
// ---------------------------------------------------------------------------

test("26. the terminal event of the loop's own jobs advances the cycle with no poller", async () => {
  const { h, run } = await readyHarness({
    reviews: (ctx) => (ctx.cycle === 0 ? withFindings()(ctx) : withClean()(ctx)),
    fix: (ctx) => {
      void ctx;
      writeFileSync(join(h.workspace, "src", "app.ts"), "export function run(list: unknown[]) {\n  return list ?? [];\n}\n", "utf8");
    },
    gates: runRealGate,
  });
  try {
    // One explicit advance is the host's "the executor finished" step: it takes
    // the run all the way to a dispatched review.
    await settle();
    let r = (await h.loops.advance(run.loopId))!;
    assert.equal(r.state, "REVIEWING");
    const reviewJobId = r.pending!.jobId!;
    await settle();
    // From here on, ONLY the terminal event of the loop's own job moves it.
    r = (await h.loops.resumeFromTerminalJob({ workspaceKey: h.workspaceKey, jobId: reviewJobId, terminalDisposition: `job ${reviewJobId} completed` }))!;
    assert.equal(r.state, "REMEDIATING");
    assert.equal(r.cycle, 0);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
    const fixJobId = r.pending!.jobId!;
    // A duplicate notification for the review job (already consumed) is a no-op.
    assert.equal(await h.loops.resumeFromTerminalJob({ workspaceKey: h.workspaceKey, jobId: reviewJobId, terminalDisposition: "again" }), null);
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
    await settle();
    r = (await h.loops.resumeFromTerminalJob({ workspaceKey: h.workspaceKey, jobId: fixJobId, terminalDisposition: `job ${fixJobId} completed` }))!;
    assert.equal(r.cycle, 1);
    assert.equal(r.unresolvedFindings[0]!.disposition, "FIXED_VERIFIED");
    // The next cycle's review is dispatched, and only one fix was ever sent.
    assert.equal((await h.jobsWithPrefix(" fix")).length, 1);
    assert.equal((await h.jobsWithPrefix(" c1 review")).length, 1);
    // The event for a job this loop does not own is a no-op, not a new loop.
    assert.equal(await h.loops.resumeFromTerminalJob({ workspaceKey: h.workspaceKey, jobId: "job-not-ours", terminalDisposition: "completed" }), null);
    assert.equal((await h.loops.getState()).runs.length, 1);
  } finally {
    await h.dispose();
  }
});

test("27. two concurrent admission events for one workspace produce exactly one loop", async () => {
  const h = await createHarness({ reviews: withFindings(), fix: NO_FIX, gates: runRealGate });
  try {
    const first = await h.createExecutorJob("executor one");
    const second = await h.createExecutorJob("executor two");
    await waitForQuietQueue(h);
    const base = (executor: { id: string; agentId: string }) => ({
      workspaceKey: h.workspaceKey,
      workspacePath: h.workspace,
      projectName: "workspace",
      executor: { agentId: executor.agentId, jobId: executor.id, sessionId: null },
      taskId: executor.id,
      goalId: null,
      terminalDisposition: "done",
      authorityRef: null,
      autoAudits: true,
    });
    const results = await Promise.all([h.loops.admit(base(first)), h.loops.admit(base(second))]);
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    const refusal = results.find((result) => !result.ok);
    if (!refusal || refusal.ok) throw new Error("expected exactly one refusal");
    assert.equal(refusal.code, "CONFLICTING_LOOP");
    assert.equal((await h.loops.getState()).runs.length, 1);
    // The durable reservation itself does not survive the admission it guarded.
    const locks = join(h.loopRoot, "admission-locks");
    assert.equal(existsSync(locks) ? readdirSync(locks).length : 0, 0);
  } finally {
    await h.dispose();
  }
});

test("28. an unavailable gate set is not a pass: no gate, no clean verdict", async () => {
  // The loop's own runner returns [] when the host injects none. "Nothing ran"
  // and "the checks passed" must never look the same to the loop, so a clean
  // verdict over an empty gate list parks instead of closing.
  const { h, run } = await readyHarness({ reviews: withClean(), fix: NO_FIX, gates: async () => [] });
  try {
    const driven = await drive(h, run.loopId);
    assert.equal(driven.state, "WAITING_OPERATOR");
    assert.equal(driven.blocker?.code, "CLEAN_GATE_FAILED");
    assert.match(driven.blocker!.reason, /no deterministic acceptance gate was run/);
  } finally {
    await h.dispose();
  }
});

test("29. the gate runner refuses an unusable configuration and keeps real gate evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-audit-gates-"));
  try {
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    // 1. No trusted configuration at all: an error, never an empty pass.
    const missing = readZaicodeAuditGateConfig(workspace);
    assert.equal(missing.gates.length, 0);
    assert.ok(missing.error, "a missing gate configuration must be reported as an error");
    // 2. A shell string instead of an argv array is not accepted.
    mkdirSync(join(workspace, ".zcode"), { recursive: true });
    writeFileSync(join(workspace, ".zcode", "audit-gates.json"), JSON.stringify({ gates: [{ id: "one", command: "node -e process.exit(0)" }] }), "utf8");
    const shellish = readZaicodeAuditGateConfig(workspace);
    assert.equal(shellish.gates.length, 0);
    assert.match(shellish.error ?? "", /no args array/);
    // 3. A usable configuration runs each gate for real: argv only, real codes.
    writeFileSync(
      join(workspace, ".zcode", "audit-gates.json"),
      JSON.stringify({
        gates: [
          { id: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 10_000 },
          { id: "fail", command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 10_000 },
        ],
      }),
      "utf8",
    );
    const parsed = readZaicodeAuditGateConfig(workspace);
    assert.equal(parsed.gates.length, 2);
    assert.equal(parsed.error, null);
    const evidenceDir = join(dir, "loops", "L1", "c0");
    mkdirSync(evidenceDir, { recursive: true });
    const runner = createZaicodeAuditGateRunner({});
    const report = await runner({
      loopId: "L1",
      cycle: 0,
      workspacePath: workspace,
      sourceFingerprint: "sha256:test",
      evidence: { manifestFile: join(evidenceDir, "manifest.json") },
    } as unknown as ZaicodeAuditLoopRun);
    assert.deepEqual(report.map((gate) => gate.exitCode), [0, 3]);
    assert.match(report[1]!.command, /process\.exit\(3\)/);
    // The full record -- real codes, timing, bounded output, fingerprint -- is
    // persisted next to the cycle's evidence package.
    const persisted = JSON.parse(readFileSync(join(evidenceDir, "gates.json"), "utf8")) as {
      configError: string | null;
      sourceFingerprint: string;
      gates: { id: string; exitCode: number | null; startedAt: string; endedAt: string; sourceFingerprint: string }[];
    };
    assert.equal(persisted.configError, null);
    assert.equal(persisted.sourceFingerprint, "sha256:test");
    assert.deepEqual(persisted.gates.map((gate) => [gate.id, gate.exitCode]), [["pass", 0], ["fail", 3]]);
    assert.ok(persisted.gates.every((gate) => gate.startedAt && gate.endedAt && gate.sourceFingerprint === "sha256:test"));
    // 4. An unusable configuration is one FAILING gate, never an empty list.
    writeFileSync(join(workspace, ".zcode", "audit-gates.json"), "{ not json", "utf8");
    const broken = await createZaicodeAuditGateRunner({})({
      loopId: "L1",
      cycle: 0,
      workspacePath: workspace,
      sourceFingerprint: "sha256:test",
      evidence: { manifestFile: join(evidenceDir, "manifest.json") },
    } as unknown as ZaicodeAuditLoopRun);
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.exitCode, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
