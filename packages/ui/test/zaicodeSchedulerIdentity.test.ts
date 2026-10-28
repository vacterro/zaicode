import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseZaicodeContinuationRunner,
  createZaicodeAutostartJob,
  evaluateZaicodeAutostartJob,
  normalizeZaicodeContinuingJobs,
  zaicodeAutostartWatchedEngine,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import * as scheduler from "../src/zaicode/zaicodeScheduler.js";

const now = 1_000_000;
const quota = (id: string, percent = 90): ZaicodeLimitSnapshot => ({
  accountId: id,
  source: "fixture",
  plan: null,
  fetchedAt: now,
  checkedAt: now,
  error: null,
  windows: [
    {
      key: "five_hour",
      label: "5h",
      group: "",
      groupLabel: "",
      remainingPercent: percent,
      resetsAt: now,
      durationSeconds: 18_000,
    },
  ],
});
const account = (id: string): ZaicodeEngineAccount => ({
  id,
  short: id,
  label: id,
  vendor: "claude",
  source: "fixture",
  home: null,
  isDefaultHome: true,
  cli: "claude",
  status: "ready",
  statusDetail: "",
  fixCommand: null,
});
const job = () =>
  normalizeZaicodeContinuingJobs([
    {
      id: "job",
      projectPath: "C:/fixture",
      engineId: "A1",
      trigger: "everyReset",
      safetyDelaySeconds: 0,
      continuation: { enabled: true, runnerIds: ["A2"] },
    },
  ])[0]!;

test("selecting A2 as a CLI runner cannot retain a hidden A1 Watch target", () => {
  assert.equal(zaicodeAutostartWatchedEngine({ engineId: "A2", watchEngineId: "A1" }), "A2");
  assert.equal(
    zaicodeAutostartWatchedEngine({ engineId: "pool:start", watchEngineId: "A1" }),
    "A1",
  );
});

test("reset deduplication belongs to the account, so switching accounts neither skips nor repeats the original occurrence", () => {
  const a = createZaicodeAutostartJob(
    {
      id: "j",
      projectPath: "C:/fixture",
      engineId: "A1",
      trigger: "everyReset",
      safetyDelaySeconds: 0,
    },
    now,
  );
  const first = evaluateZaicodeAutostartJob(a, quota("A1"), now);
  const saved = { ...a, firedEvents: [first.eventId] };
  const second = evaluateZaicodeAutostartJob({ ...saved, engineId: "A2" }, quota("A2"), now);
  assert.equal(second.state, "due");
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(evaluateZaicodeAutostartJob(saved, quota("A1"), now).state, "waiting-reset");
});

test("legacy reset marks retain their previous watch account through normalization and account switching", () => {
  const legacy = normalizeZaicodeContinuingJobs([
    {
      id: "j",
      projectPath: "C:/fixture",
      engineId: "A1",
      watchEngineId: "A1",
      trigger: "reset",
      safetyDelaySeconds: 0,
      firedEvents: [`reset:five_hour:${now}`],
    },
  ])[0]!;
  assert.equal(evaluateZaicodeAutostartJob(legacy, quota("A1"), now).state, "done");
  const switched = normalizeZaicodeContinuingJobs([{ ...legacy, engineId: "A2" }])[0]!;
  assert.equal(evaluateZaicodeAutostartJob(switched, quota("A2"), now).state, "due");
  const restored = normalizeZaicodeContinuingJobs([{ ...switched, engineId: "A1" }])[0]!;
  assert.equal(evaluateZaicodeAutostartJob(restored, quota("A1"), now).state, "done");
});

test("a fresh snapshot for A1 cannot authorize a fallback on A2", () => {
  const j = job();
  const chosen = chooseZaicodeContinuationRunner({
    job: j,
    run: {
      workspaceKey: "w",
      projectPath: "C:/fixture",
      occurrence: "one",
      runnerId: "A1",
      lease: "lease",
      state: "waiting",
      blocked: [],
      nextAt: now,
      launchedAt: now,
      result: "",
    },
    accounts: [account("A1"), account("A2")],
    limits: { A1: quota("A1", 0), A2: quota("A1", 90) },
    availablePools: new Set(),
    now,
  });
  assert.equal(chosen, null);
});

test("active A2 continuation is projected separately from the preferred A1 and its previous result", () => {
  const j = job();
  j.lastResult = "Yesterday · A1 started";
  j.continuationRuns = [
    {
      workspaceKey: "w",
      projectPath: "C:/fixture",
      occurrence: "one",
      runnerId: "A2",
      lease: "lease",
      state: "running",
      blocked: [],
      nextAt: now,
      launchedAt: now,
      result: "Continuing on A2",
    },
  ];
  const project = (
    scheduler as unknown as {
      zaicodeScheduleActivity?: (
        job: typeof j,
        label: (id: string) => string,
      ) => { text: string } | null;
    }
  ).zaicodeScheduleActivity;
  assert.equal(typeof project, "function");
  assert.equal(project!(j, (id) => `${id} Claude`)?.text, "running · A2 Claude");
  j.continuationRuns[0]!.state = "complete";
  assert.equal(
    project!(j, (id) => id),
    null,
  );
  assert.equal(j.lastResult, "Yesterday · A1 started");
});
