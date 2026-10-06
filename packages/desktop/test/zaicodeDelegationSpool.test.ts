// T-247 / SRC-160:R010 (W2-004) — the delegation carrier across attempts and restarts.
//
// The spool is a file carrier, so every defect here is a state that survives a crash:
// a folder shared by two runs of one job, a claim whose answer was never written, and a
// scan still writing while the host shuts down. These tests drive the carrier directly
// (behaviour on disk), one pass at a time, with the timer switched off except where the
// test is about the timer's own in-flight bookkeeping.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZaicodeJob } from "@zcode/shared";
import {
  ZaicodeDelegationSpool,
  isZaicodeDelegationRequestFile,
  zaicodeSpoolName,
  type ZaicodeDelegationGateway,
} from "../src/host/zaicodeDelegationSpool.js";

const PARENT = "zaicode-job:parent";
const RUN_1 = "zaicode-run:one";
const RUN_2 = "zaicode-run:two";

/** Only the id, status and title of a child matter to the carrier. */
const childJob = (id: string, parentJobId = PARENT, status = "completed") =>
  ({ id, parentJobId, title: "helper", status }) as unknown as ZaicodeJob;

interface GatewayCalls {
  count: number;
  runs: string[];
}

function okGateway(calls: GatewayCalls, childId = "zaicode-job:child"): ZaicodeDelegationGateway {
  return {
    async delegateFromRun(input) {
      calls.count += 1;
      calls.runs.push(input.runId);
      return { ok: true, child: childJob(childId) };
    },
  };
}

const request = JSON.stringify({ role: "tester", title: "Test it", instructions: "Run the tests." });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "zaicode-spool-"));
  const warnings: string[] = [];
  const spool = new ZaicodeDelegationSpool(root, (message) => warnings.push(message));
  return { root, spool, calls: { count: 0, runs: [] as string[] }, warnings };
}

/** Opens a run's folder for one pass, with the timer off and nothing left claimed. */
async function openOnce(spool: ZaicodeDelegationSpool, runId: string, gateway: ZaicodeDelegationGateway): Promise<string> {
  const dir = await spool.open(PARENT, runId, gateway);
  spool.close(PARENT);
  return dir;
}

const answerOf = async (dir: string, base: string) =>
  JSON.parse(await readFile(join(dir, `${base}.result.json`), "utf8")) as { ok: boolean; reason?: string; childJobId?: string };

const listing = (path: string) => readdir(path).catch(() => [] as string[]);

test("T-247: two runs of one parent get their own folder and cannot consume each other's request", async () => {
  const h = await harness();
  try {
    const dirOne = h.spool.dirFor(PARENT, RUN_1);
    const dirTwo = h.spool.dirFor(PARENT, RUN_2);
    assert.notEqual(dirOne, dirTwo, "a run must not inherit another run's folder");
    assert.equal(dirOne, join(h.root, `${zaicodeSpoolName(PARENT)}__${zaicodeSpoolName(RUN_1)}`));

    // A request left behind by run 1 (the earlier attempt of this job).
    await mkdir(dirOne, { recursive: true });
    await writeFile(join(dirOne, "ask.json"), request, "utf8");

    const gateway = okGateway(h.calls);
    const dirOpened = await openOnce(h.spool, RUN_2, gateway);
    assert.equal(dirOpened, dirTwo);
    assert.equal(await h.spool.scan(dirTwo, PARENT, RUN_2, gateway), 0);
    assert.equal(h.calls.count, 0, "run 2 must not answer run 1's request");
    // Still a request, neither claimed nor answered by the other run.
    assert.deepEqual((await listing(dirOne)).filter(isZaicodeDelegationRequestFile), ["ask.json"]);
  } finally {
    await h.spool.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("T-247: a claim without its answer is failed explicitly when the run opens again", async () => {
  const h = await harness();
  try {
    const dir = h.spool.dirFor(PARENT, RUN_1);
    await mkdir(dir, { recursive: true });
    // Exactly what a crash between the claim rename and the answer write leaves behind.
    await writeFile(join(dir, "ask.taken"), request, "utf8");
    await writeFile(join(dir, "done.taken"), request, "utf8");
    await writeFile(join(dir, "done.result.json"), `${JSON.stringify({ ok: true, childJobId: "zaicode-job:old" })}\n`, "utf8");

    const dirOpened = await openOnce(h.spool, RUN_1, okGateway(h.calls));
    const answer = await answerOf(dirOpened, "ask");
    assert.equal(answer.ok, false);
    assert.equal(answer.reason, "unprocessed_after_restart");
    // The claim is not delegated again: a child may already exist for it.
    assert.equal(h.calls.count, 0, "recovery must not create a second child");
    // A claim that already has its answer is left alone.
    assert.equal((await answerOf(dirOpened, "done")).childJobId, "zaicode-job:old");
  } finally {
    await h.spool.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("T-247: the startup sweep fails stale claims of runs that never come back, and leaves live ones alone", async () => {
  const h = await harness();
  try {
    const orphan = join(h.root, `${zaicodeSpoolName(PARENT)}__${zaicodeSpoolName("zaicode-run:gone")}`);
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "stale.taken"), request, "utf8");
    await writeFile(join(orphan, "fresh.taken"), request, "utf8");
    await writeFile(join(orphan, "answered.taken"), request, "utf8");
    await writeFile(join(orphan, "answered.result.json"), `${JSON.stringify({ ok: true })}\n`, "utf8");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(join(orphan, "stale.taken"), old, old);
    await utimes(join(orphan, "answered.taken"), old, old);

    assert.equal(await h.spool.sweepOrphans(), 1);
    assert.equal((await answerOf(orphan, "stale")).reason, "unprocessed_after_restart");
    assert.equal((await listing(orphan)).includes("fresh.result.json"), false, "a live scan's claim window is not swept");
    assert.equal((await answerOf(orphan, "answered")).reason, undefined);
  } finally {
    await h.spool.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("T-247: dispose() waits for the scan in flight and leaves no answer behind", async () => {
  const h = await harness();
  try {
    let releaseGate!: () => void;
    let reachedGate!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    const gateway: ZaicodeDelegationGateway = {
      async delegateFromRun() {
        reachedGate();
        await held;
        return { ok: true, child: childJob("zaicode-job:late") };
      },
    };

    // The timer path: this is the scan dispose() has to know about.
    const dir = await h.spool.open(PARENT, RUN_1, gateway);
    await writeFile(join(dir, "ask.json"), request, "utf8");
    await reached; // claimed, and parked inside the gateway

    const disposing = h.spool.dispose();
    let settled = false;
    void disposing.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "dispose() must wait for the scan it started");

    releaseGate();
    await disposing;
    assert.equal(settled, true);
    // The request was claimed, the answer was not written: after dispose nothing may land.
    assert.deepEqual(await listing(dir), ["ask.taken"]);
    assert.equal(await h.spool.scan(dir, PARENT, RUN_1, gateway), 0, "a disposed spool answers nothing");
  } finally {
    await h.spool.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("T-247: after a host restart a helper's outcome finds the run folder that asked for it", async () => {
  const h = await harness();
  try {
    const dirOne = h.spool.dirFor(PARENT, RUN_1);
    const dirTwo = h.spool.dirFor(PARENT, RUN_2);
    await mkdir(dirOne, { recursive: true });
    await mkdir(dirTwo, { recursive: true });
    await writeFile(join(dirTwo, "ask.json"), request, "utf8");
    const gateway = okGateway(h.calls, "zaicode-job:helper");
    await h.spool.scan(await openOnce(h.spool, RUN_2, gateway), PARENT, RUN_2, gateway);

    // A fresh instance is a restarted host: nothing is remembered in memory.
    const restarted = new ZaicodeDelegationSpool(h.root, () => undefined);
    try {
      await restarted.reportChild(childJob("zaicode-job:helper", PARENT, "failed"));
      assert.deepEqual((await listing(dirTwo)).filter((name) => name.endsWith(".done.json")), ["zaicode-job_helper.done.json"]);
      assert.equal((await listing(dirOne)).filter((name) => name.endsWith(".done.json")).length, 0);
      const outcome = JSON.parse(await readFile(join(dirTwo, "zaicode-job_helper.done.json"), "utf8")) as {
        childJobId: string;
        status: string;
      };
      assert.equal(outcome.childJobId, "zaicode-job:helper");
      assert.equal(outcome.status, "failed");
    } finally {
      await restarted.dispose();
    }
  } finally {
    await h.spool.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("T-247: an outcome with no folder to land in is reported, not misfiled", async () => {
  const h = await harness();
  try {
    await h.spool.reportChild(childJob("zaicode-job:stranger"));
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0]!, /no folder to land in/);
    assert.deepEqual(await listing(h.root), []);
  } finally {
    await h.spool.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("T-247: the request/answer contract itself is unchanged", async () => {
  const h = await harness();
  try {
    const gateway = okGateway(h.calls, "zaicode-job:child");
    const dir = await openOnce(h.spool, RUN_1, gateway);
    await writeFile(join(dir, "ask.json"), request, "utf8");
    await writeFile(join(dir, "bad.json"), "{ not json", "utf8");

    assert.equal(await h.spool.scan(dir, PARENT, RUN_1, gateway), 2);
    assert.equal(await h.spool.scan(dir, PARENT, RUN_1, gateway), 0, "nothing is answered twice");
    assert.deepEqual(h.calls.runs, [RUN_1]);
    const answer = await answerOf(dir, "ask");
    assert.equal(answer.ok, true);
    assert.equal(answer.childJobId, "zaicode-job:child");
    assert.equal((await answerOf(dir, "bad")).reason, "invalid_request");

    await h.spool.reportChild(childJob("zaicode-job:child"));
    assert.equal((await listing(dir)).includes("zaicode-job_child.done.json"), true);
  } finally {
    await h.spool.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});
