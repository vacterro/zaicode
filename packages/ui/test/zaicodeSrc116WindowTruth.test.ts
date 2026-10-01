import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatZaicodeWindowReset,
  isZaicodeWindowWaitingForFirstUse,
  markZaicodeWindowsStartingOnUse,
  ZAICODE_WINDOW_START_COOLDOWN_MS,
  zaicodeIdleWindowToStart,
  zaicodeWindowShowsLiveCountdown,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
} from "@zcode/shared";
import { zaicodeNextResetOf } from "../src/zaicode/home/zaicodeHomeModel.js";

/**
 * SRC-116 TRACK C: the Antigravity / ZCode rolling window must be true everywhere.
 *
 * The operator saw "window started by ZAICODE 13m ago" in one tooltip and "starts on first
 * use" in the row under it, while the topbar clock and SAIHOME showed no countdown at all.
 * Four surfaces each re-asked "is this window waiting for somebody's first request?" in their
 * own words, and a window persisted by a pre-T-143 build answered yes forever.
 */

const HOUR = 60 * 60_000;
const READ = Date.UTC(2026, 9, 1, 12, 0, 0);

function win(partial: Partial<ZaicodeLimitWindow> & { key: string }): ZaicodeLimitWindow {
  return {
    key: partial.key,
    label: partial.label ?? "5h",
    group: partial.group ?? "",
    groupLabel: partial.groupLabel ?? "",
    remainingPercent: partial.remainingPercent ?? 100,
    resetsAt: partial.resetsAt ?? READ + 5 * HOUR,
    durationMinutes: partial.durationMinutes ?? 300,
    gatedBy: partial.gatedBy ?? null,
    assumedFull: partial.assumedFull ?? false,
    startsOnUse: partial.startsOnUse ?? false,
    ...(partial.rollingFrom === undefined ? {} : { rollingFrom: partial.rollingFrom }),
  };
}

function snapshot(windows: ZaicodeLimitWindow[]): ZaicodeLimitSnapshot {
  return { accountId: "agy", windows, plan: null, fetchedAt: READ, checkedAt: READ, error: null, source: "test" };
}

const account = { id: "agy", vendor: "antigravity", status: "ready" } as ZaicodeEngineAccount;
const config = { keepWindowsRolling: true, hiddenAccounts: [] };

test("a window persisted as waiting for first use heals on the next read", () => {
  // The exact shape a pre-T-143 build wrote to zaicode-engines-cache.json: flagged as
  // unstarted, with nothing to count down, and a vendor reset that is no longer read+5h.
  const stale = [win({ key: "five_hour", startsOnUse: true, resetsAt: READ + 4 * HOUR })];
  const healed = markZaicodeWindowsStartingOnUse(stale, READ, null, stale);

  assert.equal(healed[0]?.rollingFrom, READ);
  assert.equal(healed[0]?.resetsAt, READ + 5 * HOUR);
  assert.equal(isZaicodeWindowWaitingForFirstUse(healed[0]!), false);
  assert.doesNotMatch(formatZaicodeWindowReset(healed[0]!, READ), /starts on first use/);
});

test("an expired anchor rolls forward instead of restarting at a full window", () => {
  const previous = [win({ key: "five_hour", startsOnUse: true, rollingFrom: READ })];
  const later = READ + 5 * HOUR + 10 * 60_000;
  // 5 h and 10 min later the window ZAICODE anchored has run out. The vendor still reports the
  // sliding "read time + 5 h"; re-anchoring that to "now" is the "5 h again every 5 minutes"
  // slide this whole function exists to prevent.
  const vendor = [win({ key: "five_hour", resetsAt: later + 5 * HOUR, remainingPercent: 100 })];
  const swept = markZaicodeWindowsStartingOnUse(vendor, later, null, previous);

  assert.equal(swept[0]?.rollingFrom, READ + 5 * HOUR);
  assert.equal(swept[0]?.resetsAt, READ + 10 * HOUR);
  assert.ok((swept[0]?.resetsAt ?? 0) - later < 5 * HOUR, "the countdown must keep running, not restart");
});

test("a rolling window shows its countdown on the surfaces that skipped it at 100%", () => {
  const rolling = win({ key: "five_hour", startsOnUse: true, rollingFrom: READ, resetsAt: READ + 5 * HOUR });
  assert.equal(rolling.remainingPercent, 100, "a rolling window reads 100% by construction");

  assert.equal(zaicodeWindowShowsLiveCountdown(rolling, READ + HOUR), true, "topbar clock / SAIHOME filter");
  assert.equal(zaicodeNextResetOf(snapshot([rolling]), READ + HOUR), READ + 5 * HOUR);

  // A window genuinely waiting for its first request still has no coming refill.
  const waiting = win({ key: "five_hour", startsOnUse: true, resetsAt: READ + 5 * HOUR });
  assert.equal(zaicodeWindowShowsLiveCountdown(waiting, READ), false);
});

test("a start cooldown on one window does not hide a second pool's idle window", () => {
  const twoPools = [
    win({ key: "five_hour@gemini", startsOnUse: true }),
    win({ key: "five_hour@claude", startsOnUse: true }),
  ];
  const startedGemini: ZaicodeLimitSnapshot = {
    ...snapshot(twoPools),
    windowStart: { at: READ, ok: true, detail: "ok", windowKey: "five_hour@gemini" },
  };

  assert.equal(
    zaicodeIdleWindowToStart({ account, snapshot: startedGemini, config, now: READ + 60_000 })?.key,
    "five_hour@claude",
    "Antigravity's second pool goes idle behind the first one and must still be startable",
  );

  const own = zaicodeIdleWindowToStart({
    account,
    snapshot: { ...startedGemini, windowStart: { at: READ, ok: true, detail: "ok", windowKey: "five_hour@claude" } },
    config,
    now: READ + 60_000,
  });
  assert.equal(own?.key, "five_hour@gemini", "and the other way round");

  assert.equal(
    zaicodeIdleWindowToStart({ account, snapshot: startedGemini, config, now: READ + ZAICODE_WINDOW_START_COOLDOWN_MS })
      ?.key,
    "five_hour@gemini",
    "after the cooldown every idle pool is startable again",
  );
});