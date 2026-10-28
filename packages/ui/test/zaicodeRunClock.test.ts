import assert from "node:assert/strict";
import test from "node:test";
import { ZAICODE_RUN_CLOCK_GRACE_MS, ZaicodeRunClock } from "../src/zaicode/zaicodeRunClock.js";

test("the first working observation starts the streak at the feed's own timestamp", () => {
  const clock = new ZaicodeRunClock();
  assert.equal(clock.observe("s", true, 1_000, 5_000), 1_000);
  assert.equal(clock.sinceOf("s"), 1_000);
});

test("a timestamp from the future is clamped to now, and no timestamp means now", () => {
  const clock = new ZaicodeRunClock();
  assert.equal(clock.observe("future", true, 9_000, 5_000), 5_000);
  assert.equal(clock.observe("none", true, 0, 7_000), 7_000);
});

test("opening the session later reads the same start (the composer only reads)", () => {
  const clock = new ZaicodeRunClock();
  clock.observe("s", true, 1_000, 1_000);
  clock.observe("s", true, 50_000, 60_000);
  assert.equal(clock.sinceOf("s"), 1_000);
  assert.equal(clock.sinceOf("never-seen"), 0);
});

test("chained turns inside the grace window are one working streak", () => {
  const clock = new ZaicodeRunClock();
  clock.observe("goal", true, 1_000, 1_000);
  assert.equal(clock.observe("goal", false, 0, 100_000), 0);
  assert.equal(clock.sinceOf("goal"), 0, "an idle gap reads as not working");
  assert.equal(clock.observe("goal", true, 120_000, 100_000 + ZAICODE_RUN_CLOCK_GRACE_MS), 1_000);
});

test("a gap longer than the grace window starts a new streak", () => {
  const clock = new ZaicodeRunClock();
  clock.observe("s", true, 1_000, 1_000);
  clock.observe("s", false, 0, 10_000);
  const resumedAt = 10_000 + ZAICODE_RUN_CLOCK_GRACE_MS + 1;
  assert.equal(clock.observe("s", true, resumedAt, resumedAt), resumedAt);
});

test("an idle session past the grace window is forgotten", () => {
  const clock = new ZaicodeRunClock();
  clock.observe("s", true, 1_000, 1_000);
  clock.observe("s", false, 0, 2_000);
  clock.observe("s", false, 0, 2_000 + ZAICODE_RUN_CLOCK_GRACE_MS + 1);
  assert.equal(clock.observe("s", true, 500_000, 500_000), 500_000);
});
