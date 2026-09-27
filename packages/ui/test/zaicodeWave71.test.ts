import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_LIVE_HOLD_MS,
  ZAICODE_SIDEBAR_DEFAULT_PREFS,
  normalizeZaicodeSidebarPrefs,
  orderZaicodeProjectSections,
  zaicodeFreshnessBucket,
  type ZaicodeProjectLive,
} from "../src/zaicode/zaicodeSidebarPrefs.js";
import { pickZaicodeBackgroundRetrySessions } from "../src/zaicode/zaicodeTurnRetryWatch.js";
import { buildZaicodeIconBadgeDataUri } from "../src/zaicode/zaicodeIconSlots.js";

// T-71 (SRC-051): the 2026-09-26 feedback wave — LIVE recency + hold,
// freshness buckets, background auto-retry, icon badges (the SUBCHAT model /
// effort checks left with SUBCHAT, SRC-062).

const live = (over: Partial<ZaicodeProjectLive>): ZaicodeProjectLive => ({
  running: 0,
  waiting: 0,
  ratio: 0.5,
  lastActivityAt: 0,
  since: 0,
  ...over,
});

test("LIVE defaults: order is recent and the hold is 2 minutes (SRC-051)", () => {
  assert.equal(ZAICODE_SIDEBAR_DEFAULT_PREFS.liveOrder, "recent");
  assert.equal(ZAICODE_SIDEBAR_DEFAULT_PREFS.liveHoldMs, 120_000);
  // The hold only accepts the offered steps; anything else falls back.
  const normalized = normalizeZaicodeSidebarPrefs({
    ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
    liveHoldMs: 45_000,
  });
  assert.equal(normalized.liveHoldMs, 120_000);
  assert.ok(ZAICODE_LIVE_HOLD_MS.includes(0));
});

test("LIVE hold: a just-finished project keeps its LIVE rank, then drops (no teleport mid-glance)", () => {
  const now = 1_700_000_000_000;
  const prefs = {
    ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
    slots: false,
    liveFirst: true,
    liveHoldMs: 120_000,
  };
  const finish = (lastActivityAt: number) =>
    orderZaicodeProjectSections(["idle", "just-done"], {
      prefs,
      now,
      liveOf: (key) =>
        key === "just-done"
          ? live({ running: 0, waiting: 0, lastActivityAt })
          : live({ lastActivityAt: now - 999_999_999 }),
    }).at(0)!.keys;
  // 60s ago: still live → first. 180s ago: past the 2-minute hold → not live,
  // so both fall back to the list's own order.
  assert.deepEqual(finish(now - 60_000), ["just-done", "idle"]);
  assert.deepEqual(
    finish(now - 180_000),
    ["idle", "just-done"],
    "past the hold it is no longer LIVE-ranked",
  );
  // hold off: drops at once — but with liveFirst the still-live idle project wins
  const noHold = orderZaicodeProjectSections(["idle", "just-done"], {
    prefs: { ...prefs, liveHoldMs: 0 },
    now,
    liveOf: (key) =>
      key === "just-done"
        ? live({ running: 0, lastActivityAt: now - 1_000 })
        : live({ running: 1, lastActivityAt: now }),
  }).at(0)!.keys;
  assert.deepEqual(noHold, ["idle", "just-done"], "with no hold only the running project is LIVE");
});

test("LIVE recent order: most recently active first, whatever the readiness", () => {
  const now = 1_700_000_000_000;
  const prefs = {
    ...ZAICODE_SIDEBAR_DEFAULT_PREFS,
    liveOrder: "recent" as const,
    slots: false,
    liveFirst: true,
  };
  const keys = orderZaicodeProjectSections(["old", "new", "mid"], {
    prefs,
    now,
    liveOf: (key) =>
      live({
        running: 1,
        lastActivityAt: key === "new" ? now : key === "mid" ? now - 60_000 : now - 3_600_000,
        ratio: key === "old" ? 0.9 : 0.1,
      }),
  }).at(0)!.keys;
  assert.deepEqual(keys, ["new", "mid", "old"], "recency decides, not closeness to done");
});

test("freshness buckets: fresh / today / week / stale / none (SRC-051)", () => {
  const now = 1_700_000_000_000;
  assert.equal(zaicodeFreshnessBucket(0, now), "none");
  assert.equal(zaicodeFreshnessBucket(now - 60_000, now), "fresh");
  assert.equal(zaicodeFreshnessBucket(now - 14 * 60_000, now), "fresh");
  assert.equal(zaicodeFreshnessBucket(now - 2 * 60 * 60_000, now), "today");
  assert.equal(zaicodeFreshnessBucket(now - 3 * 24 * 60 * 60_000, now), "week");
  assert.equal(zaicodeFreshnessBucket(now - 30 * 24 * 60 * 60_000, now), "stale");
});

test("background auto-retry: only failed, quiet, non-local sessions of enabled projects inside the budget", () => {
  const brief = (over: Record<string, unknown>) =>
    ({
      sessionId: "s",
      title: "t",
      projectKey: "p",
      workspacePath: "C:/p",
      running: false,
      waiting: false,
      failed: true,
      interrupted: false,
      manuallyStopped: false,
      crashCut: false,
      updatedAt: 0,
      model: null,
      unreadAt: null,
      goalStatus: null,
      goalObjective: null,
      ...over,
    }) as never;
  const pick = (
    briefs: never[],
    over: Partial<Parameters<typeof pickZaicodeBackgroundRetrySessions>[1]> = [],
  ) =>
    pickZaicodeBackgroundRetrySessions(briefs, {
      isLocal: () => false,
      isProjectDisabled: () => false,
      attemptsOf: () => 0,
      maxAttempts: 3,
      ...over,
    });
  const failed = brief({});
  assert.equal(pick([failed]).length, 1, "a failed quiet session is picked up");
  assert.equal(pick([brief({ running: true })]).length, 0, "a running session manages itself");
  assert.equal(
    pick([brief({ waiting: true })]).length,
    0,
    "waiting for the operator is not a failure",
  );
  assert.equal(pick([brief({ failed: false })]).length, 0);
  assert.equal(
    pick([failed], { isLocal: (id) => id === "s" }).length,
    0,
    "the open pane owns its own countdown",
  );
  assert.equal(pick([failed], { isProjectDisabled: () => true }).length, 0);
  assert.equal(pick([failed], { attemptsOf: () => 3, maxAttempts: 3 }).length, 0, "budget spent");
  assert.equal(pick([failed], { attemptsOf: () => 2, maxAttempts: 3 }).length, 1);
});

test("icon badge builder: data URI, escaping, solid vs gradient (worker icon mini-editor output)", () => {
  const solid = buildZaicodeIconBadgeDataUri({
    from: "#c8a028",
    to: "#000000",
    gradient: false,
    glyph: "M",
  });
  assert.ok(solid.startsWith("data:image/svg+xml,"), "it is an SVG data URI the icon slots accept");
  assert.ok(!solid.includes("linearGradient"), "solid fill has no gradient stops");
  const gradient = buildZaicodeIconBadgeDataUri({
    from: "#e8c04a",
    to: "#8a6a10",
    gradient: true,
    glyph: "M",
  });
  assert.ok(gradient.includes("linearGradient"));
  const escaped = buildZaicodeIconBadgeDataUri({
    from: "#fff",
    to: "#fff",
    gradient: false,
    glyph: '<"&>',
  });
  assert.ok(!escaped.includes('<"&>'), "glyph text is entity-escaped inside the SVG");
  assert.ok(decodeURIComponent(escaped).includes("&#60;"), "the escaped entities are present");
});
