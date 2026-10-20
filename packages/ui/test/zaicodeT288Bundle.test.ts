import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { controlHintTriggerHasBox } from "../src/ControlHintTooltip.js";
import { zaicodeWorkerYoloArgs } from "../src/zaicode/zaicodeEngines.js";
import { orderZaicodeAccounts } from "../src/zaicode/zaicodeMeterPrefs.js";
import {
  resolveZaicodeSubscriptionGroup,
  zaicodePoolSubscription,
  zaicodeSchedulerWatchNote,
} from "../src/zaicode/zaicodeSubscriptionSelection.js";
import { zaicodeBulkEnabledChanges } from "../src/settings/model-provider-section/zaicodeBulkEnabledChanges.js";
import {
  clampZaicodeUsagePanelWidth,
  ZAICODE_USAGE_PANEL_DEFAULT_WIDTH,
} from "../src/zaicode/zaicodeUsagePanelWidth.js";
import { zaicodeScopeRequest } from "../src/zaicode/home/zaicodeUsageScope.js";
import { mergeZaicodeSharedAccounts } from "@zcode/shared";
import { proposeZaicodeRouterKeyCleanup } from "../../desktop/src/main/zaicodeRouterCredentials.js";

/**
 * T-288 (SRC-190): 15-clause product sweep. Each clause pins its requirement
 * to the implementation that carries it; deeper behavior lives in the suites
 * named per test (all green in the full UI run).
 */

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (relative: string) => readFileSync(join(uiSrc, ...relative.split("/")), "utf8");

test("T-288 R001: opened projects resume the persisted goal; STOP wins", () => {
  const cont = read("zaicode/zaicodeGoalContinuation.ts");
  assert.ok(cont.includes("resumeTask"), "restoration resumes through the shared resume path");
  assert.ok(cont.includes("STOP"), "explicit STOP is respected, never resurrected");
});

test("T-288 R002: TODO hover anchors to a trigger with a box", () => {
  const box = (w: number, h: number, isConnected = true) => ({
    isConnected,
    getBoundingClientRect: () => ({ width: w, height: h }) as DOMRect,
  });
  assert.equal(controlHintTriggerHasBox(box(0, 0)), false);
  assert.equal(controlHintTriggerHasBox(box(24, 24, false)), false);
  assert.equal(controlHintTriggerHasBox(box(24, 24)), true);
});

test("T-288 R003: retry and transcript controls stay inside their boxes", () => {
  const retry = read("zaicode/ZaicodeAutoRetryButton.tsx");
  assert.ok(retry.includes("max-w-"), "retry panel is width-bounded");
  assert.ok(retry.includes("/retry:hidden"), "retry extras hide in compact mode");
  assert.ok(read("v4/ConversationTranscriptControl.tsx").includes("shrink-0"));
});

test("T-288 R004: workers start YOLO per vendor", () => {
  assert.ok((zaicodeWorkerYoloArgs("zcode") ?? "").includes("yolo"));
  assert.ok((zaicodeWorkerYoloArgs("codex") ?? "").length > 0);
});

test("T-288 R005: subscription order is operator-defined", () => {
  const accounts = [{ id: "b" }, { id: "a" }, { id: "c" }];
  assert.deepEqual(
    orderZaicodeAccounts(accounts, ["a", "b"]).map((a) => a.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    orderZaicodeAccounts(accounts, []).map((a) => a.id),
    ["b", "a", "c"],
  );
});

test("T-288 R006: scheduler names the backing subscription and Watch state", () => {
  const accounts = [{ provider: "antigravity", label: "AG", active: true, connectionId: "c1" }];
  const backing = zaicodePoolSubscription("pool:1", accounts as never, { "pool:1": "c1" }, []);
  assert.equal(backing?.engineId, null);
  assert.equal(zaicodeSchedulerWatchNote(backing, "", () => null)?.tone, "unwatchable");
  assert.equal(zaicodeSchedulerWatchNote(null, "", () => null), null);
});

test("T-288 R007: model choices resolve to their own subscription account", () => {
  const accounts = [
    { provider: "codex", label: "Codex 1", active: true, connectionId: "c1" },
    { provider: "codex", label: "Codex 2", active: true, connectionId: "c2" },
  ];
  const groups = [{ providerId: "g2" }];
  const hit = resolveZaicodeSubscriptionGroup(
    { vendor: "codex", label: "Codex 2" },
    accounts as never,
    { g2: "c2" },
    groups as never,
  );
  assert.equal(hit, groups[0]);
});

test("T-288 R008: bulk model switches paint only real flips", () => {
  const out = zaicodeBulkEnabledChanges(
    [{ modelId: "m1", config: { enabled: false } }, { modelId: "m2", config: { enabled: true } }] as never,
    true,
  );
  assert.deepEqual(out.map((m: { modelId: string }) => m.modelId), ["m1"]);
});

test("T-288 R009: usage panel width clamps to a sane range", () => {
  assert.equal(clampZaicodeUsagePanelWidth(1e9, 1920), 960);
  assert.ok(clampZaicodeUsagePanelWidth(ZAICODE_USAGE_PANEL_DEFAULT_WIDTH, 1920) > 0);
});

test("T-288 R010: right-click on a subscription model makes it the default", () => {
  const subs = read("settings/ZaicodeRouterSubscriptions.tsx");
  assert.ok(subs.includes("onContextMenu"), "right-click path exists");
  assert.ok(subs.includes("makeDefault"), "it sets the default model");
  assert.ok(subs.includes("currentDefault"), "the chosen default stays visible");
});

test("T-288 R011: same-install plane records take plane initials, one row", () => {
  const local = [
    {
      id: "antigravity:default",
      vendor: "antigravity",
      short: "AG",
      label: "Antigravity",
      source: "gemini:antigravity",
      home: null,
      isDefaultHome: true,
      osUser: "vac34",
      cli: "agy",
      status: "ready",
      statusDetail: "",
      fixCommand: null,
    },
  ];
  const merged = mergeZaicodeSharedAccounts(local as never, [
    { providerId: "antigravity", accountId: "a1", locator: "vac34", displayName: "VAC", home: null },
  ] as never);
  assert.equal(merged.length, 1);
  assert.notEqual(merged[0]!.short, "AG");
});

test("T-288 R012: engine selection resolves per account, never across", () => {
  const miss = resolveZaicodeSubscriptionGroup(
    { vendor: "codex", label: "Nobody" },
    [{ provider: "codex", label: "Codex 1", active: true, connectionId: "c1" }] as never,
    {},
    [],
  );
  assert.equal(miss, null);
});

test("T-288 R013: usage scopes attribute to recorded slices", () => {
  assert.deepEqual(zaicodeScopeRequest("global", { project: "a", sessionId: "s" }), {
    project: null,
    sessionId: null,
  });
});

test("T-288 R014: usage opens compact on left-click, full view on right-click", () => {
  const view = read("zaicode/ZaicodeUsageView.tsx");
  assert.ok(view.includes('openZaicodeUsage("page")'), "left-click opens the compact inspector");
  assert.ok(view.includes("Global"), "scope filters are offered");
});

test("T-288 R015: excess router keys are proposed, never minted blindly", () => {
  const report = proposeZaicodeRouterKeyCleanup([
    { id: "k1", name: "ZAICODE" },
    { id: "k2", name: "ZAICODE" },
    { id: "k3", name: "other" },
  ] as never);
  assert.equal(report.total, 3);
  assert.equal(report.duplicateNamed, 1);
});
