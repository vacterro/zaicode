import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_AUDIT_PROFILE,
  describeZaicodeAuditCampaign,
  formatZaicodeAuditElapsed,
  type ZaicodeAuditCampaign,
  type ZaicodeAuditCampaignWaveState,
} from "@zcode/shared";

// SRC-060: "Пока что аудитная система совершенно непонятна: Какие проекты,
// какая модель выбрана, где щас идёт аудит, на какой стадии, сколько идёт
// процесс".
//
// The panel used to re-derive each of those on its own, and one of them -- the
// model -- could not be derived at all, because the campaign never recorded the
// agent it ran on. This read model is the single place all five come from, and
// it is pure so the whole thing is testable without a service, a clock or a
// disk.
//
// This lives in services, not in packages/shared, because the pre-push chain
// runs ui, services and desktop only: a test parked in shared would never run
// and would be decoration. The existing audit tests are here for the same reason.

const NOW = Date.parse("2026-09-27T09:00:00.000Z");

function wave(over: Partial<ZaicodeAuditCampaignWaveState> = {}): ZaicodeAuditCampaignWaveState {
  return {
    waveId: ZAICODE_AUDIT_PROFILE.waves[0]!.id,
    status: "pending",
    jobId: null,
    reportFile: null,
    resultSha256: null,
    completedAt: null,
    ...over,
  };
}

function campaign(over: Partial<ZaicodeAuditCampaign> = {}): ZaicodeAuditCampaign {
  return {
    schemaVersion: 1,
    campaignId: "c1",
    profileId: ZAICODE_AUDIT_PROFILE.id,
    projectName: "zaicode",
    workspaceKey: "zaicode",
    workspacePath: "V:\\_zaicode",
    status: "planned",
    createdAt: "2026-09-27T08:30:00.000Z",
    updatedAt: "2026-09-27T08:30:00.000Z",
    currentWaveIndex: 0,
    waves: ZAICODE_AUDIT_PROFILE.waves.map((w) => wave({ waveId: w.id })),
    finalHandoffFile: null,
    ...over,
  };
}

test("a planned campaign says which project, where it is, and that it is waiting", () => {
  const readout = describeZaicodeAuditCampaign(campaign(), NOW);
  assert.equal(readout.projectName, "zaicode");
  assert.equal(readout.workspacePath, "V:\\_zaicode");
  assert.equal(readout.where, "1/3 AUDIT CORE");
  assert.match(readout.stage, /waiting in the queue/);
  assert.equal(readout.active, false);
  assert.equal(readout.doneWaves, 0);
  assert.equal(readout.totalWaves, 3);
});

test("a running campaign names the wave and the agent it runs on", () => {
  const readout = describeZaicodeAuditCampaign(
    campaign({
      status: "running",
      currentWaveIndex: 1,
      waves: [
        wave({ status: "complete" }),
        wave({ waveId: ZAICODE_AUDIT_PROFILE.waves[1]!.id, status: "running", agentId: "zaicode-agent:auditor" }),
        wave({ waveId: ZAICODE_AUDIT_PROFILE.waves[2]!.id }),
      ],
    }),
    NOW,
  );
  assert.equal(readout.where, "2/3 AUDIT SECOND WAVE");
  assert.equal(readout.stage, "running now");
  // The gap SRC-060 named: the model was never written down before.
  assert.equal(readout.agentId, "zaicode-agent:auditor");
  assert.equal(readout.doneWaves, 1);
  assert.equal(readout.active, true);
});

test("a partial wave is called out as partial, not just as running", () => {
  const readout = describeZaicodeAuditCampaign(
    campaign({
      status: "running",
      waves: [
        wave({ status: "partial" }),
        wave({ waveId: ZAICODE_AUDIT_PROFILE.waves[1]!.id }),
        wave({ waveId: ZAICODE_AUDIT_PROFILE.waves[2]!.id }),
      ],
    }),
    NOW,
  );
  assert.match(readout.stage, /partial/);
});

test("a blocked campaign is not counted as spare reserve", () => {
  const readout = describeZaicodeAuditCampaign(
    campaign({
      status: "blocked",
      waves: [
        wave({ status: "partial" }),
        wave({ waveId: ZAICODE_AUDIT_PROFILE.waves[1]!.id }),
        wave({ waveId: ZAICODE_AUDIT_PROFILE.waves[2]!.id }),
      ],
    }),
    NOW,
  );
  assert.match(readout.stage, /stopped on something/);
  // Only a COMPLETE wave counts. A partial wave did not deliver a wave.
  assert.equal(readout.doneWaves, 0);
  assert.equal(readout.active, false);
});

test("a finished campaign says so and has no wave left to point at", () => {
  const readout = describeZaicodeAuditCampaign(
    campaign({
      status: "complete",
      currentWaveIndex: 3,
      waves: ZAICODE_AUDIT_PROFILE.waves.map((w) => wave({ waveId: w.id, status: "complete" })),
    }),
    NOW,
  );
  assert.equal(readout.stage, "finished");
  assert.equal(readout.doneWaves, 3);
  assert.equal(readout.where, "no wave left");
});

test("elapsed is measured from generation and never goes negative", () => {
  const readout = describeZaicodeAuditCampaign(campaign(), NOW);
  assert.equal(readout.elapsedMs, 30 * 60 * 1000);
  // A clock behind the recorded creation time must not produce a negative age.
  const behind = describeZaicodeAuditCampaign(campaign(), Date.parse("2026-09-27T08:00:00.000Z"));
  assert.equal(behind.elapsedMs, 0);
});

test("a campaign written by an older build still reads", () => {
  // agentId is optional precisely so a pre-SRC-060 campaign.json still loads.
  const readout = describeZaicodeAuditCampaign(
    campaign({ status: "running", waves: [wave({ status: "running" })] }),
    NOW,
  );
  assert.equal(readout.agentId, null);
});

test("elapsed formats the way a person reads it", () => {
  assert.equal(formatZaicodeAuditElapsed(0), "0s");
  assert.equal(formatZaicodeAuditElapsed(9_400), "9s");
  assert.equal(formatZaicodeAuditElapsed(192_000), "3m 12s");
  assert.equal(formatZaicodeAuditElapsed(3_840_000), "1h 04m");
  assert.equal(formatZaicodeAuditElapsed(-5), "0s");
});
