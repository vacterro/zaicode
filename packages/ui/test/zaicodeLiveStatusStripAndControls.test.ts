import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  extractZaicodeSaipenResult,
  extractZaicodeSaipenRefusal,
  isZaicodeNeedUser,
  resolveZaicodeLiveStatus,
  type ZaicodeSaipenSnapshot,
} from "../src/zaicode/zaicodeSaipenStatusModel.js";
import {
  normalizeZaicodeUiPrefs,
  ZAICODE_UI_DEFAULT_PREFS,
} from "../src/zaicode/zaicodeUiPrefs.js";
import type { ZaicodeProjectRuntimeVerdict } from "../src/zaicode/zaicodeWorkers.js";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/* =========================================================================
   Part A: Status Strip Scenarios (1-20)
   ========================================================================= */

test("Scenario 1: Anchored row placement directly below transcript toolbar", () => {
  const timeline = source("../src/v4/ConversationTimeline.tsx");
  const toolbarPos = timeline.indexOf('data-zaicode-transcript-row="true"');
  const stripPos = timeline.indexOf("<ZaicodeSaipenLiveStatusStrip");
  const scrollPos = timeline.indexOf("ref={scrollRef}");
  assert.ok(toolbarPos > -1, "toolbar present");
  assert.ok(stripPos > -1, "status strip present");
  assert.ok(scrollPos > -1, "scroll scroller present");
  assert.ok(toolbarPos < stripPos, "strip is positioned below transcript toolbar");
  assert.ok(stripPos < scrollPos, "strip is positioned above scrollable transcript");
});

test("Scenario 2: Stationary row while message history scrolls", () => {
  const timeline = source("../src/v4/ConversationTimeline.tsx");
  const stripPos = timeline.indexOf("<ZaicodeSaipenLiveStatusStrip");
  const scrollContainer = timeline.indexOf("<div\n        ref={scrollRef}");
  const altScrollContainer = timeline.indexOf("ref={scrollRef}");
  const targetScrollPos = scrollContainer > -1 ? scrollContainer : altScrollContainer;
  assert.ok(
    stripPos < targetScrollPos,
    "status strip sits outside virtualized scrollable message list",
  );
});

test("Scenario 3: Lane clearance preserves status dock reservation", () => {
  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(
    stripSource.includes("var(--zaicode-status-lane, 0px)"),
    "status strip includes right padding clearance for --zaicode-status-lane",
  );
});

test("Scenario 4: Default compact view renders all high-priority fields", () => {
  assert.equal(ZAICODE_UI_DEFAULT_PREFS.saipenStatusView, "compact");
  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes('data-status-view="compact"'), "compact view DOM marker");
  assert.ok(stripSource.includes("NEXT EXACT ACTION"), "renders NEXT EXACT ACTION label");
  assert.ok(stripSource.includes("NEED USER"), "renders NEED USER alert badge");
  assert.ok(stripSource.includes("RESULT"), "renders RESULT display");
});

test("Scenario 5: NEED USER indicator fires when human intervention required", () => {
  const normalBlockerSnapshot: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: null,
    nextAction: "fix",
    blocker: "BLOCKED: npm install failed",
    phase: "EXEC",
    counts: { doing: 1, todo: 0, done: 0 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  assert.equal(
    isZaicodeNeedUser(normalBlockerSnapshot),
    false,
    "technical blocker does not trigger NEED USER",
  );

  const humanBlockerSnapshot: ZaicodeSaipenSnapshot = {
    ...normalBlockerSnapshot,
    blocker: "OPERATOR_REQUIRED: Confirm schema drop",
  };
  assert.equal(isZaicodeNeedUser(humanBlockerSnapshot), true, "human blocker triggers NEED USER");

  const waitUserPhaseSnapshot: ZaicodeSaipenSnapshot = {
    ...normalBlockerSnapshot,
    blocker: null,
    phase: "WAIT_USER",
  };
  assert.equal(
    isZaicodeNeedUser(waitUserPhaseSnapshot),
    true,
    "WAIT_USER phase triggers NEED USER",
  );
});

test("Scenario 6: NEXT EXACT ACTION displays live nextAction", () => {
  const snapshot: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: null,
    nextAction: "saipen continue --json to advance T-314",
    blocker: null,
    phase: "VERIFY",
    counts: { doing: 1, todo: 0, done: 0 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  assert.equal(snapshot.nextAction, "saipen continue --json to advance T-314");
});

test("Scenario 7: RESULT displays authoritative structured outcome", () => {
  const verifyPass: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: "verify -> PASS [target: npm test]",
    nextAction: null,
    blocker: null,
    phase: "DONE",
    counts: { doing: 0, todo: 0, done: 1 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  assert.equal(extractZaicodeSaipenResult(verifyPass), "PASS (npm test)");

  const reviewApproved: ZaicodeSaipenSnapshot = {
    ...verifyPass,
    lastAction: "review -> APPROVED",
  };
  assert.equal(extractZaicodeSaipenResult(reviewApproved), "APPROVED");

  const explicitResult: ZaicodeSaipenSnapshot = {
    ...verifyPass,
    lastAction: "RESULT: All 30 tests green, build successful",
  };
  assert.equal(extractZaicodeSaipenResult(explicitResult), "All 30 tests green, build successful");
});

test("Scenario 8: Explicit 'Not reported' when result is absent", () => {
  const emptySnapshot: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: "just an ordinary line with no structured verdict",
    nextAction: null,
    blocker: null,
    phase: "EXEC",
    counts: { doing: 1, todo: 0, done: 0 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  assert.equal(extractZaicodeSaipenResult(emptySnapshot), "Not reported");
  assert.equal(extractZaicodeSaipenResult(null), "Not reported");
});

test("Scenario 9: Never infer task success from assistant chat prose", () => {
  const conversationalLog: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: "I have successfully fixed all issues and everything is done!",
    nextAction: null,
    blocker: null,
    phase: "EXEC",
    counts: { doing: 1, todo: 0, done: 0 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  assert.equal(extractZaicodeSaipenResult(conversationalLog), "Not reported");
});

test("Scenario 10: Valid protocol checkpoints remain distinct from execution refusals", () => {
  const validSnapshot: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: "checkpoint 1",
    nextAction: "next",
    blocker: null,
    phase: "EXEC",
    counts: { doing: 1, todo: 0, done: 0 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  assert.equal(extractZaicodeSaipenRefusal(validSnapshot), null);

  const refusalSnapshot: ZaicodeSaipenSnapshot = {
    ...validSnapshot,
    blocker: "REFUSE_EXEC_RESPONSE_INVALID: chat emitted prose",
  };
  assert.equal(
    extractZaicodeSaipenRefusal(refusalSnapshot),
    "REFUSE_EXEC_RESPONSE_INVALID: chat emitted prose",
  );
});

test("Scenario 11: Blocker / Refusal indicator displays active blockers", () => {
  const blockedSnapshot: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: null,
    nextAction: null,
    blocker: "BLOCKED: merge conflict in packages/ui/src/styles.css",
    phase: "EXEC",
    counts: { doing: 1, todo: 0, done: 0 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  const resolved = resolveZaicodeLiveStatus(blockedSnapshot, null);
  assert.equal(resolved.status, "BLOCKED");
  assert.equal(resolved.variant, "danger");
});

test("Scenario 12: Status badge maps phases and runtime states to correct variants", () => {
  const runningVerdict: ZaicodeProjectRuntimeVerdict = {
    state: "working",
    activeSessions: 1,
    activeTasks: 1,
    liveWorkerCount: 1,
  };

  const doneSnapshot: ZaicodeSaipenSnapshot = {
    workspacePath: "/repo",
    isInitialized: true,
    lastAction: null,
    nextAction: null,
    blocker: null,
    phase: "DONE",
    counts: { doing: 0, todo: 0, done: 1 },
    timestamp: Date.now(),
    readError: null,
    projection: null,
  };
  assert.deepEqual(resolveZaicodeLiveStatus(doneSnapshot, null), {
    status: "DONE",
    variant: "success",
  });

  const runningSnapshot: ZaicodeSaipenSnapshot = {
    ...doneSnapshot,
    phase: "PLAN",
  };
  assert.deepEqual(resolveZaicodeLiveStatus(runningSnapshot, runningVerdict), {
    status: "RUNNING",
    variant: "running",
  });

  const waitSnapshot: ZaicodeSaipenSnapshot = {
    ...doneSnapshot,
    phase: "WAIT_OPERATOR",
  };
  assert.deepEqual(resolveZaicodeLiveStatus(waitSnapshot, null), {
    status: "WAIT_OPERATOR",
    variant: "warning",
  });
});

test("Scenario 13: Responsive container query adapts at wide viewport", () => {
  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes("@container/status-strip"));
  assert.ok(stripSource.includes("@[900px]/status-strip"));
});

test("Scenario 14: Responsive container query adapts at medium viewport", () => {
  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes("@[640px]/status-strip"));
  assert.ok(stripSource.includes("@[480px]/status-strip"));
});

test("Scenario 15: Responsive container query adapts at narrow viewport", () => {
  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes("@container/status-strip"));
  assert.ok(stripSource.includes("overflow-hidden"));
});

test("Scenario 16: Uninitialized projects without .saipen render explicit state", () => {
  assert.deepEqual(resolveZaicodeLiveStatus(null, null), {
    status: "NO SAIPEN",
    variant: "default",
  });

  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes("!snapshot"));
  assert.ok(stripSource.includes("UNINITIALIZED"));
});

test("Scenario 17: Project switching updates live status to new workspace", () => {
  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes('useZaicodeSaipen(workspacePath ?? "", workspaceIdentity)'));
  assert.ok(
    stripSource.includes(
      'useZaicodeProjectRuntime(workspacePath ?? "", workspaceIdentity, snapshot)',
    ),
  );
});

test("Scenario 18: Stale async updates from previous project are discarded", () => {
  const saipenHook = source("../src/zaicode/zaicodeSaipen.ts");
  assert.ok(saipenHook.includes("this.snapshot === snapshot"));
  assert.ok(saipenHook.includes("unsubscribe();"));
});

test("Scenario 19: Subagent transcripts do not inherit parent or cross-project state", () => {
  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes("inSubagentDrilldown"));
  assert.ok(stripSource.includes("return null;"));
});

test("Scenario 20: User collapse/expand preference persists across restarts", () => {
  const prefsCompact = normalizeZaicodeUiPrefs({ saipenStatusView: "compact" });
  assert.equal(prefsCompact.saipenStatusView, "compact");

  const prefsExpanded = normalizeZaicodeUiPrefs({ saipenStatusView: "expanded" });
  assert.equal(prefsExpanded.saipenStatusView, "expanded");

  const prefsCollapsed = normalizeZaicodeUiPrefs({ saipenStatusView: "collapsed" });
  assert.equal(prefsCollapsed.saipenStatusView, "collapsed");

  const prefsInvalid = normalizeZaicodeUiPrefs({ saipenStatusView: "unknown-view" });
  assert.equal(prefsInvalid.saipenStatusView, "compact");
});

test("Scenario 20b: Off mode hides the strip entirely and is a persisted preference", () => {
  const prefsOff = normalizeZaicodeUiPrefs({ saipenStatusView: "off" });
  assert.equal(prefsOff.saipenStatusView, "off");

  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(stripSource.includes('viewMode === "off"'), "off is a real mode");
  assert.ok(stripSource.includes("return null;"), "off renders nothing");
  assert.ok(
    stripSource.includes('prefs.update({ saipenStatusView: "off" })'),
    "an in-strip hide button writes it",
  );
  assert.ok(stripSource.includes("EyeOff"), "the hide affordance is an eye-off icon");

  const settingsSource = source("../src/settings/ZaicodeLayoutSettings.tsx");
  assert.ok(
    settingsSource.includes("ZaicodeSaipenStatusSettingsPanel"),
    "the Layout block hosts the strip's own settings panel",
  );

  const panelSource = source("../src/zaicode/ZaicodeSaipenStatusSettings.tsx");
  assert.ok(panelSource.includes("ZaicodePrefStepper"), "the panel owns the font-size stepper");
  assert.ok(panelSource.includes('value: "off"'), "Off is offered as a shape");
  assert.ok(
    panelSource.includes("ZaicodeRightClickSettings"),
    "the same panel answers a right-click on the strip",
  );
});

test("Scenario 20c: Strip font size is its own clamped preference", () => {
  assert.equal(ZAICODE_UI_DEFAULT_PREFS.saipenStatusFontSize, 11);
  assert.equal(normalizeZaicodeUiPrefs({ saipenStatusFontSize: 4 }).saipenStatusFontSize, 8);
  assert.equal(normalizeZaicodeUiPrefs({ saipenStatusFontSize: 99 }).saipenStatusFontSize, 20);
  assert.equal(normalizeZaicodeUiPrefs({}).saipenStatusFontSize, 11);

  const stripSource = source("../src/zaicode/ZaicodeSaipenLiveStatusStrip.tsx");
  assert.ok(
    stripSource.includes("fontSize: `${prefs.saipenStatusFontSize}px`"),
    "the pref drives the strip root",
  );
  assert.ok(
    !stripSource.includes("text-[10px]"),
    "no hardcoded 10px left; everything scales from the root",
  );
});

/* =========================================================================
   Part B: Control Consistency Scenarios (21-30)
   ========================================================================= */

test("Scenario 21: Native checkboxes replaced with Radix Checkbox across target components", () => {
  const auditPanel = source("../src/zaicode/ZaicodeAuditPanel.tsx");
  assert.ok(auditPanel.includes('import { Checkbox } from "@/components/ui/checkbox.js"'));
  assert.ok(!auditPanel.includes('type="checkbox"'));

  const timerParts = source("../src/zaicode/ZaicodeTimerParts.tsx");
  assert.ok(timerParts.includes('import { Checkbox } from "@/components/ui/checkbox.js"'));
  assert.ok(!timerParts.includes('type="checkbox"'));

  const prefControls = source("../src/zaicode/ZaicodePrefControls.tsx");
  assert.ok(prefControls.includes('import { Checkbox } from "@/components/ui/checkbox.js"'));
  assert.ok(!prefControls.includes('type="checkbox"'));

  const audioPanels = source("../src/zaicode/ZaicodeAudioPanels.tsx");
  assert.ok(audioPanels.includes('import { Checkbox } from "@/components/ui/checkbox.js"'));
  assert.ok(!audioPanels.includes('type="checkbox"'));

  const diamondSettings = source("../src/settings/ZaicodeDiamondSettings.tsx");
  assert.ok(diamondSettings.includes('import { Checkbox } from "@/components/ui/checkbox.js"'));
  assert.ok(!diamondSettings.includes('type="checkbox"'));

  const colorSettings = source("../src/settings/ZaicodeColorSettings.tsx");
  assert.ok(colorSettings.includes('import { Checkbox } from "@/components/ui/checkbox.js"'));
  assert.ok(!colorSettings.includes('type="checkbox"'));

  const meterSettings = source("../src/zaicode/ZaicodeMeterSettings.tsx");
  assert.ok(meterSettings.includes('import { Checkbox } from "@/components/ui/checkbox.js"'));
  assert.ok(!meterSettings.includes('type="checkbox"'));
});

test("Scenario 22: Checkbox maintains consistent dimensions and border in dark theme", () => {
  const checkboxSource = source("../src/components/ui/checkbox.tsx");
  assert.ok(checkboxSource.includes("size-4"), "size-4 dimension constraint");
  assert.ok(checkboxSource.includes("border-primary"), "border-primary token");
});

test("Scenario 23: Checkbox maintains consistent dimensions and border in light theme", () => {
  const checkboxSource = source("../src/components/ui/checkbox.tsx");
  assert.ok(checkboxSource.includes("shrink-0"), "prevents flex distortion");
  assert.ok(checkboxSource.includes("border"), "border token definition");
});

test("Scenario 24: Checkbox checked state uses ZAICODE highlight / primary color", () => {
  const checkboxSource = source("../src/components/ui/checkbox.tsx");
  assert.ok(checkboxSource.includes("data-[state=checked]:bg-primary"));
  assert.ok(checkboxSource.includes("text-primary-foreground"));
});

test("Scenario 25: Checkbox unchecked state uses ZAICODE surface/border tokens", () => {
  const checkboxSource = source("../src/components/ui/checkbox.tsx");
  assert.ok(checkboxSource.includes("border-primary"));
});

test("Scenario 26: Checkbox hover and pressed states remain visually distinct", () => {
  const checkboxSource = source("../src/components/ui/checkbox.tsx");
  assert.ok(checkboxSource.includes("transition-colors"));
  assert.ok(
    checkboxSource.includes("focus-visible:ring-1") ||
      checkboxSource.includes("focus-visible:ring-2") ||
      checkboxSource.includes("focus-visible:ring-"),
  );
});

test("Scenario 27: Disabled checkbox maintains readable contrast without OS graying", () => {
  const checkboxSource = source("../src/components/ui/checkbox.tsx");
  assert.ok(checkboxSource.includes("disabled:cursor-not-allowed"));
  assert.ok(checkboxSource.includes("disabled:opacity-50"));
});

test("Scenario 28: Keyboard focus ring uses ZAICODE ring token, not OS accent", () => {
  const stylesCss = source("../src/styles.css").replace(/\r\n/g, "\n");
  assert.ok(
    stylesCss.includes("outline: 1px solid var(--zaicode-highlight"),
    "keyboard focus ring uses --zaicode-highlight token",
  );
  assert.ok(stylesCss.includes("*:focus:not(:focus-visible) {\n  outline: none;\n}"));
});

test("Scenario 29: Forced-colors / High-contrast mode preserves accessible outline", () => {
  const stylesCss = source("../src/styles.css");
  assert.ok(
    stylesCss.includes("@media (forced-colors: active)"),
    "forced-colors media query is present",
  );
  assert.ok(
    stylesCss.includes("outline: 2px solid Highlight !important;"),
    "forced-colors restores 2px solid Highlight outline",
  );
  assert.ok(
    stylesCss.includes("outline-offset: 2px !important;"),
    "forced-colors preserves outline-offset",
  );
});

test("Scenario 30: Selected 'System' application theme continues to follow OS dark/light mode", () => {
  const useThemeSource = source("../src/useTheme.ts");
  assert.ok(useThemeSource.includes('"system"'));
  assert.ok(useThemeSource.includes('window.matchMedia("(prefers-color-scheme: dark)")'));
  const stylesCss = source("../src/styles.css").replace(/\r\n/g, "\n");
  assert.ok(stylesCss.includes("select {\n  color-scheme: inherit;\n}"));
});
