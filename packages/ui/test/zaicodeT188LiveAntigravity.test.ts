/**
 * T-188: supplementary cache diagnostics from the live Antigravity profile.
 *
 * The frozen nine-case oracle (test/zaicodeT188WindowStart.test.ts) proves the
 * behaviour on hand-built windows. This file replays product functions
 * over the bytes the running app actually wrote to
 * %APPDATA%/ZAICODE/zaicode-engines-cache.json, so the acceptance reads the
 * persisted numbers rather than the test's. It does not initiate a starter,
 * observe either rendered UI surface, or observe a restart. Its results cannot
 * satisfy C5's frozen packaged before/start/sweeps/restart acceptance.
 *
 * It skips -- never fabricates -- when the live cache is absent, unreadable, or
 * carries a vendor error: a missing account is "not proven", never "passed".
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  markZaicodeWindowsStartingOnUse,
  isZaicodeWindowWaitingForFirstUse,
  zaicodeIdleWindowToStart,
  zaicodeWindowShowsLiveCountdown,
  effectiveZaicodeWindows,
  formatZaicodeWindowReset,
  type ZaicodeLimitWindow,
  type ZaicodeLimitSnapshot,
  type ZaicodeWindowStartRecord,
} from "@zcode/shared";

/**
 * ZAICODE_LIVE_CACHE is the deliberate-red seam: it points the same assertions at a
 * doctored copy of the cache for diagnostic negative controls. That is not the
 * required pre-fix implementation differential. Unset, it reads the real profile.
 */
const CACHE = process.env.ZAICODE_LIVE_CACHE ?? join(homedir(), "AppData", "Roaming", "ZAICODE", "zaicode-engines-cache.json");

interface LiveCache {
  lastSweepAt?: number;
  limits?: Record<string, {
    accountId: string;
    error: string | null;
    source: string;
    fetchedAt: number;
    checkedAt: number;
    plan: string | null;
    windowStart?: ZaicodeWindowStartRecord | null;
    windowStarts?: Record<string, ZaicodeWindowStartRecord> | null;
    windows?: ZaicodeLimitWindow[];
  }>;
}

function live(): LiveCache | null {
  if (!existsSync(CACHE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE, "utf8")) as LiveCache;
  } catch {
    return null;
  }
}

/** The Antigravity snapshot, or null when there is nothing vendor-backed to assert. */
function antigravity(): ZaicodeLimitSnapshot | null {
  const state = live()?.limits?.["antigravity:default"];
  if (!state || !Array.isArray(state.windows) || state.windows.length === 0) return null;
  if (state.error !== null) return null;
  if (!state.source.startsWith("agy")) return null;
  return {
    accountId: state.accountId,
    windows: state.windows,
    plan: state.plan ?? null,
    fetchedAt: state.fetchedAt,
    checkedAt: state.checkedAt,
    error: null,
    source: state.source,
  };
}

function anchors(): { latest: ZaicodeWindowStartRecord | null; starts: Record<string, ZaicodeWindowStartRecord> } {
  const state = live()?.limits?.["antigravity:default"];
  return { latest: state?.windowStart ?? null, starts: state?.windowStarts ?? {} };
}

test("the live Antigravity snapshot is vendor-backed and error-free", (t) => {
  const snapshot = antigravity();
  if (!snapshot) return t.skip("no vendor-backed Antigravity snapshot in the live cache");
  assert.equal(snapshot.error, null);
  assert.ok(snapshot.source.startsWith("agy"), `source was ${snapshot.source}`);
  assert.ok(snapshot.fetchedAt > 0, "the snapshot carries no fetch time");
  for (const window of snapshot.windows) {
    assert.equal(window.assumedFull, false, `${window.key} was assumed full, not read from the vendor`);
  }
});

test("a live vendor window that has started shows a live countdown and is not re-startable", (t) => {
  const snapshot = antigravity();
  if (!snapshot) return t.skip("no vendor-backed Antigravity snapshot in the live cache");
  const { latest, starts } = anchors();
  const readAt = snapshot.fetchedAt;
  const marked = markZaicodeWindowsStartingOnUse(snapshot.windows, readAt, latest, null, starts);
  // Replaying the real sweep must not invent a "starts at first use" on a window the
  // vendor has already reported as rolling: every window here is read, not idle-guessed.
  const started = marked.filter((window) => !isZaicodeWindowWaitingForFirstUse(window));
  assert.ok(started.length > 0, "no live window was recognised as started");
  for (const window of started) {
    assert.equal(window.rollingFrom === undefined || Number.isFinite(window.rollingFrom), true);
    assert.equal(
      zaicodeWindowShowsLiveCountdown(window, readAt),
      window.rollingFrom !== undefined || (window.resetsAt !== null && window.resetsAt > readAt),
      `${window.key} claims a countdown its own data does not support`,
    );
  }
});

test("the live idle-window admission returns a window that owes no fabricated countdown", (t) => {
  const snapshot = antigravity();
  if (!snapshot) return t.skip("no vendor-backed Antigravity snapshot in the live cache");
  const { latest, starts } = anchors();
  const readAt = snapshot.fetchedAt;
  const marked = markZaicodeWindowsStartingOnUse(snapshot.windows, readAt, latest, null, starts);
  const idle = zaicodeIdleWindowToStart(
    { account: { id: "antigravity:default", vendor: "antigravity", status: "ready" }, snapshot: { ...snapshot, windows: marked }, config: { keepWindowsRolling: true, hiddenAccounts: [] }, now: readAt },
  );
  // No admission is a legitimate outcome on a live account that is simply busy; the
  // acceptance is that WHENEVER one is offered it carries no invented countdown.
  if (idle) assert.equal(zaicodeWindowShowsLiveCountdown(idle, readAt), false, `${idle.key} was admitted with a fabricated countdown`);
});

test("cached windows format vendor reset text through the shared formatter", (t) => {
  const snapshot = antigravity();
  if (!snapshot) return t.skip("no vendor-backed Antigravity snapshot in the live cache");
  const now = Date.now();
  // 两次调用同一纯函数不能证明两个视图一致；真正的 UI 比较由冻结的包内测试负责。
  const windows = effectiveZaicodeWindows(snapshot.windows, now);
  assert.ok(windows.length > 0, "the live account exposed no window to format");
  for (const window of windows) {
    const text = formatZaicodeWindowReset(window, now);
    if (isZaicodeWindowWaitingForFirstUse(window)) {
      assert.match(text, /^starts on first use/, `${window.key} renders "${text}" while waiting for first use`);
    } else if (window.resetsAt !== null && window.resetsAt > now && !window.assumedFull && !window.gatedBy) {
      // A live vendor reset renders as a countdown inside two days and as a weekday
      // time beyond that (formatZaicodeReset); anything else is a fabricated fill.
      assert.match(text, /^(resets in |resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) )/, `${window.key} renders "${text}" but the vendor reset is in the future`);
    }
  }
});
