import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_SIDEBAR_DEFAULT_PREFS,
  normalizeZaicodeSidebarPrefs,
  orderZaicodeProjectSections,
} from "../src/zaicode/zaicodeSidebarPrefs.js";
import type { ZaicodeProjectLive } from "../src/zaicode/zaicodeSidebarPrefs.js";

// SRC-060: "если проект завершил работу, добавь Remain it position чтобы он
// обратно не прыгал в своё обратное место после завершения" -- a finished
// project must not jump back down the hierarchy.
//
// The grace hold alone could not express this: it is a timer, and the operator
// wants the position to be kept, not the row to be kept for a while.

const live = (over: Partial<ZaicodeProjectLive>): ZaicodeProjectLive => ({
  running: 0,
  waiting: 0,
  lastActivityAt: 0,
  ratio: 0,
  ...over,
} as ZaicodeProjectLive);

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function orderAfterFinish(remain: boolean): string[] {
  return orderZaicodeProjectSections(["quiet", "finished"], {
    prefs: {
      ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
      slots: false,
      liveFirst: true,
      liveHoldMs: 120_000,
      liveRemainInPosition: remain,
    },
    now: NOW,
    // "finished" stopped working an hour ago, far past any grace hold.
    liveOf: (key) =>
      key === "finished"
        ? live({ lastActivityAt: NOW - HOUR })
        : live({ lastActivityAt: NOW - 10 * HOUR }),
  }).at(0)!.keys;
}

test("Remain in position is off by default, so nothing changes for existing users", () => {
  assert.equal(ZAICODE_SIDEBAR_DEFAULT_PREFS.liveRemainInPosition, false);
});

test("the setting is normalized, and a junk value falls back to the default", () => {
  const on = normalizeZaicodeSidebarPrefs({
    ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
    liveRemainInPosition: true,
  });
  assert.equal(on.liveRemainInPosition, true);
  const junk = normalizeZaicodeSidebarPrefs({
    ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
    liveRemainInPosition: "yes" as unknown as boolean,
  });
  assert.equal(junk.liveRemainInPosition, false);
});

test("off: a project that finished an hour ago drops back, unchanged from before", () => {
  assert.deepEqual(orderAfterFinish(false), ["quiet", "finished"]);
});

test("on: a project that finished an hour ago keeps its LIVE rank", () => {
  assert.deepEqual(orderAfterFinish(true), ["finished", "quiet"]);
});

test("on: the rule needs a real activity record, so a project never seen live stays put", () => {
  const order = orderZaicodeProjectSections(["never"], {
    prefs: {
      ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
      slots: false,
      liveFirst: true,
      liveRemainInPosition: true,
    },
    now: NOW,
    liveOf: () => live({ lastActivityAt: 0 }),
  }).at(0)!.keys;
  assert.deepEqual(order, ["never"]);
});

test("on: a project that is still running outranks one that merely stayed", () => {
  const order = orderZaicodeProjectSections(["stayed", "running"], {
    prefs: {
      ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
      slots: false,
      liveFirst: true,
      liveRemainInPosition: true,
    },
    now: NOW,
    liveOf: (key) =>
      key === "running"
        ? live({ running: 2, lastActivityAt: NOW - HOUR })
        : live({ lastActivityAt: NOW - 2 * HOUR }),
  }).at(0)!.keys;
  assert.deepEqual(order, ["running", "stayed"]);
});
