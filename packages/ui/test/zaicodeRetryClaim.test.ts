import assert from "node:assert/strict";
import test from "node:test";
import { zaicodeAutoRetryPaneClaims } from "../src/zaicode/zaicodeAutoRetry.js";

// SRC-058: a failed turn retried only after the operator walked into the
// project. A mounted pane claimed the session even when it could not act, so the
// background host stood down and nobody retried.

const base = {
  hasSession: true,
  enabled: true,
  hasError: true,
  retryable: true,
  armed: false,
  stoppedThisError: false,
};

test("a mounted pane that is not counting down leaves the session to the background host", () => {
  assert.equal(zaicodeAutoRetryPaneClaims(base), false, "no retryable row / cold snapshot");
  assert.equal(zaicodeAutoRetryPaneClaims({ ...base, hasError: false }), false, "error not projected (hidden tab)");
  assert.equal(zaicodeAutoRetryPaneClaims({ ...base, enabled: false, armed: true }), false, "read-only surface");
  assert.equal(zaicodeAutoRetryPaneClaims({ ...base, hasSession: false, armed: true }), false);
});

test("a pane that is counting down owns the retry", () => {
  assert.equal(zaicodeAutoRetryPaneClaims({ ...base, armed: true }), true);
});

test("an operator Stop or an error retrying cannot fix keeps everyone from retrying", () => {
  assert.equal(zaicodeAutoRetryPaneClaims({ ...base, stoppedThisError: true }), true);
  assert.equal(zaicodeAutoRetryPaneClaims({ ...base, retryable: false }), true);
});
