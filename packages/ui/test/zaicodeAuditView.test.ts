import assert from "node:assert/strict";
import test from "node:test";
import {
  formatZaicodeAuditElapsed,
  formatZaicodeModelLabel,
  zaicodeAuditIdle,
  zaicodeAuditProjectState,
  zaicodeAuditStage,
  zaicodeAuditSteps,
  zaicodeAuditTotalMs,
  type ZaicodeAuditCampaign,
} from "@zcode/shared";
import { zaicodeAuditTransitions } from "../src/zaicode/zaicodeAuditStore.js";

// SRC-060: "какая модель выбрана, где щас идёт аудит, на какой стадии, сколько
// идёт процесс" -- the Audits view reads every campaign out in those terms.

const T0 = Date.parse("2026-09-27T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function campaign(over: Partial<ZaicodeAuditCampaign> = {}): ZaicodeAuditCampaign {
  return {
    schemaVersion: 1,
    campaignId: "c1",
    profileId: "a3",
    projectName: "_ZAICODE",
    workspaceKey: "k",
    workspacePath: "/p/_ZAICODE",
    status: "running",
    createdAt: iso(T0 - 60_000),
    updatedAt: iso(T0),
    startedAt: iso(T0),
    currentWaveIndex: 1,
    waves: [
      { waveId: "core", status: "complete", jobId: "j1", reportFile: "r1", resultSha256: "x", startedAt: iso(T0), completedAt: iso(T0 + 6 * 60_000) },
      { waveId: "second", status: "running", jobId: "j2", reportFile: "r2", resultSha256: null, startedAt: iso(T0 + 6 * 60_000), completedAt: null },
      { waveId: "performance", status: "pending", jobId: null, reportFile: null, resultSha256: null, completedAt: null },
    ],
    finalHandoffFile: null,
    ...over,
  };
}

test("stage and steps say where the audit is, with each wave's time", () => {
  const now = T0 + 10 * 60_000;
  assert.equal(zaicodeAuditStage(campaign()).label, "Running wave 2 of 3 · Completeness");
  assert.deepEqual(
    zaicodeAuditSteps(campaign(), now).map((step) => [step.title, step.state, step.elapsedMs]),
    [
      ["Core correctness", "done", 6 * 60_000],
      ["Completeness", "active", 4 * 60_000],
      ["Performance", "waiting", null],
    ],
  );
  assert.equal(zaicodeAuditTotalMs(campaign(), now), 10 * 60_000);
  assert.equal(zaicodeAuditStage(campaign({ status: "planned", startedAt: null })).label, "Planned, not started");
  assert.equal(zaicodeAuditStage(campaign({ status: "blocked" })).label, "Stopped at wave 2 of 3 · Completeness");
  // A stopped audit's clock stops at its last finished wave.
  assert.equal(zaicodeAuditTotalMs(campaign({ status: "blocked" }), now + 3_600_000), 6 * 60_000);
});

test("the idle watchdog reads the running job's last sign of life", () => {
  const live = { jobId: "j2", status: "running", sessionId: "s", startedAt: T0, heartbeatAt: T0, attempt: 1, agentName: "Auditor", model: "zai / glm-4.6" };
  assert.deepEqual(zaicodeAuditIdle(campaign({ live }), T0 + 30_000), { idleMs: 30_000, level: "ok" });
  assert.equal(zaicodeAuditIdle(campaign({ live }), T0 + 4 * 60_000)!.level, "quiet");
  assert.equal(zaicodeAuditIdle(campaign({ live }), T0 + 11 * 60_000)!.level, "stalled");
  assert.equal(zaicodeAuditIdle(campaign({ live: null }), T0), null);
  assert.equal(zaicodeAuditIdle(campaign({ status: "blocked", live }), T0), null);
});

test("model labels and elapsed times read like a person would say them", () => {
  assert.equal(
    formatZaicodeModelLabel({ providerId: "zai", modelId: "glm-4.6", options: { reasoningLevel: "high" } }),
    "zai / glm-4.6 · high",
  );
  assert.equal(formatZaicodeModelLabel(undefined, { modelRef: "gpt-5", providerRef: "codex" }), "codex / gpt-5");
  assert.equal(formatZaicodeModelLabel(undefined, null), null);
  assert.equal(formatZaicodeAuditElapsed(12_400), "12s");
  assert.equal(formatZaicodeAuditElapsed(245_000), "4m 05s");
  assert.equal(formatZaicodeAuditElapsed(3_720_000), "1h 02m");
});

test("each project's line shows its newest audit; an active one wins over history", () => {
  const done = campaign({ campaignId: "old", status: "complete", createdAt: iso(T0 - 3_600_000) });
  const running = campaign({ campaignId: "new" });
  assert.deepEqual(zaicodeAuditProjectState([], "/p/_ZAICODE"), { state: "idle", campaign: null });
  assert.equal(zaicodeAuditProjectState([done], "/p/_ZAICODE").state, "done");
  assert.equal(zaicodeAuditProjectState([done, running], "/p/_ZAICODE").campaign!.campaignId, "new");
  assert.equal(zaicodeAuditProjectState([campaign({ status: "blocked" })], "/p/_ZAICODE").state, "stopped");
});

test("finished waves and audits are heard once, not on the first reading", () => {
  const before = [campaign()];
  assert.deepEqual(zaicodeAuditTransitions(null, before), []);
  const waveDone = campaign({
    currentWaveIndex: 2,
    waves: campaign().waves.map((wave) => (wave.waveId === "second" ? { ...wave, status: "complete" } : wave)),
  });
  assert.deepEqual(zaicodeAuditTransitions(before, [waveDone]), ["audit.waveDone"]);
  assert.deepEqual(zaicodeAuditTransitions([waveDone], [campaign({ status: "complete" })]), ["audit.complete"]);
  assert.deepEqual(zaicodeAuditTransitions(before, [campaign({ status: "blocked" })]), ["audit.blocked"]);
  assert.deepEqual(zaicodeAuditTransitions(before, before), []);
});
