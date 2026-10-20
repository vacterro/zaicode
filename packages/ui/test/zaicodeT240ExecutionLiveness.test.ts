import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_LIVENESS_TTL_MS,
  executionLivenessSchema,
  type ExecutionLivenessSnapshot,
} from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { mapSessionSummaryToTaskMeta } from "../src/v4/mapSessionSummaryToTaskMeta.js";
import { SessionsIndexStore } from "../src/v4/sessionsIndexStore.js";
import { zaicodeSessionWorking, zaicodeSessionStalled } from "../src/zaicode/zaicodeStall.js";
import {
  reconcileZaicodeLiveRuns,
  setZaicodeLiveRun,
  useZaicodeLiveRuns,
} from "../src/zaicode/zaicodeLiveRuns.js";
import { isTaskListRowActive } from "../src/v4/taskListRowActivity.js";
import { zaicodeSessionStateOf } from "../src/zaicode/zaicodeSessionState.js";
import { zaicodeSessionBriefOf } from "../src/zaicode/zaicodeContinue.js";

const sixHours = 6 * 60 * 60 * 1000;
const now = sixHours + 1000;
const summary = {
  sessionId: "quiet-worker",
  workspaceId: "workspace",
  title: "Quiet worker",
  phase: "completedSuccess",
  sessionEnded: true,
  hasBackgroundWork: true,
  createdAt: 1,
  lastActivityAt: 1,
  executionLiveness: {
    ownerId: "actual-runtime",
    released: false,
    observedAt: now,
    validUntil: now + 120_000,
    background: [{ workId: "actual-worker", status: "running", confirmedAt: now, pid: 123 }],
    orphaned: false,
    unconfirmed: false,
  },
} as SessionSummary;

test("T-240: a quiet six-hour background worker remains working from fresh runtime evidence, without progress or mounting", () => {
  const task = mapSessionSummaryToTaskMeta(summary, {
    workspacePath: "C:/fixture",
    livenessReceivedAt: now,
  } as Parameters<typeof mapSessionSummaryToTaskMeta>[1]);
  assert.equal(task.updatedAt, 1, "heartbeat must not become progress or change list order");
  assert.equal(zaicodeSessionWorking(task, now), true);
});

function task(
  proof: ExecutionLivenessSnapshot,
  receivedAt = now,
  extra: Partial<SessionSummary> = {},
) {
  return mapSessionSummaryToTaskMeta(
    { ...summary, ...extra, executionLiveness: proof },
    { workspacePath: "C:/fixture", livenessReceivedAt: receivedAt },
  );
}
const proof = (): ExecutionLivenessSnapshot => structuredClone(summary.executionLiveness!);

test("T-240: dead/released/unconfirmed owners are recoverable without opening their conversation", () => {
  for (const status of ["orphaned", "unconfirmed"] as const) {
    const p = proof();
    p[status] = true;
    p.background[0]!.status = status;
    const projected = task(p, now, { hasBackgroundWork: false });
    assert.equal(zaicodeSessionWorking(projected, now), false);
    assert.equal(zaicodeSessionStalled(projected, now), true);
  }
  const p = proof();
  p.released = true;
  assert.equal(zaicodeSessionWorking(task(p), now), false);
  assert.equal(
    zaicodeSessionWorking(task(proof()), now + EXECUTION_LIVENESS_TTL_MS + 1),
    false,
    "abrupt host loss expires its actual receipt",
  );
});

test("T-240: one orphaned sibling cannot hide a live worker or foreground execution", () => {
  const p = proof();
  p.orphaned = true;
  p.unconfirmed = true;
  p.background.push({ workId: "old-sibling", status: "orphaned", confirmedAt: null });
  assert.equal(zaicodeSessionWorking(task(p), now), true);
  p.foregroundExecutionId = "foreground";
  p.background[0]!.status = "unconfirmed";
  assert.equal(
    zaicodeSessionWorking(task(p, now, { phase: "running", sessionEnded: false }), now),
    true,
  );
});

test("T-240: receipt freshness uses receiver time and repeated/replayed samples cannot renew it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const store = new SessionsIndexStore();
  const p = proof();
  p.observedAt = 500_000_000;
  p.validUntil = p.observedAt + EXECUTION_LIVENESS_TTL_MS;
  p.background[0]!.confirmedAt = p.observedAt;
  const snap = (value: ExecutionLivenessSnapshot, seq = 1) =>
    ({
      fromSeq: 0,
      toSeq: seq,
      payload: {
        kind: "snapshot",
        snapshot: {
          workspaceId: "workspace",
          logEpoch: "epoch",
          sessions: [{ ...summary, executionLiveness: value }],
        },
      },
    }) as any;
  store.applyFrame(snap(p));
  const receivedAt = store.getLivenessReceivedAt(summary.sessionId)!;
  assert.equal(receivedAt, 1000);
  assert.equal(
    zaicodeSessionWorking(task(p, receivedAt), 1000),
    true,
    "remote clock skew cannot invalidate fresh evidence",
  );
  t.mock.timers.setTime(2000);
  store.applyFrame(snap(p));
  assert.equal(store.getLivenessReceivedAt(summary.sessionId), receivedAt);
  store.reset();
  store.applyFrame(snap(p));
  assert.equal(
    store.getLivenessReceivedAt(summary.sessionId),
    receivedAt,
    "reset/replay is not a new worker observation",
  );
  assert.equal(zaicodeSessionWorking(task(p, receivedAt), 1001 + EXECUTION_LIVENESS_TTL_MS), false);
  p.observedAt += 1;
  p.validUntil += 1;
  p.background[0]!.confirmedAt = p.observedAt;
  store.applyFrame(snap(p, 2));
  assert.equal(store.getLivenessReceivedAt(summary.sessionId), 2000);
});

test("T-240: a new canonical denial clears a mounted hint, while a pre-start idle sample cannot", () => {
  useZaicodeLiveRuns.setState({ runs: {} });
  try {
    setZaicodeLiveRun(summary.sessionId, "C:/fixture", true, "view");
    const observed = useZaicodeLiveRuns.getState().runs[summary.sessionId]!.observedAt!;
    const p = proof();
    p.background = [];
    p.orphaned = true;
    reconcileZaicodeLiveRuns(
      [
        task(p, observed - 1, {
          phase: "completedInterrupted",
          sessionEnded: false,
          hasBackgroundWork: false,
        }),
      ],
      observed,
    );
    assert.ok(useZaicodeLiveRuns.getState().runs[summary.sessionId]);
    reconcileZaicodeLiveRuns(
      [
        task(p, observed + 1, {
          phase: "completedInterrupted",
          sessionEnded: false,
          hasBackgroundWork: false,
        }),
      ],
      observed + 1,
    );
    assert.equal(useZaicodeLiveRuns.getState().runs[summary.sessionId], undefined);
  } finally {
    useZaicodeLiveRuns.setState({ runs: {} });
  }
});

test("T-240: the public wire schema rejects missing/invalid ownership timestamps", () => {
  assert.equal(executionLivenessSchema.safeParse(proof()).success, true);
  for (const invalid of [
    { ...proof(), ownerId: "" },
    { ...proof(), observedAt: NaN },
    { ...proof(), validUntil: Infinity },
    { ...proof(), background: [{ workId: "worker", status: "running" }] },
  ]) {
    assert.equal(executionLivenessSchema.safeParse(invalid).success, false);
  }
});

test("T-240: expiry withdraws running from project/continue/cleanup consumers and leaves recoverable work", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const projected = task(proof());
  assert.equal(isTaskListRowActive(projected), true);
  assert.equal(zaicodeSessionStateOf(projected), "running");
  t.mock.timers.tick(EXECUTION_LIVENESS_TTL_MS + 1);
  assert.equal(isTaskListRowActive(projected), false);
  assert.equal(zaicodeSessionStalled(projected, Date.now()), true);
  assert.equal(
    zaicodeSessionStateOf(projected),
    "interrupted",
    "expired work cannot be cleared as done",
  );
  const brief = zaicodeSessionBriefOf(projected, "workspace", { workspacePath: "C:/fixture" });
  assert.equal(brief.running, false);
  assert.equal(brief.crashCut, true);
  assert.equal(brief.manuallyStopped, false);
});
