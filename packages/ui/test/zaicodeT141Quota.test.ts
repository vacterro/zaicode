import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodexRateLimits, zaicodeShouldStartIdleWindow, zaicodeBottleneck, effectiveZaicodeWindows, type ZaicodeLimitWindow } from "../../shared/src/zaicode-engines.js";

const now = 1_800_000_000_000;
function quota(key: string, group = "", remainingPercent = 100, startsOnUse = true): ZaicodeLimitWindow {
  return { key, group, groupLabel: group, label: key, remainingPercent, startsOnUse,
    resetsAt: null, durationMinutes: 300, gatedBy: null, assumedFull: false };
}
function shouldStart(windows: ZaicodeLimitWindow[]) {
  return zaicodeShouldStartIdleWindow({
    account: { id: "codex:2", vendor: "codex", status: "ready" },
    snapshot: { accountId: "codex:2", fetchedAt: now, windows, error: null, plan: "plus" },
    config: { keepWindowsRolling: true, hiddenAccounts: [] }, now,
  });
}
test("a standby reserve cannot start an exhausted primary quota", () => {
  assert.equal(shouldStart([quota("five_hour", "", 0, false), quota("weekly@gpt-reserve", "gpt-reserve")]), false);
});
test("a reserve alone is not a primary window, a full idle primary can start", () => {
  assert.equal(shouldStart([quota("weekly@gpt-reserve", "gpt-reserve")]), false);
  assert.equal(shouldStart([quota("five_hour"), quota("weekly@gpt-reserve", "gpt-reserve")]), true);
});
test("a spent weekly primary prevents starting a fresh 5h window", () => {
  assert.equal(shouldStart([quota("five_hour"), { ...quota("weekly", "", 0, false), durationMinutes: 10080 }]), false);
});
test("primary Codex rows precede reserve even when the API lists reserve first", () => {
  const result = parseCodexRateLimits({ rateLimitsByLimitId: {
    "gpt-reserve": { secondary: { windowDurationMins: 10080, usedPercent: 0 } },
    codex: { primary: { windowDurationMins: 300, usedPercent: 100 }, secondary: { windowDurationMins: 10080, usedPercent: 39 } },
  } });
  assert.deepEqual(result.windows.map((w) => w.group), ["", "", "gpt-reserve"]);
  assert.deepEqual(effectiveZaicodeWindows([...result.windows].reverse(), now).map((w) => w.group), ["", "", "gpt-reserve"]);
});

test("standby reserve stays behind usable primary quota and becomes usable only after exhaustion", () => {
  const reserve = quota("weekly@gpt-reserve", "gpt-reserve");
  assert.equal(zaicodeBottleneck([quota("five_hour", "", 50), reserve], now)?.remainingPercent, 50);
  assert.equal(zaicodeBottleneck([quota("five_hour", "", 0), reserve], now)?.group, "gpt-reserve");
  assert.equal(zaicodeBottleneck([reserve], now), null);
});
