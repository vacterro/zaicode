import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_AUDIT_QUIET_MS,
  ZAICODE_AUDIT_STALLED_MS,
  zaicodeAuditIdle,
  type ZaicodeAuditCampaign,
  type ZaicodeAuditLiveJob,
} from "@zcode/shared";

/**
 * T-398 (SRC-298 Wave 4): "honest unknown progress".
 *
 * The idle watchdog used to read `job.heartbeatAt`, but that column is the
 * HOST's execution lease: `repo.heartbeat(hostId, now)` renews every running
 * row of that host every 30s, whether or not the wave did anything. A wave
 * whose model went silent for an hour therefore still read "Last sign of life
 * 0s ago". The watchdog now needs a per-JOB sign of life and must say so when
 * there is none instead of inventing one.
 */

const T0 = Date.parse("2026-10-20T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function live(over: Partial<ZaicodeAuditLiveJob> = {}): ZaicodeAuditLiveJob {
  return {
    jobId: "j2",
    status: "running",
    sessionId: "s-1",
    startedAt: T0,
    heartbeatAt: T0,
    lastActivityAt: null,
    attempt: 1,
    agentName: "Auditor",
    model: "zai / glm-4.6",
    ...over,
  };
}

function campaign(over: Partial<ZaicodeAuditCampaign> = {}): ZaicodeAuditCampaign {
  return {
    schemaVersion: 2,
    campaignId: "c1",
    projectName: "_ZAICODE",
    workspaceKey: "k",
    workspacePath: "/p/_ZAICODE",
    status: "running",
    createdAt: iso(T0 - 60_000),
    updatedAt: iso(T0),
    startedAt: iso(T0),
    currentWaveIndex: 1,
    waves: [
      { waveId: "core", status: "complete", jobId: "j1", reportFile: "r1", resultSha256: "x", startedAt: iso(T0), completedAt: iso(T0 + 60_000) },
      { waveId: "second", status: "running", jobId: "j2", reportFile: "r2", resultSha256: null, startedAt: iso(T0 + 60_000), completedAt: null },
      { waveId: "performance", status: "pending", jobId: null, reportFile: null, resultSha256: null, completedAt: null },
    ],
    ...over,
  };
}

test("T-398: a fresh host heartbeat is not evidence the wave is alive", () => {
  // The host renewed its lease one second ago, but the wave's own last sign of
  // life was an hour ago: the readout must believe the wave, not the host.
  const lastActivityAt = T0;
  const now = T0 + 60 * 60_000;
  const idle = zaicodeAuditIdle(campaign({ live: live({ heartbeatAt: now - 1000, lastActivityAt }) }), now);
  assert.ok(idle, "a running wave with a known sign of life must report one");
  assert.equal(idle!.idleMs, 60 * 60_000);
  assert.equal(idle!.level, "stalled");
});

test("T-398: an unknown last sign of life is reported as unknown, never as zero", () => {
  const busy = zaicodeAuditIdle(
    campaign({ live: live({ startedAt: null, heartbeatAt: T0 + 60_000, lastActivityAt: null }) }),
    T0 + 60_000,
  );
  assert.deepEqual(busy, { idleMs: null, level: "unknown" });
});

test("T-398: a malformed activity reading is unknown too, never a fresh zero", () => {
  // `null` is the honest "no evidence" value, but an older host or a partial
  // projection can hand over `undefined`/NaN. Both must land in the same
  // bucket instead of producing `Math.max(0, now - NaN)` -> "0s ago".
  const now = T0 + 60 * 60_000;
  const malformed = { lastActivityAt: undefined } as unknown as Partial<ZaicodeAuditLiveJob>;
  assert.deepEqual(
    zaicodeAuditIdle(campaign({ live: live(malformed) }), now),
    { idleMs: null, level: "unknown" },
    "undefined activity is unknown, not zero",
  );
  assert.deepEqual(
    zaicodeAuditIdle(campaign({ live: live({ lastActivityAt: Number.NaN }) }), now),
    { idleMs: null, level: "unknown" },
    "NaN activity is unknown, not zero",
  );
});

test("T-398: the watchdog still uses the wave's own activity when it is known", () => {
  const now = T0 + 2 * 60_000;
  const idle = zaicodeAuditIdle(campaign({ live: live({ lastActivityAt: now - 30_000 }) }), now);
  assert.equal(idle!.level, "ok");
  assert.equal(idle!.idleMs, 30_000);
  assert.equal(zaicodeAuditIdle(campaign({ live: live({ lastActivityAt: now - ZAICODE_AUDIT_QUIET_MS }) }), now)!.level, "quiet");
  assert.equal(zaicodeAuditIdle(campaign({ live: live({ lastActivityAt: now - ZAICODE_AUDIT_STALLED_MS }) }), now)!.level, "stalled");
});
