// T-246 / SRC-160:R011 (W2-003) — a stopped schedule run is only "ended" once the host
// confirmed the stop. The rules used to forget the run and announce it before trying, so
// a rejected stop left the schedule with no memory of a run that was still going.
//
// Everything here is the real thing: the known-project registry, the continue-handle
// registry, the home journal (which records `autostart.fire` before any card or
// quiet-hours filter) and a fake queue service standing in for a refusing host.
import assert from "node:assert/strict";
import test from "node:test";
import type { ZaicodeAutostartJob, ZaicodeScheduledRun } from "@zcode/shared";
import { registerZaicodeProjectContinue, type ZaicodeProjectContinueHandle } from "../src/zaicode/zaicodeContinue.js";
import { publishZaicodeKnownProjects } from "../src/zaicode/zaicodeScheduler.js";
import { applyZaicodeScheduleStopRules, stopZaicodeSessionRun } from "../src/zaicode/zaicodeScheduleRun.js";
import { clearZaicodeHomeJournal, useZaicodeHomeJournal } from "../src/zaicode/home/zaicodeHomeJournal.js";
import type { ZaicodeServices } from "../src/zaicode/zaicodeServices.js";

const KEY = "sched-stop";
/** A run started at 10:00 on the 6th is due for a `00:00` stop rule by noon on the 7th (local time). */
const STARTED = new Date(2026, 9, 6, 10, 0, 0).getTime();
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();

const runOf = (jobId: string): ZaicodeScheduledRun => ({ jobId, workspaceKey: KEY, at: STARTED });

/** Only the fields the stop rules read; the rest of the schedule shape is irrelevant here. */
const jobOf = (runs: ZaicodeScheduledRun[]) =>
  ({ id: "sched-1", name: "night", stopAt: "00:00", runs }) as unknown as ZaicodeAutostartJob;

function handle(behaviour: "ok" | "reject", onStop: (sessionId: string) => void): ZaicodeProjectContinueHandle {
  const unused = async () => {
    throw new Error("the stop rules must not call this");
  };
  return {
    send: unused,
    start: async () => "unused",
    stop: async (sessionId: string) => {
      onStop(sessionId);
      if (behaviour === "reject") throw new Error("host refused the stop");
    },
    clear: unused,
    markUnread: unused,
  };
}

function harness(options: { behaviour?: "ok" | "reject"; register?: boolean } = {}) {
  const attempts: string[] = [];
  const cancelled: string[] = [];
  const forgets: { id: string; runs: string[] }[] = [];
  let refusing = false;
  const registered = options.register !== false;
  const off = registered
    ? registerZaicodeProjectContinue(KEY, handle(options.behaviour ?? "ok", (sessionId) => attempts.push(sessionId)))
    : () => undefined;
  publishZaicodeKnownProjects([{ key: KEY, name: "Stop fixture", path: "C:/sched-stop-fixture" }]);
  clearZaicodeHomeJournal();
  const services = {
    jobs: {
      cancel: async (jobId: string) => {
        cancelled.push(jobId);
        if (refusing) throw new Error("host refused the cancel");
      },
    },
  } as unknown as ZaicodeServices;
  return {
    attempts,
    cancelled,
    forgets,
    services,
    refuseQueue: () => {
      refusing = true;
    },
    forget: (id: string, runs: string[]) => {
      forgets.push({ id, runs });
    },
    events: () => useZaicodeHomeJournal.getState().events,
    dispose: () => {
      off();
      publishZaicodeKnownProjects([]);
      clearZaicodeHomeJournal();
    },
  };
}

const bodies = (h: ReturnType<typeof harness>) => h.events().map((event) => `${event.scenario}|${event.body}`);

test("T-246: a stop the host rejects neither forgets the run nor reports it ended", async () => {
  const h = harness({ behaviour: "reject" });
  try {
    await applyZaicodeScheduleStopRules([jobOf([runOf("session:s1")])], h.services, h.forget, NOW);
    assert.deepEqual(h.attempts, ["s1"], "the stop was attempted");
    assert.deepEqual(h.forgets, [], "a rejected stop must not forget the run");
    assert.deepEqual(h.events(), [], "no ended notification for a run that is still going");
  } finally {
    h.dispose();
  }
});

test("T-246: a run in a project with no handle is a rejection, not a stop", async () => {
  const h = harness({ register: false });
  try {
    await applyZaicodeScheduleStopRules([jobOf([runOf("session:s1")])], h.services, h.forget, NOW);
    assert.deepEqual(h.attempts, [], "no handle means no stop was attempted");
    assert.deepEqual(h.forgets, [], "nothing was stopped, so nothing is forgotten");
    assert.deepEqual(h.events(), []);
  } finally {
    h.dispose();
  }
});

test("T-246: a confirmed session stop is forgotten and reported once", async () => {
  const h = harness({ behaviour: "ok" });
  try {
    await applyZaicodeScheduleStopRules([jobOf([runOf("session:s1")])], h.services, h.forget, NOW);
    assert.deepEqual(h.forgets, [{ id: "sched-1", runs: ["session:s1"] }]);
    assert.deepEqual(bodies(h), ["autostart.fire|1 run(s) ended by the stop time"]);
  } finally {
    h.dispose();
  }
});

test("T-246: a queue run whose cancel the host rejects stays tracked and unannounced", async () => {
  const h = harness();
  h.refuseQueue();
  try {
    await applyZaicodeScheduleStopRules([jobOf([runOf("job-7")])], h.services, h.forget, NOW);
    assert.deepEqual(h.cancelled, ["job-7"], "the queue was asked to cancel it");
    assert.deepEqual(h.forgets, []);
    assert.deepEqual(h.events(), []);
  } finally {
    h.dispose();
  }
});

test("T-246: a queue run the host cancels is forgotten and reported once", async () => {
  const h = harness();
  try {
    await applyZaicodeScheduleStopRules([jobOf([runOf("job-7")])], h.services, h.forget, NOW);
    assert.deepEqual(h.forgets, [{ id: "sched-1", runs: ["job-7"] }]);
    assert.deepEqual(bodies(h), ["autostart.fire|1 run(s) ended by the stop time"]);
  } finally {
    h.dispose();
  }
});

test("T-246: a mixed stop forgets only the confirmed run and says what is still stopping", async () => {
  const h = harness({ behaviour: "ok" });
  h.refuseQueue();
  try {
    await applyZaicodeScheduleStopRules([jobOf([runOf("session:s1"), runOf("job-7")])], h.services, h.forget, NOW);
    assert.deepEqual(h.forgets, [{ id: "sched-1", runs: ["session:s1"] }]);
    assert.deepEqual(bodies(h), ["autostart.fire|1 run(s) ended by the stop time; 1 still stopping"]);
  } finally {
    h.dispose();
  }
});

test("T-246: a run kept tracked is attempted again on the next tick", async () => {
  const h = harness({ behaviour: "reject" });
  try {
    const jobs = [jobOf([runOf("session:s1")])];
    await applyZaicodeScheduleStopRules(jobs, h.services, h.forget, NOW);
    await applyZaicodeScheduleStopRules(jobs, h.services, h.forget, NOW + 15_000);
    assert.deepEqual(h.attempts, ["s1", "s1"], "the retry is the run staying in job.runs");
    assert.deepEqual(h.forgets, []);
    assert.deepEqual(h.events(), []);
  } finally {
    h.dispose();
  }
});

test("T-246: a queue job id is not a session run, and the handle is never touched", async () => {
  const h = harness();
  try {
    assert.equal(await stopZaicodeSessionRun(runOf("job-7")), "not-session");
    assert.deepEqual(h.attempts, []);
  } finally {
    h.dispose();
  }
});
