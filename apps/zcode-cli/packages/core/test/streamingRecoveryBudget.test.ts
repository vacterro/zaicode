import assert from "node:assert/strict";
import test from "node:test";
import { resolveStreamRecoveryMaxRetries } from "../src/runtime/methods/streaming-recovery.js";

// SRC-051: the stream recovery budget is env-driven — ZAICODE holds the
// stream warm far longer (100) before a turn gives up; everyone else keeps 10.

test("recovery budget: 10 by default, 100 in ZAICODE mode", () => {
  assert.equal(resolveStreamRecoveryMaxRetries({}), 10);
  assert.equal(resolveStreamRecoveryMaxRetries({ ZCODE_ZAICODE_MODE: "0" }), 10);
  assert.equal(resolveStreamRecoveryMaxRetries({ ZCODE_ZAICODE_MODE: "1" }), 100);
});

test("recovery budget: an explicit env override wins, sane values only", () => {
  assert.equal(resolveStreamRecoveryMaxRetries({ ZCODE_STREAM_RECOVERY_MAX_RETRIES: "100" }), 100);
  assert.equal(resolveStreamRecoveryMaxRetries({ ZCODE_STREAM_RECOVERY_MAX_RETRIES: "7" }), 7);
  assert.equal(resolveStreamRecoveryMaxRetries({ ZCODE_STREAM_RECOVERY_MAX_RETRIES: "999999" }), 1000, "capped");
  assert.equal(resolveStreamRecoveryMaxRetries({ ZCODE_STREAM_RECOVERY_MAX_RETRIES: "0" }), 10, "0 is not a budget");
  assert.equal(resolveStreamRecoveryMaxRetries({ ZCODE_STREAM_RECOVERY_MAX_RETRIES: "junk" }), 10);
  assert.equal(
    resolveStreamRecoveryMaxRetries({ ZCODE_STREAM_RECOVERY_MAX_RETRIES: "25", ZCODE_ZAICODE_MODE: "1" }),
    25,
    "the operator's pick beats the mode default",
  );
});
