import assert from "node:assert/strict";
import test from "node:test";
import {
  completeZaicodeWindowStarts,
  beginZaicodeWindowStarts,
  isZaicodeWindowWaitingForFirstUse,
  markZaicodeWindowsStartingOnUse,
  parseClaudeUsageText,
  zaicodeIdleWindowToStart,
  zaicodeWindowStartPhase,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
} from "@zcode/shared";

/**
 * T-397 (SRC-298 Wave 3): a Claude account whose five-hour window has never been
 * used answers `/usage` with "Current session: 0% used" -- a FULL window and NO
 * reset line, because there is nothing to reset yet. `markZaicodeWindowsStartingOnUse`
 * only recognised an untouched window by its sliding "reset = read + window" shape,
 * so a null reset left `startsOnUse` false and `zaicodeIdleWindowToStart` refused.
 * The window could never be started by ZAICODE: the exact dead end this ticket names.
 */

const NOW = Date.UTC(2026, 9, 20, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FIVE_HOURS = 5 * HOUR;

const account = { id: "claude:a1", vendor: "claude" as const, status: "ready" as const, cli: "claude" };
const config = { keepWindowsRolling: true, hiddenAccounts: [] as string[] };

function snapshot(windows: ZaicodeLimitWindow[], patch: Partial<ZaicodeLimitSnapshot> = {}): ZaicodeLimitSnapshot {
  return { accountId: account.id, windows, plan: null, fetchedAt: NOW, checkedAt: NOW, error: null, source: "claude", ...patch };
}

/** The vendor's answer for a window nobody has touched: full, no reset line. */
function untouchedRead(readAt = NOW): ZaicodeLimitWindow[] {
  return markZaicodeWindowsStartingOnUse(parseClaudeUsageText("Current session: 0% used", readAt), readAt);
}

test("T-397: a full window with no reset is waiting for its first use, not spent", () => {
  const windows = untouchedRead();
  assert.equal(windows[0]!.key, "five_hour");
  assert.equal(windows[0]!.remainingPercent, 100);
  assert.equal(windows[0]!.resetsAt, null, "the vendor gave no reset: this is the untouched shape");
  assert.equal(isZaicodeWindowWaitingForFirstUse(windows[0]!), true);
  assert.equal(
    zaicodeIdleWindowToStart({ account, snapshot: snapshot(windows), config, now: NOW })?.key,
    "five_hour",
    "a full window with an unknown reset must be startable",
  );
});

test("T-397: one bounded start attempt buys a full window of cooldown", () => {
  const started = snapshot(untouchedRead(), {
    windowStarts: { five_hour: { at: NOW, ok: true, detail: "started with one haiku request", windowKey: "five_hour" } },
  });
  assert.equal(
    zaicodeIdleWindowToStart({ account, snapshot: started, config, now: NOW + MINUTE }),
    null,
    "a start that just ran must not be repeated",
  );
  assert.equal(
    zaicodeIdleWindowToStart({ account, snapshot: started, config, now: NOW + FIVE_HOURS - MINUTE }),
    null,
    "the cooldown is the window itself, not the 15-minute floor",
  );
  // The vendor still reports the untouched shape (some CLI versions never print a
  // reset for a session window), so after the cooldown exactly one new attempt is allowed.
  const next = zaicodeIdleWindowToStart({ account, snapshot: started, config, now: NOW + FIVE_HOURS + MINUTE });
  assert.equal(next?.key, "five_hour");
});

test("T-397: a refused start waits an hour, then the window is offered again", () => {
  const refused = snapshot(untouchedRead(), {
    windowStarts: { five_hour: { at: NOW, ok: false, detail: "not logged in", windowKey: "five_hour" } },
  });
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: refused, config, now: NOW + 30 * MINUTE }), null);
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: refused, config, now: NOW + 61 * MINUTE })?.key, "five_hour");
});

test("T-397: a later quota read is what confirms the start", () => {
  const started = { at: NOW, ok: true, detail: "started with one haiku request", windowKey: "five_hour" };
  const later = markZaicodeWindowsStartingOnUse(
    parseClaudeUsageText("Current session: 0% used · resets Oct 20, 8:00pm (Europe/Tallinn)", NOW + 20_000),
    NOW + 20_000,
    started,
  );
  assert.equal(later[0]!.resetsAt, NOW + FIVE_HOURS);
  assert.equal(later[0]!.rollingFrom, NOW, "the vendor's fixed reset is the proof, not the CLI's exit code");
  assert.equal(isZaicodeWindowWaitingForFirstUse(later[0]!), false);
});

test("T-397: the start state is readable, and it distinguishes requested from confirmed", () => {
  const windows = untouchedRead();
  const phase = (patch: Partial<ZaicodeLimitSnapshot>, now = NOW) =>
    zaicodeWindowStartPhase({ account, snapshot: snapshot(windows, patch), window: windows[0]!, config, now });

  assert.equal(phase({}), "NOT_STARTED");
  assert.equal(
    phase({ windowStarts: { five_hour: { at: NOW, ok: false, detail: "window start pending", windowKey: "five_hour" } } }),
    "START_REQUESTED",
  );
  assert.equal(
    phase({ windowStarts: { five_hour: { at: NOW, ok: false, detail: "not logged in", windowKey: "five_hour" } } }),
    "START_FAILED",
  );
  assert.equal(
    phase(
      { windowStarts: { five_hour: { at: NOW, ok: true, detail: "accepted", windowKey: "five_hour" } } },
      NOW + MINUTE,
    ),
    "COOLDOWN",
  );
  assert.equal(
    phase(
      { windowStarts: { five_hour: { at: NOW, ok: true, detail: "accepted", windowKey: "five_hour" } } },
      NOW + FIVE_HOURS + MINUTE,
    ),
    "START_UNVERIFIED",
    "an accepted request that no vendor read has confirmed is not a started window",
  );
  const confirmed = laterRead();
  assert.equal(
    zaicodeWindowStartPhase({
      account,
      snapshot: snapshot(confirmed, {
        windowStarts: { five_hour: { at: NOW, ok: true, detail: "accepted", windowKey: "five_hour" } },
      }),
      window: confirmed[0]!,
      config,
      now: NOW + FIVE_HOURS + MINUTE,
    }),
    "START_CONFIRMED",
  );
  assert.equal(
    zaicodeWindowStartPhase({
      account: { ...account, status: "login-required" },
      snapshot: snapshot(windows),
      window: windows[0]!,
      config,
      now: NOW,
    }),
    "UNSUPPORTED",
  );
});

function laterRead(): ZaicodeLimitWindow[] {
  return markZaicodeWindowsStartingOnUse(
    parseClaudeUsageText("Current session: 0% used · resets Oct 20, 8:00pm (Europe/Tallinn)", NOW + 20_000),
    NOW + 20_000,
    { at: NOW, ok: true, detail: "accepted", windowKey: "five_hour" },
  );
}

test("T-397: a scoped per-model limit is never turned into a paid start", () => {
  // "Current week (Sonnet): 0% used" with no reset line is scoped to one model; it
  // bounds part of the account, so it must not become a start target merely because
  // it reads full with an unknown reset.
  const scoped = markZaicodeWindowsStartingOnUse(
    parseClaudeUsageText("Current week (Sonnet): 0% used", NOW),
    NOW,
  );
  assert.equal(scoped[0]!.key, "weekly_sonnet");
  assert.equal(scoped[0]!.resetsAt, null);
  assert.equal(isZaicodeWindowWaitingForFirstUse(scoped[0]!), false, "a scoped limit is not a first-use window");
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: snapshot(scoped), config, now: NOW }), null);
});

test("T-397: the ledger records the attempt before the request and completes only its own keys", () => {
  const base = snapshot(untouchedRead());
  const pending = beginZaicodeWindowStarts(base, ["five_hour"], NOW);
  assert.deepEqual(pending.windowStarts!.five_hour, {
    at: NOW,
    ok: false,
    detail: "window start pending",
    windowKey: "five_hour",
  });
  // A sweep that read the account again while the request was in flight must not
  // lose the pending record, and a completion for an older attempt must not win.
  const completed = completeZaicodeWindowStarts(
    pending,
    ["five_hour"],
    NOW,
    { ok: true, detail: "started with one haiku request" },
  );
  assert.equal(completed.windowStarts!.five_hour!.ok, true);
  assert.equal(completed.windowStarts!.five_hour!.at, NOW);
  const stale = completeZaicodeWindowStarts(completed, ["five_hour"], NOW - 5_000, { ok: false, detail: "late" });
  assert.equal(stale.windowStarts!.five_hour!.ok, true, "a completion for an older attempt is ignored");
});
