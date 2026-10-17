import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { queueStateSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  isQueuePauseRecoverable,
  zaicodeQueueMayAutoResume,
  type ZaicodeQueueResumeFacts,
} from "../src/zaicode/zaicodeQueueAutoResume.js";

const baseFacts = (patch: Partial<ZaicodeQueueResumeFacts> = {}): ZaicodeQueueResumeFacts => ({
  hasSession: true,
  queueItems: 1,
  autoDrain: false,
  pauseReason: "error",
  pauseOrigin: "system",
  pauseReasonCode: "promotion_failed",
  phase: "completedSuccess",
  quotaWall: false,
  mayAutoSend: true,
  attempts: 0,
  maxAttempts: 5,
  ...patch,
});

test("RED-1: system-generated pause from promotion failure must be recognized as recoverable and not manual", () => {
  assert.equal(
    isQueuePauseRecoverable({
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: "promotion_failed",
    }),
    true,
    "system-generated promotion error pause is recoverable",
  );

  assert.equal(
    isQueuePauseRecoverable({
      pauseReason: "manual",
      pauseOrigin: "user",
      pauseReasonCode: "operator_paused",
    }),
    false,
    "operator manual pause is never auto-recoverable",
  );

  assert.equal(
    isQueuePauseRecoverable({
      pauseReason: "stopped",
      pauseOrigin: "user",
      pauseReasonCode: "operator_stopped",
    }),
    false,
    "operator Stop is never auto-recoverable",
  );
});

test("RED-2: SAIPEN operator_required and safety_valve hard_wait refusals must never be auto-resumed", () => {
  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        pauseReason: "error",
        pauseOrigin: "system",
        pauseReasonCode: "guard.recognizedContinueSaipenOperator",
      }),
    ),
    false,
    "SAIPEN operator required refusal must not auto-resume",
  );

  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        pauseReason: "error",
        pauseOrigin: "system",
        pauseReasonCode: "guard.recognizedContinueSaipenValve",
      }),
    ),
    false,
    "SAIPEN safety valve hard_wait refusal must not auto-resume",
  );

  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        pauseReason: "error",
        pauseOrigin: "system",
        pauseReasonCode: "guard.recognizedContinueAuthorizationExpired",
      }),
    ),
    false,
    "Expired authorization must not auto-resume",
  );
});

test("RED-3: recoverable system promotion pause resumes when authorized and session is idle", () => {
  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        pauseReason: "error",
        pauseOrigin: "system",
        pauseReasonCode: "promotion_failed",
      }),
    ),
    true,
    "recoverable promotion error resumes when idle and authorized",
  );
});

test("RED-4: User Stop and explicit User Pause never automatically resume", () => {
  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        pauseReason: "stopped",
        pauseOrigin: "user",
        pauseReasonCode: "operator_stopped",
      }),
    ),
    false,
    "User Stop must never automatically resume",
  );

  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        pauseReason: "manual",
        pauseOrigin: "user",
        pauseReasonCode: "operator_paused",
      }),
    ),
    false,
    "User manual pause must never automatically resume",
  );
});

test("RED-5: Session busy (running/prewarming) preserves FIFO and blocks premature resumption", () => {
  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        phase: "running",
      }),
    ),
    false,
    "Running session blocks auto-resumption to preserve turn FIFO",
  );

  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        phase: "prewarming",
      }),
    ),
    false,
    "Prewarming session blocks auto-resumption to preserve turn FIFO",
  );
});

test("RED-6: Quota wall and Auto OFF strictly prevent auto-resumption", () => {
  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        quotaWall: true,
      }),
    ),
    false,
    "Quota wall halts auto-resumption",
  );

  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        mayAutoSend: false,
      }),
    ),
    false,
    "Auto OFF halts auto-resumption",
  );
});

test("RED-7: Bounded retry safety cap halts infinite resume loops", () => {
  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        attempts: 4,
        maxAttempts: 5,
      }),
    ),
    true,
    "Attempt 4 of 5 is within budget and resumes",
  );

  assert.equal(
    zaicodeQueueMayAutoResume(
      baseFacts({
        attempts: 5,
        maxAttempts: 5,
      }),
    ),
    false,
    "Attempt 5 of 5 reaches cap and is halted",
  );
});

test("RED-8: QueueState schema accepts pauseOrigin and pauseReasonCode", () => {
  const parsed = queueStateSchema.safeParse({
    items: [],
    autoDrain: false,
    pauseReason: "error",
    pauseOrigin: "system",
    pauseReasonCode: "promotion_failed",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.pauseReason, "error");
    assert.equal(parsed.data.pauseOrigin, "system");
    assert.equal(parsed.data.pauseReasonCode, "promotion_failed");
  }
});

test("RED-9: UI ConversationQueuePanel and SessionPane wire pauseOrigin and pauseReasonCode", () => {
  const panel = readFileSync(join(import.meta.dirname, "../src/v4/ConversationQueuePanel.tsx"), "utf8");
  assert.match(panel, /data-pause-reason=\{queue\.pauseReason\}/);
  assert.match(panel, /data-pause-origin=\{queue\.pauseOrigin\}/);
  assert.match(panel, /data-pause-reason-code=\{queue\.pauseReasonCode\}/);

  const pane = readFileSync(join(import.meta.dirname, "../src/v4/SessionPane.tsx"), "utf8");
  assert.match(pane, /pauseOrigin:\s*snapshot\?\.queue\.pauseOrigin/);
  assert.match(pane, /pauseReasonCode:\s*snapshot\?\.queue\.pauseReasonCode/);
});
