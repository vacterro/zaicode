import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  zaicodeAnyElapsedRunning,
  zaicodeAnyWorkerRunning,
  zaicodeElapsedMs,
  zaicodeElapsedRunning,
  zaicodeJobElapsedSource,
  zaicodeWorkerElapsedMs,
} from "../src/zaicode/zaicodeElapsed.js";


/**
 * Elapsed time freezes at the terminal transition (SRC-070 item C).
 *
 * The rule the product now follows everywhere: running is `now - startedAt`,
 * terminal is the item's own final stamp minus `startedAt` and never moves
 * again. The reported symptom was a timer that kept counting after the work
 * was done, because the age fell back to `endedAt ?? now` and the render
 * interval stayed alive for as long as the component existed.
 */

const START = 1_000_000;

test("C1 a running item counts with the clock", () => {
  const source = { startedAt: START, completedAt: null };
  assert.equal(zaicodeElapsedMs(source, START), 0);
  assert.equal(zaicodeElapsedMs(source, START + 90_000), 90_000);
  assert.equal(zaicodeElapsedRunning(source), true);
});

test("C2 a terminal item freezes exactly at completion and ignores the clock", () => {
  const source = { startedAt: START, completedAt: START + 90_000 };
  assert.equal(zaicodeElapsedMs(source, START + 90_000), 90_000);
  assert.equal(zaicodeElapsedMs(source, START + 10 * 60_000), 90_000, "an hour later it is still 90s");
  assert.equal(zaicodeElapsedMs(source, Number.MAX_SAFE_INTEGER), 90_000);
  assert.equal(zaicodeElapsedRunning(source), false);
});

test("C3 the frozen value is the same after a reload, because it comes from the record", () => {
  const stored = { startedAt: START, completedAt: START + 45_000 };
  // "Reload": a fresh module read of the same stored record, much later.
  const reloaded = { startedAt: stored.startedAt, completedAt: stored.completedAt };
  const before = zaicodeElapsedMs(stored, START + 45_000);
  const after = zaicodeElapsedMs(reloaded, START + 9 * 24 * 60 * 60_000);
  assert.equal(after, before);
});

test("C4 nothing counts, so no clock runs", () => {
  assert.equal(zaicodeAnyElapsedRunning([{ startedAt: START, completedAt: START + 1 }]), false);
  assert.equal(
    zaicodeAnyElapsedRunning([
      { startedAt: START, completedAt: START + 1 },
      { startedAt: START, completedAt: null },
    ]),
    true,
  );
  assert.equal(zaicodeAnyElapsedRunning([]), false);
});

test("C5 a worker that has exited never counts again", () => {
  const finished = { startedAt: START, endedAt: START + 12_000, exitCode: 0 };
  assert.equal(zaicodeWorkerElapsedMs(finished, START + 12_000), 12_000);
  assert.equal(zaicodeWorkerElapsedMs(finished, START + 3_600_000), 12_000, "still 12s an hour later");
  assert.equal(zaicodeWorkerElapsedMs(finished, Number.MAX_SAFE_INTEGER), 12_000);
  assert.equal(zaicodeAnyWorkerRunning([finished]), false, "no render interval for a finished worker");
});

test("C6 a running worker counts, and keeps the clock alive", () => {
  const running = { startedAt: START, endedAt: null, exitCode: null };
  assert.equal(zaicodeWorkerElapsedMs(running, START + 5_000), 5_000);
  assert.equal(zaicodeAnyWorkerRunning([running]), true);
  assert.equal(zaicodeAnyWorkerRunning([running, { startedAt: START, endedAt: START + 1, exitCode: 0 }]), true);
});

test("C7 a crashed worker (non-zero exit) is terminal too", () => {
  const crashed = { startedAt: START, endedAt: START + 3_000, exitCode: 1 };
  assert.equal(zaicodeWorkerElapsedMs(crashed, START + 600_000), 3_000);
  assert.equal(zaicodeAnyWorkerRunning([crashed]), false);
});

test("C8 a queue job freezes on its own finishedAt and re-derives it after a reload", () => {
  const done = { status: "completed", startedAt: START, createdAt: START - 500, finishedAt: START + 30_000 };
  const source = zaicodeJobElapsedSource(done);
  assert.ok(source);
  assert.equal(source.completedAt, START + 30_000);
  assert.equal(zaicodeElapsedMs(source, START + 30_000), 30_000);
  // Reload: the job comes back from the repo, days later, with the same stamps.
  const reloaded = zaicodeJobElapsedSource({ ...done });
  assert.equal(zaicodeElapsedMs(reloaded!, START + 5 * 24 * 3_600_000), 30_000);
});

test("C9 every product-defined terminal job state freezes, and only those", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const source = zaicodeJobElapsedSource({
      status,
      startedAt: START,
      createdAt: START,
      finishedAt: START + 7_000,
    });
    assert.equal(source?.completedAt, START + 7_000, status);
  }
  for (const status of ["draft", "queued", "ready", "running", "blocked"] as const) {
    const source = zaicodeJobElapsedSource({ status, startedAt: START, createdAt: START });
    assert.equal(source?.completedAt, null, `${status} is still counting`);
  }
});

test("C10 a job that never started has no elapsed to show", () => {
  assert.equal(zaicodeJobElapsedSource({ status: "queued", createdAt: START }), null);
});

test("C11 the elapsed clock is not left running by a mounted component", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/zaicode/ZaicodeWorkerParts.tsx"), "utf8");
  assert.match(source, /export function useZaicodeNow\(intervalMs = 30_000, live = true\)/);
  assert.match(source, /if \(!live\) return;/, "no interval is armed when nothing counts");
  for (const path of [
    "../src/zaicode/ZaicodeSidebarWorkers.tsx",
    "../src/zaicode/ZaicodeWorkersPanel.tsx",
    "../src/zaicode/ZaicodeWorkersDock.tsx",
  ]) {
    const text = readFileSync(join(import.meta.dirname, path), "utf8");
    assert.match(text, /useZaicodeNow\(\d+_000, zaicodeAnyWorkerRunning\(state\.workers\)\)/, path);
  }
});

test("C12 no display derives a finished age from the current clock", () => {
  const parts = readFileSync(join(import.meta.dirname, "../src/zaicode/ZaicodeWorkerParts.tsx"), "utf8");
  assert.equal(parts.includes("(worker.endedAt ?? now) - worker.startedAt"), false);
  assert.match(parts, /zaicodeWorkerElapsedMs\(worker, now\)/);
  const fleet = readFileSync(join(import.meta.dirname, "../src/zaicode/home/ZaicodeHomeFleet.tsx"), "utf8");
  assert.equal(fleet.includes("now - worker.startedAt"), false, "the home fleet used the raw clock");
  assert.match(fleet, /zaicodeWorkerElapsedMs\(worker, now\)/);
});
