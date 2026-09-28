import assert from "node:assert/strict";
import test from "node:test";
import { ZAICODE_PROTRAIL_GLOBAL_OFF, type ZaicodeProtrailGlobalStatus } from "@zcode/shared";
import {
  runZaicodeProtrailGlobalConverge,
  zaicodeProtrailGlobalConverged,
  zaicodeProtrailGlobalRetryDelay,
  type ProtrailConvergePort,
} from "../src/zaicode/protrail/protrailGlobalConverge.js";

/**
 * The window's half of ProTrail startup (SRC-070 item A).
 *
 * A persisted-enabled ProTrail must reach `running` with overlays on its own.
 * The old starter was one `set` behind a 40 ms debounce with no retry and a
 * module-global poison flag, so a handler that was not registered yet, a
 * display list that had not settled or a Raw Input helper still compiling all
 * ended the same way: dead until the operator opened Settings and toggled it.
 */

function clock() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    setTimeout(fn: () => void, ms = 0) {
      const id = ++seq;
      jobs.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number) {
      jobs.delete(id);
    },
    pending: () => jobs.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        jobs.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function running(displays: number): ZaicodeProtrailGlobalStatus {
  return { state: "running", input: "raw-input", displays, note: null };
}

function runner(overrides: Partial<ProtrailConvergePort> = {}) {
  const time = clock();
  const seen: (ZaicodeProtrailGlobalStatus | null)[] = [];
  const events: string[] = [];
  const port: ProtrailConvergePort = {
    set: async () => running(2),
    status: async () => running(2),
    ...overrides,
  };
  const stop = runZaicodeProtrailGlobalConverge(port, {
    wanted: true,
    config: { color: "red" },
    onStatus: (next) => { seen.push(next); },
    onRecovered: () => events.push("recovered"),
    onUnavailable: () => events.push("unavailable"),
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  return { time, seen, events, port, stop, last: () => seen.at(-1) };
}

test("A7 the desktop refusing the first call is 'not yet', not 'this build cannot draw'", async () => {
  let calls = 0;
  const h = runner({
    set: async () => {
      calls += 1;
      // The platform handlers are registered a tick after the first window.
      if (calls < 3) throw new Error("No handler registered for 'zaicode:set-protrail-global'");
      return running(2);
    },
  });
  await h.time.advance(60_000);
  assert.equal(h.last()?.state, "running", "converged on the third attempt without operator action");
  assert.equal(h.events.includes("unavailable"), false);
});

test("A8 a desktop that answers nothing at all is reported honestly, not retried forever", async () => {
  const h = runner({
    set: async () => { throw new Error("no handler"); },
    status: async () => { throw new Error("no handler"); },
  });
  await h.time.advance(120_000);
  assert.equal(h.events.filter((event) => event === "unavailable").length, 1, "reported once, not repeatedly");
  assert.equal(h.time.pending(), 0, "the loop stops once the answer will not change");
  assert.equal(h.events.includes("recovered"), false, "nothing is claimed from a desktop that never answered");
});

test("A9 a desktop that refuses the call but still answers its status is not 'unavailable'", async () => {
  const h = runner({
    set: async () => { throw new Error("not registered yet"); },
    status: async () => running(0),
  });
  await h.time.advance(120_000);
  assert.equal(h.events.includes("unavailable"), false, "the desktop is there, its handler is just late");
});

test("A10 'starting' with no overlay keeps asking until the trail is really drawn", async () => {
  let attempt = 0;
  const h = runner({
    set: async () => {
      attempt += 1;
      if (attempt < 4) return { state: "starting", input: "none", displays: 0, note: null };
      return running(3);
    },
  });
  await h.time.advance(60_000);
  assert.equal(h.last()?.state, "running");
  assert.equal(h.last()?.displays, 3, "a start with zero overlays is not a converged one");
});

test("A11 once converged the loop stops: a healthy ProTrail costs one call", async () => {
  let calls = 0;
  const h = runner({ set: async () => { calls += 1; return running(2); } });
  await h.time.advance(60_000);
  assert.equal(calls, 1);
  assert.equal(h.time.pending(), 0);
});

test("A12 switching the mode off converges too: 'off' is the answer, not a retry", async () => {
  const time = clock();
  let calls = 0;
  const stop = runZaicodeProtrailGlobalConverge(
    {
      set: async () => { calls += 1; return { ...ZAICODE_PROTRAIL_GLOBAL_OFF }; },
      status: async () => ({ ...ZAICODE_PROTRAIL_GLOBAL_OFF }),
    },
    {
      wanted: false,
      config: null,
      onStatus: () => {},
      onRecovered: () => {},
      onUnavailable: () => {},
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
    },
  );
  await time.advance(60_000);
  assert.equal(calls, 1, "one call, then silence");
  stop();
});

test("A13 a disposed loop never touches the desktop again", async () => {
  let calls = 0;
  const h = runner({ set: async () => { calls += 1; return running(0); } });
  await h.time.advance(60_000);
  const before = calls;
  h.stop();
  await h.time.advance(60_000);
  assert.equal(calls, before, "a remounted tree does not double-dispatch");
});

test("A14 the retry cadence backs off and stays bounded", () => {
  assert.equal(zaicodeProtrailGlobalRetryDelay(1), 250);
  assert.equal(zaicodeProtrailGlobalRetryDelay(2), 500);
  assert.equal(zaicodeProtrailGlobalRetryDelay(3), 1000);
  assert.equal(zaicodeProtrailGlobalRetryDelay(20), 4000);
  assert.equal(zaicodeProtrailGlobalRetryDelay(999), 4000, "never grows without a ceiling");
});

test("A15 convergence means running AND loaded, not running alone", () => {
  assert.equal(zaicodeProtrailGlobalConverged(running(1), true), true);
  assert.equal(zaicodeProtrailGlobalConverged(running(0), true), false);
  assert.equal(zaicodeProtrailGlobalConverged({ state: "starting", input: "none", displays: 3, note: null }, true), false);
  assert.equal(zaicodeProtrailGlobalConverged(ZAICODE_PROTRAIL_GLOBAL_OFF, false), true);
  assert.equal(zaicodeProtrailGlobalConverged(running(2), false), false);
});
