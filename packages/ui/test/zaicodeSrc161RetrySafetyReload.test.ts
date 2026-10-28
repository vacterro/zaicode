import assert from "node:assert/strict";
import test from "node:test";

// SRC-161:W2-002 — the retry SAFETY record has to outlive the renderer.
//
// No module that holds retry state is imported statically here: this file plays the part of a
// renderer that has just started, so the record it finds already on disk is what the modules
// hydrate from. That is the whole point of the ticket — a reload must not re-arm the automatic
// senders the operator stopped.

const KEY = "zaicode-retry-safety-v1";
const raw = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => raw.get(key) ?? null,
  setItem: (key: string, value: string) => void raw.set(key, value),
  removeItem: (key: string) => void raw.delete(key),
};

test("W2-002: a fresh renderer hydrates every stop the previous one recorded", async () => {
  // What the previous renderer left behind: the operator stopped everything, closed an error, the
  // session had already spent 5 of its 8 attempts, and its account was sitting on a quota wall.
  raw.set(
    KEY,
    JSON.stringify({
      halted: true,
      attempts: { "sess-a": 5 },
      stoppedErrors: ["err-closed"],
      quotaWalls: { "sess-a": Date.now() },
    }),
  );

  const [{ zaicodeAutoRetryAttempts, isZaicodeAutoRetryStopped }, { useZaicodeRetryLedger, isZaicodeQuotaWall }] =
    await Promise.all([
      import("../src/zaicode/zaicodeAutoRetry.js"),
      import("../src/zaicode/zaicodeRetryPolicy.js"),
    ]);

  assert.equal(useZaicodeRetryLedger.getState().halted, true, "stop-all survives the reload");
  assert.equal(zaicodeAutoRetryAttempts("sess-a"), 5, "the budget is not refreshed by a reload");
  assert.equal(isZaicodeAutoRetryStopped("err-closed"), true, "a closed error stays closed");
  assert.equal(isZaicodeQuotaWall("sess-a", Date.now()), true, "the quota wall is remembered");
});

test("W2-002: an unreadable record degrades to the safe empty one, never to a crash", async () => {
  const { readZaicodeRetrySafety } = await import("../src/zaicode/zaicodeRetrySafety.js");
  raw.set(KEY, "{not json");
  assert.deepEqual(readZaicodeRetrySafety(), {
    halted: false,
    attempts: {},
    stoppedErrors: [],
    quotaWalls: {},
  });

  // Values this app could not have written are dropped, not trusted — a corrupted record must not
  // be able to invent a halt, an attempt count or a quota wall.
  const { writeZaicodeRetrySafety } = await import("../src/zaicode/zaicodeRetrySafety.js");
  writeZaicodeRetrySafety({
    halted: "yes" as unknown as boolean,
    attempts: { bad: Number.NaN, zero: 0, good: 2 },
    stoppedErrors: ["", 7 as unknown as string, "kept"],
    quotaWalls: { bad: "soon" as unknown as number, good: 12 },
  });
  const read = readZaicodeRetrySafety();
  assert.equal(read.halted, false, "only a real boolean halts the senders");
  assert.deepEqual(read.attempts, { good: 2 }, "a spent budget is a positive finite number");
  assert.deepEqual(read.stoppedErrors, ["kept"]);
  assert.deepEqual(read.quotaWalls, { good: 12 });
});
