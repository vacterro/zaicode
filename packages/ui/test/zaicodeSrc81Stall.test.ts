import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { ZaicodeRunClock } from "../src/zaicode/zaicodeRunClock.js";
import { ZAICODE_STALL_MS, zaicodeSessionStalled, zaicodeSessionWorking } from "../src/zaicode/zaicodeStall.js";
import { runningSessionsOf } from "../src/zaicode/zaicodeSidebarPrefs.js";

// SRC-081: "I left AUDAPACK for the night; it says it is still working, but it is not" and
// "the elapsed counter is not reset if I press stop, change the model, continue".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");
const HOUR = 3_600_000;

function task(id: string, phase: "running" | "completedSuccess", lastActivityAt: number, hasBackgroundWork = false): ZCodeTaskMeta {
  return attachTaskListRowActivity(
    { taskId: id, title: id, status: "running", updatedAt: lastActivityAt } as unknown as ZCodeTaskMeta,
    { phase, lastActivityAt, hasBackgroundWork },
  );
}

test("unproven stale foreground is STALLED; confirmed live background remains working", () => {
  const now = 100 * HOUR;
  const live = task("live", "running", now - 60_000);
  const quiet = task("quiet", "running", now - 11 * HOUR);
  const background = task("bg", "completedSuccess", now - 5 * HOUR, true);
  const idle = task("idle", "completedSuccess", now - 20 * HOUR);
  assert.equal(zaicodeSessionStalled(live, now), false);
  assert.equal(zaicodeSessionStalled(quiet, now), true);
  assert.equal(zaicodeSessionStalled(background, now), false, "SRC-129: live background evidence outranks elapsed silence");
  assert.equal(zaicodeSessionStalled(idle, now), false, "an idle session is not stalled, it is idle");
  assert.equal(zaicodeSessionWorking(live, now), true);
  assert.equal(zaicodeSessionWorking(quiet, now), false);
  // A long tool call is not a stall: silence under the threshold still counts as working.
  assert.equal(zaicodeSessionWorking(task("build", "running", now - (ZAICODE_STALL_MS - 60_000)), now), true);
  // The list every "is anything going" surface reads leaves the stalled one out.
  const ids = runningSessionsOf("k", [live, quiet, background, idle], {}, undefined, now).map((session) => session.sessionId);
  assert.deepEqual(ids, ["live", "bg"]);
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
