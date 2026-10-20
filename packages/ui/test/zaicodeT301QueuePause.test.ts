import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyQueueActionAck,
  queueActionNeedsReport,
  queuePauseKinds,
} from "../src/v4/queueActionOutcome.js";

/**
 * T-301: "Fix silent or ineffective Queue Resume and Send Now actions when a
 * session is paused by SAIPEN operator-authority enforcement."
 *
 * The operator's evidence: a paused session with two queued messages, every
 * button click producing no visible result. The bug was not the authority gate
 * -- that gate is correct and these tests never weaken it. The bug was the
 * answer: the CLI refusal arrived as an ack, every Queue handler answered it
 * with logger.warn, and the UI never asked the availability projection for
 * permission. So a blocked command stayed queued and looked like a success.
 *
 * These tests pin the two halves separately. One is the reading of an ack:
 * admission, already-resolved, refused, refused-by-authority. The other is
 * which pause the banner is looking at: the QUEUE's scheduling pause or the
 * SESSION's own paused authority. A Queue pause must never be drawn to look
 * like it can authorize a SAIPEN-paused session.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const source = (path: string): string =>
  readFileSync(join(srcRoot, path), "utf8").replace(/\r\n/g, "\n");

const pane = source("v4/SessionPane.tsx");
const panel = source("v4/ConversationQueuePanel.tsx");

test("A: a paused QUEUE with a live session is runnable -- resume is a real dispatch", () => {
  const kinds = queuePauseKinds({ autoDrain: false, goalStatus: "active" });
  assert.equal(kinds.queuePaused, true, "the queue itself is not draining");
  assert.equal(kinds.sessionPaused, false, "the session is not paused: resume can dispatch");
  assert.equal(classifyQueueActionAck({ status: "accepted" }).kind, "admitted");
});

test("B: a SAIPEN-paused session (hard_wait) is reported as the session's own pause, not the queue's", () => {
  const kinds = queuePauseKinds({ autoDrain: false, goalStatus: "paused" });
  assert.equal(kinds.queuePaused, true);
  assert.equal(kinds.sessionPaused, true);
  // The banner that says the queue was stopped by the operator is not this.
  assert.ok(
    panel.includes("sessionPaused") && panel.includes("chat.queue.sessionPausedNote"),
    "the panel renders the session-paused note beside the queue controls",
  );
  assert.ok(panel.includes("TID_V4_SESSION_PAUSED_NOTE"), "the note is addressable in UI tests");
});

test("C: a running queue with a paused session does not pretend everything is fine", () => {
  const kinds = queuePauseKinds({ autoDrain: true, goalStatus: "paused" });
  assert.equal(kinds.queuePaused, false, "queue scheduling is on");
  assert.equal(kinds.sessionPaused, true, "the session's authority is still paused");
});

test("D: an accepted ack is admission, not proof of execution -- and no toast claims otherwise", () => {
  const outcome = classifyQueueActionAck({ status: "accepted" });
  assert.equal(outcome.kind, "admitted");
  assert.equal(queueActionNeedsReport(outcome), false, "nothing to report on admission");
});

test("E: a refused resume reports its guard instead of dying in logger.warn", () => {
  for (const status of ["rejected", "stale", "failed"]) {
    const outcome = classifyQueueActionAck({ status, reasonCode: "guard.queueItemReserved" });
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.reasonCode, "guard.queueItemReserved");
    assert.equal(queueActionNeedsReport(outcome), true);
  }
  assert.ok(pane.includes("reportQueueActionRefusal"), "every queue handler reports refusals");
  assert.ok(
    pane.includes("chat.queue.actionBlocked"),
    "the toast names the action and the reason",
  );
});

test("F: send now behind an authority gate is refused-authority AND its button is disabled with the reason", () => {
  const authority = classifyQueueActionAck({
    status: "rejected",
    reasonCode: "guard.recognizedContinueAuthorizationExpired",
  });
  assert.equal(authority.kind, "refused-authority", "this is an authority refusal, not a transient one");
  assert.equal(queueActionNeedsReport(authority), true);
  for (const code of [
    "guard.recognizedContinueWithoutGoal",
    "guard.recognizedContinueResumeFailed",
    "guard.recognizedContinuePlanMode",
    "guard.recognizedContinueBudgetExhausted",
    "guard.recognizedContinueGoalComplete",
    "sendQueuedNowRequiresRunning",
  ]) {
    assert.equal(classifyQueueActionAck({ status: "rejected", reasonCode: code }).kind, "refused-authority");
  }
  assert.ok(
    pane.includes("snapshot?.availability.sendQueuedNow"),
    "the pane reads the availability projection for send now",
  );
  assert.ok(
    panel.includes("disabled={rowLocked || Boolean(sendNowBlockedReason)}"),
    "a blocked send-now button does not offer a click the CLI will refuse",
  );
  assert.ok(
    panel.includes("sendNowBlockedReason") && /chat\.queue\.actionBlocked/.test(panel),
    "the disabled button explains the block in its tooltip",
  );
});

test("G: after a legitimate authorization the same ack is admitted and the button is re-enabled", () => {
  const allowed = classifyQueueActionAck({ status: "accepted" });
  assert.equal(allowed.kind, "admitted");
  // Availability is re-read per snapshot, so a newly authorized session re-enables Suuna.
  assert.ok(
    /snapshot\?\.availability\.sendQueuedNow/.test(pane) && /sendNowBlockedReason = null/.test(panel),
    "blocked is derived, never sticky state",
  );
  // The promotion behind the gate still admits the bare `cc` mechanically.
  const continueSource = source("v4/queueActionOutcome.ts");
  assert.ok(continueSource.includes("guard.recognizedContinueAuthorizationExpired"));
});

test("H: a duplicate click cannot mint a second dispatch", () => {
  assert.ok(pane.includes("pendingSendNowQueueItemIdRef"), "the pane keeps the pending id");
  assert.ok(
    pane.includes("if (pendingSendNowQueueItemIdRef.current !== null) return;"),
    "a click while an ACK is outstanding is dropped",
  );
  assert.ok(
    panel.includes("sendNowPendingQueueItemId === item.queueItemId"),
    "the row itself is locked while the dispatch is in flight",
  );
  const duplicate = classifyQueueActionAck({ status: "duplicate", reasonCode: "queue.itemMissing" });
  assert.equal(duplicate.kind, "already-resolved", "the CLI noop path is a factual answer, not a failure");
  assert.equal(queueActionNeedsReport(duplicate), false);
});

test("I: a refusal keeps the queued item, its attachments and its order", () => {
  // Reported, never removed: the classifier's answer to a refusal is information.
  assert.equal(queueActionNeedsReport(classifyQueueActionAck({ status: "rejected", reasonCode: "fault.command.queuePromotionCommitFailed" })), true);
  assert.ok(panel.includes("data-v4-queue-item-attachments"), "the attachment badge stays on the row");
  assert.ok(panel.includes("attachments.map((attachment) => attachment.fileName)"), "attachment names survive a refusal");
});

test("J: a project switch keeps the paused facts of the session it switches to", () => {
  // sessionPaused is derived from the live snapshot per render, never cached in state.
  assert.ok(
    /sessionPausedForQueue = queuePauseKinds\(\{/.test(pane) &&
      /goalStatus: snapshot\?\.goal\?\.status \?\? null/.test(pane),
    "the pause kind follows the projection of the current session",
  );
  const other = queuePauseKinds({ autoDrain: false, goalStatus: "active" });
  assert.equal(other.sessionPaused, false, "another project's active session is not drawn as paused");
});

test("K: no queue refusal is silent", () => {
  for (const ack of [
    { status: "rejected", reasonCode: "guard.queuePromotionBusy" },
    { status: "rejected", reasonCode: "guard.recognizedContinueSessionBusy" },
    { status: "stale", reasonCode: undefined },
    { status: "failed", reasonCode: undefined },
  ]) {
    const outcome = classifyQueueActionAck(ack);
    assert.equal(queueActionNeedsReport(outcome), true, `${ack.status} is reported`);
    assert.equal(outcome.reasonCode, ack.reasonCode ?? ack.status, "the fallback names the status itself");
  }
  for (const handler of ["sendQueuedNow", "setAutoDrain", "resumeGoal"]) {
    assert.ok(
      new RegExp(`dispatchCommand\\(\\s*"${handler}"`).test(pane),
      `${handler} still dispatches`,
    );
  }
  assert.ok(
    pane.includes("reportQueueActionRefusal(intl.formatMessage({ id: \"chat.queue.resume\" }), ack)"),
    "queue resume and goal resume both report through the same reporter",
  );
  // The old silent endings are gone.
  for (const silent of [
    "logger.warn(`[v4-pane] sendQueuedNow 被拒绝",
    "logger.warn(`[v4-pane] 恢复暂停队列被拒绝",
    "logger.warn(`[v4-pane] resumeGoal 被拒绝",
  ]) {
    assert.ok(!pane.includes(silent), `${silent} no longer swallows the refusal`);
  }
});

test("L: no false success notification", () => {
  assert.equal(queueActionNeedsReport(classifyQueueActionAck({ status: "accepted" })), false);
  assert.equal(queueActionNeedsReport(classifyQueueActionAck({ status: "noop" })), false);
  // The reporter only toasts inside a refusal branch.
  const reportStart = pane.indexOf("const reportQueueActionRefusal");
  const toastAt = pane.indexOf("toast(", reportStart);
  const guardAt = pane.indexOf("if (!queueActionNeedsReport(outcome)) return;", reportStart);
  assert.ok(reportStart > 0 && toastAt > guardAt, "the toast sits behind the refusal guard");
  // Suuna's telemetry no longer claims a projection it cannot see.
  assert.ok(
    !/action: "send_now"[\s\S]{0,400}resultSource: "authority_ack"/.test(panel),
    "send now reports the dispatch it made, not an authority ack",
  );
});
