import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_LIVE_RAISED_CAP,
  ZAICODE_SIDEBAR_DEFAULT_PREFS,
  normalizeZaicodeSidebarPrefs,
  orderZaicodeProjectSections,
  raiseZaicodeLiveProjects,
  type ZaicodeProjectLive,
} from "../src/zaicode/zaicodeSidebarPrefs.js";

// SRC-060 "Remain in position": with LIVE on, a project that finished used to
// drop back to its manual place once the hold ran out. With the setting on it
// stays up; among idle projects the most recently live come first.

const NOW = 1_800_000_000_000;
const idle = (lastActivityAt = 0): ZaicodeProjectLive => ({ running: 0, waiting: 0, ratio: 0, lastActivityAt, since: 0 });
const running = (lastActivityAt: number): ZaicodeProjectLive => ({ running: 1, waiting: 0, ratio: 0, lastActivityAt, since: lastActivityAt });

function order(prefs: Partial<typeof ZAICODE_SIDEBAR_DEFAULT_PREFS>, live: Record<string, ZaicodeProjectLive>) {
  return orderZaicodeProjectSections(["a", "b", "c", "d"], {
    prefs: { ...ZAICODE_SIDEBAR_DEFAULT_PREFS, slots: false, liveFirst: true, liveHoldMs: 0, ...prefs },
    liveOf: (key) => live[key],
    now: NOW,
  })[0]!.keys;
}

test("without Remain in position a finished project drops back to its manual place", () => {
  assert.deepEqual(order({}, { c: idle(NOW - 5_000) }), ["a", "b", "c", "d"]);
});

test("with Remain in position a finished project stays up, most recently live first", () => {
  const liveRaised = { c: NOW - 5_000, d: NOW - 60_000 };
  assert.deepEqual(order({ liveRemain: true, liveRaised }, { c: idle(), d: idle() }), ["c", "d", "a", "b"]);
  // A project working right now is still above every idle one.
  assert.deepEqual(
    order({ liveRemain: true, liveRaised }, { b: running(NOW), c: idle(), d: idle() }),
    ["b", "c", "d", "a"],
  );
});

test("the live moment is stored at most once a minute and capped", () => {
  assert.equal(raiseZaicodeLiveProjects({}, []), null);
  const first = raiseZaicodeLiveProjects({}, [{ key: "a", at: NOW }]);
  assert.deepEqual(first, { a: NOW });
  assert.equal(raiseZaicodeLiveProjects(first!, [{ key: "a", at: NOW + 30_000 }]), null);
  assert.deepEqual(raiseZaicodeLiveProjects(first!, [{ key: "a", at: NOW + 60_000 }]), { a: NOW + 60_000 });
  const many = Object.fromEntries(Array.from({ length: ZAICODE_LIVE_RAISED_CAP }, (_, index) => [`p${index}`, NOW - index - 1]));
  const capped = raiseZaicodeLiveProjects(many, [{ key: "new", at: NOW }])!;
  assert.equal(Object.keys(capped).length, ZAICODE_LIVE_RAISED_CAP);
  assert.equal(capped.new, NOW);
  assert.equal(capped[`p${ZAICODE_LIVE_RAISED_CAP - 1}`], undefined, "the oldest raise is forgotten");
});

test("stored prefs normalize: Remain off by default, bad raise entries dropped", () => {
  const prefs = normalizeZaicodeSidebarPrefs({ liveRaised: { a: 5, b: "x", c: -1, d: Number.NaN } });
  assert.equal(prefs.liveRemain, false);
  assert.deepEqual(prefs.liveRaised, { a: 5 });
  assert.equal(normalizeZaicodeSidebarPrefs({ liveRemain: true }).liveRemain, true);
});
