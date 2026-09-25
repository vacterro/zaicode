import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeZaicodeDelegationPolicy,
  ZAICODE_DELEGATION_DEFAULT_POLICY,
  zaicodeDelegationInstructions,
  type ZaicodeAgentDefinition,
  type ZaicodeJob,
} from "@zcode/shared";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import { ZaicodeDelegationSpool } from "../../desktop/src/host/zaicodeDelegationSpool.js";

/**
 * T-10: agent-initiated delegation inside the operator's scope (SRC-033):
 * primary coordinator only, depth exactly 1, fixed budget, allowed roles,
 * parent linkage, current run only; outcomes come back to the parent.
 */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-delegation-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const agentRepo = new ZaicodeAgentRepo(dbPath, 500);
  const agents = new ZaicodeAgentService({ repo: agentRepo });
  const jobRepo = new ZaicodeJobRepo(dbPath, 500);
  const finished: ZaicodeJob[] = [];
  const jobs = new ZaicodeJobService({
    repo: jobRepo,
    getAgent: (id) => agents.get(id),
    listAgents: async () => (await agents.list()).agents,
    getExecutor: () => async ({ job }) => ({ sessionId: `session-${job.id}` }),
    onChildFinished: (child) => finished.push(child),
  });
  await jobs.ensureReady();
  await jobs.setAutoRun(false);
  await jobs.setMaxConcurrency(4);
  const make = (name: string, role: ZaicodeAgentDefinition["role"], enabled = true) =>
    agents.create({ name, role, instructions: `${name} instructions`, enabled });
  const coordinator = await make("Coordinator", "coordinator");
  const tester = await make("Tester", "tester");
  const wikier = await make("Wikier", "wikier");
  await make("Second coordinator", "coordinator");
  const startParent = async (agentId = coordinator.id) => {
    const job = await jobs.create({ workspaceKey: "ws", workspacePath: "C:\\ws", agentId, title: "Build it", instructions: "Build." });
    const running = await jobs.dispatch(job.id);
    assert.equal(running?.status, "running");
    return running!;
  };
  return {
    dir,
    jobs,
    finished,
    coordinator,
    tester,
    wikier,
    startParent,
    dispose: async () => {
      jobs.dispose();
      agentRepo.close();
      jobRepo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("policy: defaults, normalization, never a coordinator child", () => {
  assert.deepEqual(ZAICODE_DELEGATION_DEFAULT_POLICY.parentRoles, ["coordinator"]);
  const policy = normalizeZaicodeDelegationPolicy({ childRoles: ["tester", "coordinator", "nope"], maxChildrenPerParent: 99 });
  assert.deepEqual(policy.childRoles, ["tester"]);
  assert.equal(policy.maxChildrenPerParent, 8);
  assert.equal(normalizeZaicodeDelegationPolicy({ maxChildrenPerParent: -2 }).maxChildrenPerParent, 0);
  const paragraph = zaicodeDelegationInstructions({ spoolDir: "D:\\spool", policy: ZAICODE_DELEGATION_DEFAULT_POLICY });
  assert.match(paragraph, /at most 3/);
  // With queue concurrency 1 a helper starts only after the coordinator's run: it must not wait for them.
  assert.match(paragraph, /do not wait/);
});

test("a running coordinator delegates a linked child; depth, budget, roles and run are enforced", async () => {
  const h = await harness();
  try {
    const parent = await h.startParent();
    const ok = await h.jobs.delegateFromRun({
      parentJobId: parent.id,
      runId: parent.runId!,
      request: { role: "tester", title: "Test it", instructions: "Run the suite and report." },
    });
    assert.equal(ok.ok, true);
    const child = ok.ok ? ok.child : null;
    assert.equal(child?.parentJobId, parent.id);
    assert.equal(child?.agentId, h.tester.id);
    // Pumped through the real queue: the child runs next to its parent (concurrency 4).
    assert.equal(child?.status, "running");

    // Depth exactly 1: the child cannot delegate.
    const nested = await h.jobs.delegateFromRun({
      parentJobId: child!.id,
      runId: child!.runId!,
      request: { role: "wikier", title: "Docs", instructions: "Write docs." },
    });
    assert.deepEqual(nested.ok ? "ok" : nested.reason, "parent_is_child");

    // A request from an earlier run of the parent is stale.
    const stale = await h.jobs.delegateFromRun({
      parentJobId: parent.id,
      runId: "old-run",
      request: { role: "wikier", title: "Docs", instructions: "Write docs." },
    });
    assert.equal(stale.ok ? "ok" : stale.reason, "stale_run");

    // No coordinator helpers, by role or by id.
    const byRole = await h.jobs.delegateFromRun({
      parentJobId: parent.id,
      runId: parent.runId!,
      request: { role: "coordinator", title: "x", instructions: "x" },
    });
    assert.equal(byRole.ok ? "ok" : byRole.reason, "child_role_not_allowed");

    // Invalid requests are refused with the reason, not thrown.
    const invalid = await h.jobs.delegateFromRun({ parentJobId: parent.id, runId: parent.runId!, request: { title: "" } });
    assert.equal(invalid.ok ? "ok" : invalid.reason, "invalid_request");

    // Budget: 3 helpers per parent by default.
    for (const title of ["Docs 1", "Docs 2"]) {
      const more = await h.jobs.delegateFromRun({
        parentJobId: parent.id,
        runId: parent.runId!,
        request: { role: "wikier", title, instructions: "Write docs." },
      });
      assert.equal(more.ok, true);
    }
    const over = await h.jobs.delegateFromRun({
      parentJobId: parent.id,
      runId: parent.runId!,
      request: { role: "wikier", title: "Docs 3", instructions: "Write docs." },
    });
    assert.equal(over.ok ? "ok" : over.reason, "budget_exhausted");
  } finally {
    await h.dispose();
  }
});

test("only coordinator jobs may delegate, and only while running", async () => {
  const h = await harness();
  try {
    const testerJob = await h.startParent(h.tester.id);
    const refused = await h.jobs.delegateFromRun({
      parentJobId: testerJob.id,
      runId: testerJob.runId!,
      request: { role: "wikier", title: "x", instructions: "x" },
    });
    assert.equal(refused.ok ? "ok" : refused.reason, "parent_role_not_allowed");

    const parent = await h.startParent();
    await h.jobs.reportRunOutcome({ jobId: parent.id, runId: parent.runId!, attempt: parent.attempt, outcome: "succeeded" });
    const late = await h.jobs.delegateFromRun({
      parentJobId: parent.id,
      runId: parent.runId!,
      request: { role: "tester", title: "x", instructions: "x" },
    });
    assert.equal(late.ok ? "ok" : late.reason, "parent_not_running");

    // The operator can switch delegation off entirely.
    await h.jobs.setDelegationPolicy({ ...ZAICODE_DELEGATION_DEFAULT_POLICY, maxChildrenPerParent: 0 });
    const off = await h.startParent();
    const none = await h.jobs.delegateFromRun({
      parentJobId: off.id,
      runId: off.runId!,
      request: { role: "tester", title: "x", instructions: "x" },
    });
    assert.equal(none.ok ? "ok" : none.reason, "budget_exhausted");
  } finally {
    await h.dispose();
  }
});

test("a helper's final state reaches the parent's folder through the spool", async () => {
  const h = await harness();
  const spool = new ZaicodeDelegationSpool(join(h.dir, "delegation"), () => undefined);
  try {
    const parent = await h.startParent();
    const dir = await spool.open(parent.id, parent.runId!, h.jobs);
    spool.close(parent.id); // drive scans by hand, not by timer
    await writeFile(join(dir, "ask-tester.json"), JSON.stringify({ role: "tester", title: "Test it", instructions: "Run tests." }));
    await writeFile(join(dir, "ask-bad.json"), "{ not json");
    await writeFile(join(dir, "ask-boss.json"), JSON.stringify({ role: "coordinator", title: "x", instructions: "x" }));
    assert.equal(await spool.scan(dir, parent.id, parent.runId!, h.jobs), 3);
    // A second pass answers nothing twice.
    assert.equal(await spool.scan(dir, parent.id, parent.runId!, h.jobs), 0);

    const answer = JSON.parse(await readFile(join(dir, "ask-tester.result.json"), "utf8"));
    assert.equal(answer.ok, true);
    assert.match(answer.childJobId, /^zaicode-job:/);
    assert.equal(JSON.parse(await readFile(join(dir, "ask-bad.result.json"), "utf8")).reason, "invalid_request");
    assert.equal(JSON.parse(await readFile(join(dir, "ask-boss.result.json"), "utf8")).reason, "child_role_not_allowed");

    const child = (await h.jobs.get(answer.childJobId))!;
    await h.jobs.reportRunOutcome({ jobId: child.id, runId: child.runId!, attempt: child.attempt, outcome: "succeeded" });
    assert.equal(h.finished.length, 1);
    await spool.reportChild(h.finished[0]!);
    const done = (await readdir(dir)).filter((name) => name.endsWith(".done.json"));
    assert.equal(done.length, 1);
    const outcome = JSON.parse(await readFile(join(dir, done[0]!), "utf8"));
    assert.equal(outcome.childJobId, child.id);
    assert.equal(outcome.status, "completed");
  } finally {
    spool.dispose();
    await h.dispose();
  }
});
