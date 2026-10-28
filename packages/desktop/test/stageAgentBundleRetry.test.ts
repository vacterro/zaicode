import assert from "node:assert/strict";
import test from "node:test";
import { retryOnLock } from "../scripts/stage-agent-bundle.mjs";

// EBUSY defense: staging the agent bundle writes zcode.cjs in place while an
// antivirus/indexer or a not-yet-exited build reader can briefly hold the file
// open on Windows, so the first rm/copy throws EBUSY/EPERM. retryOnLock must
// retry transient lock errors and give up on anything else without masking it.

function lockError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

test("retryOnLock succeeds after a transient EBUSY then a clean attempt", () => {
  let attempts = 0;
  const sleeps = [];
  const result = retryOnLock(
    () => {
      attempts += 1;
      if (attempts === 1) throw lockError("EBUSY");
      return "ok";
    },
    { sleep: (ms) => sleeps.push(ms) },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 2, "retried exactly once after the lock");
  assert.deepEqual(sleeps, [500], "waited once before the retry");
});

test("retryOnLock retries EPERM/EACCES too, up to the cap, then rethrows", () => {
  let attempts = 0;
  assert.throws(
    () =>
      retryOnLock(
        () => {
          attempts += 1;
          throw lockError("EPERM");
        },
        { maxRetries: 3, sleep: () => {} },
      ),
    /EPERM/,
  );
  assert.equal(attempts, 4, "1 initial + 3 retries then gives up");
});

test("retryOnLock never retries a non-lock error", () => {
  let attempts = 0;
  assert.throws(
    () =>
      retryOnLock(
        () => {
          attempts += 1;
          throw new Error("agent bundle source missing");
        },
        { sleep: () => {} },
      ),
    /agent bundle source missing/,
  );
  assert.equal(attempts, 1, "a real build failure is surfaced immediately, not masked by retries");
});
