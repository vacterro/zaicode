import assert from "node:assert/strict";
import { test } from "node:test";
import { ZAICODE_UI_DEFAULT_PREFS, normalizeZaicodeUiPrefs, zaicodeAutoRetryPatch, type ZaicodeAutoRetryScope } from "../src/zaicode/zaicodeUiPrefs.js";
import { zaicodeEffectiveAutoRetry } from "../src/zaicode/zaicodeRetryPolicy.js";
import { zaicodeWorkerQuota } from "../src/zaicode/zaicodeWorkerQuota.js";
import { normalizeZaicodePresentation, ZAICODE_PRESENTATIONS } from "../src/zaicode/zaicodePresentation.js";
import type { ZaicodeLimitSnapshot, ZaicodeLimitWindow } from "@zcode/shared";

test("REQ-006: effective retry matrix survives reload and edit-scope changes", () => {
  for (const global of [false, true]) for (const project of [undefined, false, true]) for (const session of [undefined, false, true]) for (const scope of ["global", "project", "session"] as ZaicodeAutoRetryScope[]) for (const masterOn of [false, true]) {
    const prefs = normalizeZaicodeUiPrefs(JSON.parse(JSON.stringify({ ...ZAICODE_UI_DEFAULT_PREFS, autoRetry: global, autoRetryScope: scope, autoRetryProjects: project === undefined ? {} : { p: project }, autoRetrySessions: session === undefined ? {} : { s: session } })));
    const expected = session ?? project ?? global;
    const effective = zaicodeEffectiveAutoRetry(prefs, "p", "s", { masterOn, halted: false });
    assert.equal(effective.preference, expected, JSON.stringify({ global, project, session, scope }));
    // SRC-162: an explicit project/session ON is its own answer; only the inherited global follows the master.
    assert.equal(effective.enabled, expected && (masterOn || session !== undefined || project !== undefined));
    assert.equal(effective.source, session !== undefined ? "session" : project !== undefined ? "project" : "global");
    assert.equal(zaicodeEffectiveAutoRetry(prefs, "p", "s", { masterOn: true, halted: true }).enabled, false);
    assert.equal(zaicodeEffectiveAutoRetry(prefs, "p", "s", { masterOn: true, halted: false, sessionMode: "off" }).enabled, false);
  }
});

test("REQ-006: session editing cannot alter a project without a session; inherit restores its parent", () => {
  const prefs = { ...ZAICODE_UI_DEFAULT_PREFS, autoRetryScope: "session" as const, autoRetryProjects: { p: false } };
  assert.deepEqual(zaicodeAutoRetryPatch(prefs, "p", true), {});
  const patch = zaicodeAutoRetryPatch(prefs, "p", true, "s");
  assert.deepEqual(patch, { autoRetrySessions: { s: true } });
  assert.equal(zaicodeEffectiveAutoRetry({ ...prefs, ...patch }, "p", "s", { masterOn: true, halted: false }).enabled, true);
  assert.equal(zaicodeEffectiveAutoRetry(prefs, "p", "s", { masterOn: true, halted: false }).enabled, false);
});

const now = 100_000_000;
const windowOf = (key: string, percent: number | null, patch: Partial<ZaicodeLimitWindow> = {}): ZaicodeLimitWindow => ({ key, label: key === "five_hour" ? "5h" : "weekly", remainingPercent: percent, resetsAt: now + 60_000, durationMinutes: key === "five_hour" ? 300 : 10080, group: "", groupLabel: "", gatedBy: null, assumedFull: false, ...patch });
const snapshotOf = (windows: ZaicodeLimitWindow[], patch: Partial<ZaicodeLimitSnapshot> = {}): ZaicodeLimitSnapshot => ({ accountId: "codex:one", windows, fetchedAt: now, checkedAt: now, error: null, source: "vendor", plan: null, ...patch });

test("REQ-009: worker meters distinguish 5h/weekly, zero, unknown, stale and unproven reset", () => {
  const snapshot = snapshotOf([windowOf("five_hour", 51), windowOf("weekly", 0)]);
  assert.deepEqual(zaicodeWorkerQuota(snapshot, now).map(({ label, state, percent }) => ({ label, state, percent })), [{ label: "5h", state: "known", percent: 51 }, { label: "W", state: "known", percent: 0 }]);
  assert.ok(zaicodeWorkerQuota(snapshot, now).every((meter) => meter.detail.includes("weekly") || meter.detail.includes("5h")));
  assert.ok(zaicodeWorkerQuota(undefined, now).every((meter) => meter.percent === null && meter.state === "unknown"));
  assert.ok(zaicodeWorkerQuota(snapshotOf(snapshot.windows, { error: "offline" }), now).every((meter) => meter.percent === null && meter.state === "stale"));
  assert.ok(zaicodeWorkerQuota(snapshot, now + 16 * 60_000).every((meter) => meter.percent === null));
  assert.equal(zaicodeWorkerQuota(snapshotOf([windowOf("five_hour", 100, { assumedFull: true })]), now)[0]?.state, "unknown");
  assert.equal(zaicodeWorkerQuota(snapshotOf([windowOf("five_hour", null)]), now)[0]?.state, "unknown");
  assert.equal(zaicodeWorkerQuota(snapshotOf([windowOf("five_hour", 10, { resetsAt: now - 1 })]), now)[0]?.percent, null);
});

test("REQ-010: preserves Classic and migrates the old bevel preference", () => {
  assert.deepEqual(ZAICODE_PRESENTATIONS.map((preset) => preset.id), ["classic", "simple-boxes", "flat", "minimal"]);
  assert.equal(normalizeZaicodePresentation(null, true), "classic");
  assert.equal(normalizeZaicodePresentation(null, false), "simple-boxes");
  for (const preset of ZAICODE_PRESENTATIONS) assert.equal(normalizeZaicodePresentation(preset.id), preset.id);
  assert.equal(normalizeZaicodePresentation("corrupt"), "classic");
});
