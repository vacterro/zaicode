import assert from "node:assert/strict";
import test from "node:test";
import type { ZaicodeAuditCampaign } from "@zcode/shared";
import {
  createZaicodeA3Starter,
  planZaicodeA3,
  zaicodeA3ProjectName,
  type ZaicodeA3Target,
} from "../src/zaicode/zaicodeA3Core.js";

/**
 * Wave 5, the `/a3` half: one invocation, ONE campaign.
 *
 * The command is consumed by the composer's app-command channel, so the only
 * two ways to get a duplicate are the two tested here — asking twice before
 * the first finished, and asking when the project already holds a campaign.
 */

const TARGET: ZaicodeA3Target = {
  workspaceKey: "ws-1",
  workspacePath: "V:\\repo\\_ZAICODE",
  projectName: "_ZAICODE",
};

const OTHER: ZaicodeA3Target = { ...TARGET, workspacePath: "V:\\repo\\OTHER", workspaceKey: "ws-2" };

function campaign(patch: Partial<ZaicodeAuditCampaign> & { status: ZaicodeAuditCampaign["status"] }): ZaicodeAuditCampaign {
  return {
    schemaVersion: 2,
    campaignId: "c-1",
    profileId: "quick3",
    projectName: "_ZAICODE",
    workspaceKey: "ws-1",
    workspacePath: "V:\\repo\\_ZAICODE",
    status: patch.status,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    currentWaveIndex: 0,
    waves: [],
    finalHandoffFile: null,
    ...patch,
  } as ZaicodeAuditCampaign;
}

test("a project with no campaign starts one", () => {
  assert.deepEqual(planZaicodeA3([], TARGET, true), { kind: "start" });
});

test("no host service means no campaign and no silent nothing", () => {
  const decision = planZaicodeA3([], TARGET, false);
  assert.equal(decision.kind, "unavailable");
});

test("another project's campaign does not occupy this project's seat", () => {
  const campaigns = [campaign({ status: "running", workspacePath: OTHER.workspacePath, workspaceKey: "ws-2" })];
  assert.deepEqual(planZaicodeA3(campaigns, TARGET, true), { kind: "start" });
});

for (const status of ["planned", "running", "blocked"] as const) {
  test(`a ${status} campaign is opened, never duplicated`, () => {
    const decision = planZaicodeA3(
      [campaign({ status, currentWaveIndex: 1 })],
      TARGET,
      true,
    );
    assert.equal(decision.kind, "open-existing");
    if (decision.kind !== "open-existing") return;
    assert.equal(decision.campaignId, "c-1");
    assert.equal(decision.currentWave, 2, "the operator is told which wave it is on");
  });
}

for (const status of ["complete", "cancelled"] as const) {
  test(`a ${status} campaign releases the seat`, () => {
    assert.deepEqual(planZaicodeA3([campaign({ status })], TARGET, true), { kind: "start" });
  });
}

test("a double Enter starts one campaign, not two", async () => {
  const starter = createZaicodeA3Starter();
  let started = 0;
  const run = () =>
    starter.once(async () => {
      started += 1;
      // A real start awaits the service; the second call lands inside it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { campaignId: "c-1" };
    });

  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(started, 1, "the service was asked exactly once");
  assert.equal(first.ran, true);
  assert.equal(second.ran, false, "the duplicate event was refused, not queued");
  assert.equal(starter.inFlight(), false, "the latch releases when the start settles");
});

test("the latch is released even when the start throws", async () => {
  const starter = createZaicodeA3Starter();
  await assert.rejects(
    () => starter.once(async () => {
      throw new Error("host is gone");
    }),
    /host is gone/,
  );
  assert.equal(starter.inFlight(), false, "a failed start must not wedge the command");
  const after = await starter.once(async () => "ok");
  assert.equal(after.ran, true, "the command works again");
});

test("the project name falls back to the directory, so a run is never unnamed", () => {
  assert.equal(zaicodeA3ProjectName(TARGET), "_ZAICODE");
  assert.equal(zaicodeA3ProjectName({ ...TARGET, projectName: "" }), "_ZAICODE");
  assert.equal(zaicodeA3ProjectName({ ...TARGET, workspacePath: "V:\\repo\\", projectName: "" }), "repo");
});
