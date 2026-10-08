import assert from "node:assert/strict";
import test from "node:test";
import { zaicodeIdleWindowToStart, type ZaicodeLimitWindow } from "../../shared/src/zaicode-engines.js";

const now = 1_800_000_000_000;
function window(key: string, group: string, remainingPercent: number, durationMinutes: number, startsOnUse = false): ZaicodeLimitWindow {
  return { key, group, groupLabel: group, label: key, remainingPercent, durationMinutes, startsOnUse, resetsAt: null, gatedBy: null, assumedFull: false };
}
function candidate(windows: ZaicodeLimitWindow[]) {
  return zaicodeIdleWindowToStart({
    account: { id: "agy:fixture", vendor: "antigravity", status: "ready" },
    snapshot: { accountId: "agy:fixture", fetchedAt: now, windows, error: null, plan: null },
    config: { keepWindowsRolling: true, hiddenAccounts: [] }, now,
  });
}
test("exhausted Claude/GPT weekly quota cannot prevent starting usable Gemini 5h quota", () => {
  const idle = window("five_hour@gemini_models", "gemini_models", 100, 300, true);
  assert.equal(candidate([window("weekly@claude_and_gpt_models", "claude_and_gpt_models", 0, 10080), idle])?.key, idle.key);
});
test("skip a blocked pool and start another usable pool; never bypass that pool's own weekly gate", () => {
  const claude = window("five_hour@claude_and_gpt_models", "claude_and_gpt_models", 100, 300, true);
  const weekly = window("weekly@claude_and_gpt_models", "claude_and_gpt_models", 0, 10080);
  const gemini = window("five_hour@gemini_models", "gemini_models", 100, 300, true);
  assert.equal(candidate([claude, weekly]), null);
  assert.equal(candidate([claude, weekly, gemini])?.key, gemini.key);
});
