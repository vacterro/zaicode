import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cancelZaicodeAuditCampaign,
  createZaicodeAuditCampaign,
  markZaicodeAuditDispatched,
  recoverZaicodeAuditCampaign,
  recordZaicodeAuditFailure,
  retryZaicodeAuditWave,
  synthesizeZaicodeAuditCombined,
  zaicodeAuditArtifactsBelongToRun,
  zaicodeAuditCampaignStatus,
  zaicodeAuditCombinedFile,
  zaicodeAuditIdempotencyKey,
  zaicodeAuditPlanDispatch,
  zaicodeAuditSourceUnchanged,
  type ZaicodeAuditCampaignState,
} from "@zcode/shared/zaicode-audit-campaign";

/**
 * Wave 5: the durable campaign, against the behaviours AUDAPACK's own tests
 * defend. Every case here is a way an audit campaign has lied before:
 * starting twice, sending a second Core after a restart, skipping a wave after
 * a failure, showing READY without the final file, or letting a previous
 * campaign's artifacts satisfy a new run.
 */

const SOURCE = "git:abc123+clean";
const RUN = "run-a3-1";
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);

const fresh = (runId = RUN): ZaicodeAuditCampaignState =>
  createZaicodeAuditCampaign({
    runId,
    projectId: "proj-zaicode",
    projectName: "ZAICODE",
    sourceIdentity: SOURCE,
    modelIdentity: "custom-12/SAIFREN$enabled",
  });

test("Wave 5: /a3 starts exactly once -- one campaign, one Core dispatch", () => {
  const state = fresh();
  assert.equal(zaicodeAuditCampaignStatus(state).label, "0/3");

  const first = zaicodeAuditPlanDispatch(state);
  assert.equal(first?.waveId, "core");
  assert.equal(first?.idempotencyKey, zaicodeAuditIdempotencyKey(RUN, "core"));

  // Asking again on the SAME state still offers the same single dispatch: the
  // key is what makes a double Enter or a double click the same dispatch.
  const again = zaicodeAuditPlanDispatch(state);
  assert.deepEqual(again, first, "planning twice yields one identical dispatch");

  const dispatched = markZaicodeAuditDispatched(state, "core", "2026-09-29T10:00:00Z");
  assert.equal(zaicodeAuditPlanDispatch(dispatched), null, "a dispatched wave is not dispatched again");
  assert.equal(zaicodeAuditCampaignStatus(dispatched).phase, "saving");
  assert.equal(zaicodeAuditCampaignStatus(dispatched).currentWaveId, "core");
});

test("Wave 5: a restart BEFORE dispatch may still dispatch exactly once", () => {
  const state = fresh();
  const recovered = recoverZaicodeAuditCampaign(state, { dispatched: [] });
  assert.equal(zaicodeAuditPlanDispatch(recovered)?.waveId, "core", "nothing was sent, so Core may go once");
  const afterDispatch = markZaicodeAuditDispatched(recovered, "core", "t");
  const again = recoverZaicodeAuditCampaign(afterDispatch, { dispatched: [] });
  assert.equal(zaicodeAuditPlanDispatch(again)?.waveId, "core", "the evidence says it never left, so it may go");
});

test("Wave 5: a restart AFTER dispatch recovers the run instead of a second Core", () => {
  let state = fresh();
  state = markZaicodeAuditDispatched(state, "core", "t");
  const recovered = recoverZaicodeAuditCampaign(state, { dispatched: [{ waveId: "core" }] });
  assert.equal(recovered.waves.find((wave) => wave.waveId === "core")!.status, "dispatched");
  assert.equal(zaicodeAuditPlanDispatch(recovered), null, "no second Core turn is created");
  assert.equal(zaicodeAuditCampaignStatus(recovered).currentWaveId, "core", "the existing run is observed");
});

test("Wave 5: a full valid chain reaches the final artifact", () => {
  let state = fresh();
  const digests: Record<string, string> = {};
  const contents: Record<string, string> = {};
  for (const waveId of ["core", "second", "performance"]) {
    state = markZaicodeAuditDispatched(state, waveId, "t");
    const text = `${waveId} report`;
    contents[waveId] = text;
    digests[waveId] = SHA(waveId[0]!);
    state = {
      ...state,
      waves: state.waves.map((wave) =>
        wave.waveId === waveId
          ? { ...wave, status: "saved", artifactFile: `${waveId}.md`, artifactSha256: digests[waveId]!, completedAt: "t" }
          : wave,
      ),
    };
  }
  const status = zaicodeAuditCampaignStatus(state);
  assert.equal(status.label, "3/3");
  // Three saved waves and no combined file is SAVING, never READY.
  assert.equal(status.phase, "saving");
  assert.equal(status.finalArtifactPresent, false);

  const combined = synthesizeZaicodeAuditCombined({
    state,
    contents,
    digests,
    sha256: (text) => SHA("c"),
    synthesizedAt: "2026-09-29T11:00:00Z",
  });
  assert.equal(combined.ok, true, combined.reason);
  assert.match(combined.markdown!, /quick3_combined/, "the artifact kind is in the header");
  assert.ok(combined.markdown!.includes(SOURCE), "the source identity is in the header");
  assert.match(combined.markdown!, /zaicode__|ZAICODE/);
  for (const waveId of ["core", "second", "performance"]) {
    assert.ok(combined.markdown!.includes(`${waveId} report`), "findings are carried verbatim, not summarised");
    assert.ok(combined.markdown!.includes(digests[waveId]!), "each wave's digest is listed");
  }
  const withFinal = { ...state, combined: { file: zaicodeAuditCombinedFile(state), kind: "quick3_combined", sha256: combined.sha256!, synthesizedAt: "t" } };
  assert.equal(zaicodeAuditCampaignStatus(withFinal).phase, "done");
  assert.equal(zaicodeAuditCampaignStatus(withFinal, { combinedFileExists: false }).phase, "saving");
});

test("Wave 5: the synthesis is byte-stable and refuses a hash mismatch", () => {
  const build = (digest: string) => {
    let state = fresh();
    const contents: Record<string, string> = {};
    const digests: Record<string, string> = {};
    for (const waveId of ["core", "second", "performance"]) {
      contents[waveId] = `${waveId} report`;
      digests[waveId] = digest;
      state = {
        ...state,
        waves: state.waves.map((wave) => (wave.waveId === waveId ? { ...wave, status: "saved", artifactSha256: digest, artifactFile: `${waveId}.md` } : wave)),
      };
    }
    return synthesizeZaicodeAuditCombined({ state, contents, digests, sha256: () => digest, synthesizedAt: "t" });
  };
  const first = build(SHA("a"));
  const second = build(SHA("a"));
  assert.equal(first.markdown, second.markdown, "the same inputs give the same bytes");

  // All three durable, but the campaign recorded a different hash for Core
  // than the file now has: that is a tampering or a stale read, not a pass.
  const recorded = SHA("a");
  const contents = { core: "core report", second: "second report", performance: "performance report" };
  let tampered = fresh();
  tampered = {
    ...tampered,
    waves: tampered.waves.map((wave) => ({ ...wave, status: "saved", artifactSha256: recorded })),
  };
  const mismatch = synthesizeZaicodeAuditCombined({
    state: tampered,
    contents,
    digests: { core: SHA("b"), second: SHA("s"), performance: SHA("p") },
    sha256: () => "x",
    synthesizedAt: "t",
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason!, /does not match the hash/);
});

test("Wave 5: a failed wave retries as ITSELF and never skips a wave index", () => {
  let state = fresh();
  state = markZaicodeAuditDispatched(state, "core", "t");
  state = recordZaicodeAuditFailure(state, "core", "the model returned a plan, not findings");
  assert.equal(zaicodeAuditCampaignStatus(state).phase, "error");
  assert.equal(zaicodeAuditCampaignStatus(state).currentWaveId, "core", "the failure is on the wave that failed");

  const retry = zaicodeAuditPlanDispatch(retryZaicodeAuditWave(state, "core"));
  assert.equal(retry?.waveId, "core", "the same wave is retried");
  assert.equal(retry?.attempt, 2, "the attempt is explicit");
  assert.equal(retry?.idempotencyKey, zaicodeAuditIdempotencyKey(RUN, "core"), "and it is the same dispatch");
});

test("Wave 5: cancelling stops progression and keeps what was already proven", () => {
  let state = fresh();
  state = markZaicodeAuditDispatched(state, "core", "t");
  state = {
    ...state,
    waves: state.waves.map((wave) => (wave.waveId === "core" ? { ...wave, status: "saved", artifactSha256: SHA("a") } : wave)),
  };
  const cancelled = cancelZaicodeAuditCampaign(state);
  assert.equal(zaicodeAuditCampaignStatus(cancelled).phase, "cancelled");
  assert.equal(zaicodeAuditPlanDispatch(cancelled), null, "no next wave goes out");
  assert.equal(cancelled.waves.find((wave) => wave.waveId === "core")!.status, "saved", "the finished artifact is untouched");
  assert.equal(cancelled.waves.find((wave) => wave.waveId === "second")!.status, "cancelled");
});

test("Wave 5: an old campaign's artifacts cannot satisfy a new run", () => {
  const oldRun = fresh("run-old");
  const newRun = fresh("run-new");
  assert.notEqual(oldRun.waves[0]!.idempotencyKey, newRun.waves[0]!.idempotencyKey);

  const verdict = zaicodeAuditArtifactsBelongToRun(newRun, [
    { waveId: "core", runId: "run-old", projectId: "proj-zaicode" },
    { waveId: "second", runId: "run-new", projectId: "proj-zaicode" },
    { waveId: "performance", runId: "run-new", projectId: "other-project" },
  ]);
  assert.deepEqual(verdict.accepted, ["second"]);
  assert.deepEqual(verdict.rejected, ["core", "performance"], "another run's or project's artifact never counts");
});

test("Wave 5: source drift cannot mix live-source waves", () => {
  const state = fresh();
  assert.equal(zaicodeAuditSourceUnchanged(state, SOURCE), true);
  assert.equal(zaicodeAuditSourceUnchanged(state, "git:abc123+dirty"), false, "a changed tree is a different source identity");
  assert.equal(zaicodeAuditSourceUnchanged(state, "git:def456+clean"), false, "so is a moved HEAD");
});

test("Wave 5: a fresh campaign is a clean slate, whatever a previous run did", () => {
  let old = fresh("run-1");
  old = markZaicodeAuditDispatched(old, "core", "t");
  old = { ...old, waves: old.waves.map((w) => (w.waveId === "core" ? { ...w, status: "saved", artifactSha256: SHA("a") } : w)) };
  assert.equal(zaicodeAuditCampaignStatus(old).label, "1/3");

  const next = fresh("run-2");
  assert.equal(zaicodeAuditCampaignStatus(next).label, "0/3", "a new run inherits nothing");
  assert.ok(next.waves.every((wave) => wave.status === "pending" && wave.attempt === 0));
  assert.equal(next.combined, undefined);
});
