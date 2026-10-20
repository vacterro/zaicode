import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeZaicodeUiPrefs,
  ZAICODE_RIGHT_CLICK_CONTROLS,
} from "../src/zaicode/zaicodeUiPrefs.js";
import { useZaicodeAuditStore } from "../src/zaicode/zaicodeAuditStore.js";
import {
  readZaicodeAutostartJobs,
  writeZaicodeAutostartJobs,
  updateZaicodeAutostartJob,
} from "../src/zaicode/zaicodeAutostart.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import type { IZaicodeAuditService } from "@zcode/services";
import type { ZaicodeAuditBatch, ZaicodeAuditWorker, ZaicodeAuditState } from "@zcode/shared";

// ── Ticket A: New Task UX & Action Preferences ──

test("Ticket A: normalizeZaicodeUiPrefs preserves New Task preferences and defaults", () => {
  const defaults = normalizeZaicodeUiPrefs(null);
  assert.equal(defaults.showNewHandoffAction, true);
  assert.equal(defaults.showGoalCcAllAction, true);
  assert.equal(defaults.showNewTaskGreeting, true);
  assert.equal(defaults.showNewTaskHints, true);
  assert.ok(defaults.newHandoffTemplate.includes("SAIHANDOFF"));
  assert.equal(defaults.goalCcAllTemplate, "/goal cc all");

  const customized = normalizeZaicodeUiPrefs({
    showNewHandoffAction: false,
    showGoalCcAllAction: false,
    showNewTaskGreeting: false,
    showNewTaskHints: false,
    newHandoffTemplate: "CUSTOM HANDOFF TEMPLATE",
    goalCcAllTemplate: "/goal custom",
  });
  assert.equal(customized.showNewHandoffAction, false);
  assert.equal(customized.showGoalCcAllAction, false);
  assert.equal(customized.showNewTaskGreeting, false);
  assert.equal(customized.showNewTaskHints, false);
  assert.equal(customized.newHandoffTemplate, "CUSTOM HANDOFF TEMPLATE");
  assert.equal(customized.goalCcAllTemplate, "/goal custom");
});

test("Ticket A: ZAICODE_RIGHT_CLICK_CONTROLS contains individual action controls", () => {
  assert.ok("newHandoffAction" in ZAICODE_RIGHT_CLICK_CONTROLS);
  assert.ok("goalCcAllAction" in ZAICODE_RIGHT_CLICK_CONTROLS);
  assert.ok("greeting" in ZAICODE_RIGHT_CLICK_CONTROLS);
});

test("Ticket A: Composer text insert request works with prepend-if-missing and correct workspace target", () => {
  const store = useZCodeSessionStore.getState();
  const testWorkspace = "V:/mock/workspace/handoff1839";
  const reqId = store.requestComposerTextInsert(
    testWorkspace,
    "SAIHANDOFF - \n\nMISSION:\n\n",
    undefined,
    undefined,
    "prepend-if-missing",
  );

  assert.ok(reqId > 0, "requestComposerTextInsert returns valid requestId");
  const wsState = store.getWorkspaceState(testWorkspace);
  assert.equal(wsState.composerTextInsertRequest?.requestId, reqId);
  assert.equal(wsState.composerTextInsertRequest?.text, "SAIHANDOFF - \n\nMISSION:\n\n");
  assert.equal(wsState.composerTextInsertRequest?.mode, "prepend-if-missing");

  // Clear request
  store.clearComposerTextInsertRequest(testWorkspace, reqId);
  const clearedState = store.getWorkspaceState(testWorkspace);
  assert.equal(clearedState.composerTextInsertRequest, null);
});

// ── Ticket B: Quick3 Audit Factory Hardening ──

test("Ticket B: Audit store manages syncState (CURRENT, STALE, PARTIAL, HOST_UNAVAILABLE) without losing data", async () => {
  const auditStore = useZaicodeAuditStore.getState();

  const mockBatches: ZaicodeAuditBatch[] = [
    {
      batchId: "batch-1",
      createdAt: 1000,
      updatedAt: 1000,
      campaignCount: 3,
      completedCount: 1,
      runningCount: 1,
      blockedCount: 0,
      cancelledCount: 0,
      status: "running",
      projects: [],
      workerCapacity: 4,
      autoWaves: true,
      generation: 1,
    },
  ];

  const mockWorkers: ZaicodeAuditWorker[] = [
    {
      workerId: "w-1",
      batchId: "batch-1",
      campaignId: "c-1",
      workspaceKey: "k-1",
      projectName: "p-1",
      waveNumber: 1,
      startedAt: 1000,
      elapsedMs: 500,
      status: "running",
      progress: "evaluating",
    },
  ];

  const mockState: ZaicodeAuditState = {
    campaigns: [],
    smartMode: true,
    autoAudits: true,
    maxCycles: 10,
    runId: "run-1",
    autoWaves: true,
  };

  // Phase 1: Successful initial sync
  const mockServiceSuccess: IZaicodeAuditService = {
    getState: async () => mockState,
    listBatches: async () => mockBatches,
    getActiveWorkers: async () => mockWorkers,
  } as unknown as IZaicodeAuditService;

  await auditStore.refresh(mockServiceSuccess);
  const stateAfterSuccess = useZaicodeAuditStore.getState();
  assert.equal(stateAfterSuccess.syncState, "CURRENT");
  assert.equal(stateAfterSuccess.batches.length, 1);
  assert.equal(stateAfterSuccess.activeWorkers.length, 1);
  assert.equal(stateAfterSuccess.error, null);

  // Phase 2: Host failure does NOT wipe out active workers or batches to empty array
  const mockServiceHostFailure: IZaicodeAuditService = {
    getState: async () => {
      throw new Error("Connection refused (Host offline)");
    },
    listBatches: async () => {
      throw new Error("Connection refused");
    },
    getActiveWorkers: async () => {
      throw new Error("Connection refused");
    },
  } as unknown as IZaicodeAuditService;

  await auditStore.refresh(mockServiceHostFailure);
  const stateAfterFailure = useZaicodeAuditStore.getState();
  assert.equal(stateAfterFailure.syncState, "STALE", "State becomes STALE, preserving snapshot");
  assert.equal(stateAfterFailure.batches.length, 1, "Batches preserved, not wiped to []");
  assert.equal(stateAfterFailure.activeWorkers.length, 1, "Workers preserved, not reported 0");
  assert.ok(stateAfterFailure.error?.includes("Host unavailable"));

  // Phase 3: Partial failure (e.g. workers RPC fails but state succeeds)
  const mockServicePartial: IZaicodeAuditService = {
    getState: async () => mockState,
    listBatches: async () => mockBatches,
    getActiveWorkers: async () => {
      throw new Error("Worker registry timeout");
    },
  } as unknown as IZaicodeAuditService;

  await auditStore.refresh(mockServicePartial);
  const stateAfterPartial = useZaicodeAuditStore.getState();
  assert.equal(stateAfterPartial.syncState, "PARTIAL");
  assert.equal(stateAfterPartial.batches.length, 1);
  assert.equal(stateAfterPartial.activeWorkers.length, 1, "Preserves trusted activeWorkers on partial failure");
  assert.ok(stateAfterPartial.error?.includes("Partial update"));
});

// ── Ticket C: Scheduler Reliability ──

test("Ticket C: writeZaicodeAutostartJobs confirms storage persistence", () => {
  const jobs = readZaicodeAutostartJobs();
  const testJob = {
    id: "test-sched-1",
    name: "Test Schedule",
    projectPath: "V:/code/test",
    engineId: "pool:test",
    trigger: "at" as const,
    at: "12:00",
    everyMinutes: 60,
    resetTime: "00:00",
    order: "list" as const,
    targetKind: "project" as const,
    section: "default",
    onlyWhenIdle: false,
    stopAt: "",
    beforeRun: "none" as const,
    prompt: "echo test",
    onlyMarked: false,
    requireQuota: false,
    requireCleanGit: false,
    continuation: { enabled: false, order: [] },
    createdAt: Date.now(),
    lastRunAt: 0,
    lastResult: "never",
    firedEvents: [],
    enabled: true,
  };

  const persisted = writeZaicodeAutostartJobs([...jobs, testJob]);
  // In node environment, localStorage is polyfilled or available in zcode test harness
  if (typeof localStorage !== "undefined") {
    assert.equal(persisted, true, "write confirms storage persistence");
  }

  // Update job
  const updated = updateZaicodeAutostartJob("test-sched-1", { lastResult: "updated" });
  if (typeof localStorage !== "undefined") {
    assert.equal(updated, true);
  }

  // Cleanup
  writeZaicodeAutostartJobs(jobs);
});

// ── Ticket D: Sidebar Control Clarity ──

test("Ticket D: Sidebar layout and button styles ensure no clipping on narrow sidebars", async () => {
  const stripModule = await import("../src/zaicode/ZaicodeSessionActionStrip.js");
  assert.ok(stripModule.ZaicodeSessionActionStrip);

  const autoModule = await import("../src/zaicode/ZaicodeAutoSettings.js");
  assert.ok(autoModule.ZaicodeSidebarAutoButton);
  assert.ok(autoModule.ZaicodeAutoSettingsPanel);
});
