import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { getTaskListRowActivity, isTaskListRowActive, attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { deriveTaskLeadingIndicator } from "../src/lib/taskListItemPresentation.js";
import { ZaicodeRunClock } from "../src/zaicode/zaicodeRunClock.js";
import {
  ZAICODE_BACKGROUND_STALL_MS,
  ZAICODE_STALL_MS,
  zaicodeSessionStalled,
  zaicodeSessionWorking,
} from "../src/zaicode/zaicodeStall.js";
import { runningSessionsOf } from "../src/zaicode/zaicodeSidebarPrefs.js";

// SRC-081: "I left AUDAPACK for the night; it says it is still working, but it is not" and
// "the elapsed counter is not reset if I press stop, change the model, continue".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");
const MINUTE = 60_000;
const HOUR = 3_600_000;

function task(
  id: string,
  phase: "running" | "completedSuccess",
  lastActivityAt: number,
  hasBackgroundWork = false,
  sessionEnded?: boolean,
): ZCodeTaskMeta {
  return attachTaskListRowActivity(
    { taskId: id, title: id, status: "running", updatedAt: lastActivityAt } as unknown as ZCodeTaskMeta,
    { phase, lastActivityAt, hasBackgroundWork, ...(sessionEnded === undefined ? {} : { sessionEnded }) },
  );
}

test("a real summary carries sessionEnded, and a stale one still stalls", () => {
  // SRC-151:R005/R040: "it still shows Working but the work is long finished".
  // The fixtures above leave sessionEnded undefined, which no real summary ever does:
  // sessionSummarySchema declares it `z.boolean()`, required. Reading that field's
  // *presence* as proof of liveness made the guard unconditionally true, so the stall
  // never fired and every session whose provider stream died kept saying Working.
  const now = 100 * HOUR;
  const summary = (id: string, ended: boolean, age: number) =>
    task(id, "running", now - age, false, ended);
  assert.equal(zaicodeSessionStalled(summary("dead", false, 11 * HOUR), now), true,
    "runtime says the session has not ended, but it has said nothing for 11 hours: that is a stall");
  assert.equal(zaicodeSessionWorking(summary("dead", false, 11 * HOUR), now), false);
  assert.equal(zaicodeSessionStalled(summary("live", false, 60_000), now), false,
    "a session heard from a minute ago is working");
  assert.equal(zaicodeSessionStalled(summary("ended", true, 11 * HOUR), now), false,
    "a session the runtime says has ended is not stalled, it is finished");
  // And the liveness surfaces agree with it.
  const ids = runningSessionsOf("k", [summary("dead", false, 11 * HOUR), summary("live", false, 60_000)], {}, undefined, now)
    .map((session) => session.sessionId);
  assert.deepEqual(ids, ["live"], "the dead one leaves the running list on its own");
});

test("unproven stale foreground is STALLED; a background claim is bounded, not immortal", () => {
  const now = 100 * HOUR;
  const live = task("live", "running", now - 60_000);
  const quiet = task("quiet", "running", now - 11 * HOUR);
  // SRC-129 + SRC-081: a detached job that keeps reporting stays working however long it runs.
  const background = task("bg", "completedSuccess", now - 5 * MINUTE, true);
  const idle = task("idle", "completedSuccess", now - 20 * HOUR);
  assert.equal(zaicodeSessionStalled(live, now), false);
  assert.equal(zaicodeSessionStalled(quiet, now), true);
  assert.equal(
    zaicodeSessionStalled(background, now),
    false,
    "SRC-129: live background evidence (a progress event a minute ago) outranks elapsed silence",
  );
  assert.equal(zaicodeSessionStalled(idle, now), false, "an idle session is not stalled, it is idle");
  assert.equal(zaicodeSessionWorking(live, now), true);
  assert.equal(zaicodeSessionWorking(quiet, now), false);
  // A long tool call is not a stall: silence under the threshold still counts as working.
  assert.equal(zaicodeSessionWorking(task("build", "running", now - (ZAICODE_STALL_MS - 60_000)), now), true);
  // The list every "is anything going" surface reads leaves the stalled one out.
  const ids = runningSessionsOf("k", [live, quiet, background, idle], {}, undefined, now).map((session) => session.sessionId);
  assert.deepEqual(ids, ["live", "bg"]);
});

test("SRC-081 zombie: a session recorded as running background work that went silent is STALLED", () => {
  // The observed defect: the sidebar row said "TEST 5h 16m" for a session whose background
  // test had said nothing for five hours. `hasBackgroundWork` was read as a liveness proof,
  // so the row was exempt from the stall for as long as the *record* kept saying running —
  // which, for a record nothing ever settles, is forever.
  const now = 100 * HOUR;
  const zombie = task("zombie", "completedSuccess", now - (5 * HOUR + 16 * MINUTE), true);
  assert.equal(isTaskListRowActive(zombie), true, "the record still claims running background work");
  assert.equal(
    zaicodeSessionStalled(zombie, now),
    true,
    "five hours and sixteen minutes without a single event is a stall, not a background job",
  );
  assert.equal(zaicodeSessionWorking(zombie, now), false);
  assert.equal(
    deriveTaskLeadingIndicator(zombie, getTaskListRowActivity(zombie), now),
    "none",
    "the row stops spinning a clock that lies",
  );
  // The window is generous but finite, and its edge is the operator's own accepted contract:
  // a silent background test is still working after five hours (zaicodeEfficientAutomation),
  // and one silence longer than that is a stall. Total runtime never matters, only the gap
  // since the last event.
  assert.equal(zaicodeSessionWorking(task("bg-1h", "completedSuccess", now - HOUR, true), now), true);
  assert.equal(
    zaicodeSessionWorking(task("bg-5h", "completedSuccess", now - 5 * HOUR, true), now),
    true,
    "five hours of silence is still inside the accepted contract",
  );
  assert.equal(
    zaicodeSessionWorking(
      task("bg-over", "completedSuccess", now - (ZAICODE_BACKGROUND_STALL_MS + MINUTE), true),
      now,
    ),
    false,
  );
  // A background job that legitimately runs for hours keeps reporting and stays working.
  const marathonStart = now - 9 * HOUR;
  const marathon = task("marathon", "completedSuccess", now - 5_000, true);
  assert.equal(
    zaicodeSessionWorking(marathon, now),
    true,
    `a job running since ${new Date(marathonStart).toISOString()} is alive because it just spoke`,
  );
  const ids = runningSessionsOf("k", [zombie, marathon], {}, undefined, now).map((session) => session.sessionId);
  assert.deepEqual(ids, ["marathon"], "header meter / ambience no longer count the zombie");
});

test("a finished background session is finished, and a persisted stale running row stays stalled across restarts", () => {
  const now = 100 * HOUR;
  const completed = task("completed", "completedSuccess", now - 5 * HOUR, false, true);
  const failed = task("failed", "completedSuccess", now - 5 * HOUR, false, true);
  const cancelled = task("cancelled", "completedSuccess", now - 5 * HOUR, false, true);
  for (const finished of [completed, failed, cancelled]) {
    assert.equal(isTaskListRowActive(finished), false, `${finished.taskId}: no work attached`);
    assert.equal(zaicodeSessionStalled(finished, now), false, "finished is not stalled");
    assert.equal(zaicodeSessionWorking(finished, now), false);
    assert.equal(deriveTaskLeadingIndicator(finished, getTaskListRowActivity(finished), now), "none");
  }
  assert.equal(
    zaicodeSessionWorking(
      task("finished-bg", "completedSuccess", now - (ZAICODE_BACKGROUND_STALL_MS + MINUTE), true, true),
      now,
    ),
    false,
    "a background record the runtime has settled, and that has said nothing since, is not working",
  );
  // Restart: the sidebar is seeded from the persisted sessions-index before any live frame
  // arrives. A stored `running` record keeps its own old timestamp, so it reads as unproven
  // rather than as a session that came back from the dead.
  const restored = task("restored", "running", now - (ZAICODE_BACKGROUND_STALL_MS + 30 * MINUTE), true);
  assert.equal(zaicodeSessionStalled(restored, now), true, "stale persisted running is reconciled to stalled");
  // ...and the first real frame after the restart clears it at once.
  assert.equal(zaicodeSessionWorking(task("restored", "running", now + 500, true), now + 1_000), true);
});

test("Stop, change the model, continue: the working timer starts from zero", () => {
  const clock = new ZaicodeRunClock();
  const start = 1_000_000;
  assert.equal(clock.observe("s", true, start, start + 1), start, "the run began");
  // The operator presses Stop, changes the model (20 s) and continues.
  clock.end("s");
  const resumed = start + 20_000;
  assert.equal(clock.observe("s", true, resumed, resumed), resumed, "a new run, not the old start");
  // Without the Stop the same 20 s gap would have been the same streak (chained turns).
  const chained = new ZaicodeRunClock();
  chained.observe("s", true, start, start + 1);
  chained.observe("s", false, 0, start + 5_000);
  assert.equal(chained.observe("s", true, resumed, resumed), start, "a short idle gap keeps the streak");
});

test("an idle session that is observed idle ends its streak after the grace", () => {
  const clock = new ZaicodeRunClock(90_000);
  clock.observe("s", true, 10, 20);
  clock.observe("s", false, 0, 30_000);
  clock.observe("s", false, 0, 200_000);
  assert.equal(clock.sinceOf("s"), 0);
  assert.equal(clock.observe("s", true, 0, 300_000), 300_000, "the next run starts fresh");
});

test("wiring: the project row observes idle sessions and ends the clock on Stop; STALL is on the row", () => {
  const row = source("WorkspaceSidebarItem.tsx");
  assert.match(row, /zaicodeRunClock\.observe\(task\.taskId, false, 0, now\)/);
  assert.match(row, /completedInterrupted"\) zaicodeRunClock\.end\(task\.taskId\)/);
  assert.match(row, /data-zaicode-project-stalled=/);
  assert.match(source("v4/SessionPane.tsx"), /zaicodeRunClock\.end\(sessionId\);/);
  assert.match(source("zaicode/zaicodeSidebarPrefs.ts"), /zaicodeSessionWorking\(task, now\)/);
});
