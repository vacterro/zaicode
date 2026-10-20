import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQueueActionAck,
  describeQueueRefusal,
  saipenContinueOutcome,
  saipenContinueOutcomeLabel,
  sanitizeRefusalDetail,
  type SaipenContinueOutcome,
} from "../src/v4/queueActionOutcome.js";

/** [reasonCode, launcher detail, expected outcome] */
const cases: Array<[string, string, SaipenContinueOutcome]> = [
  [
    "guard.recognizedContinueSaipenUnavailable",
    "the SAIPEN launcher could not be started: spawn saipen ENOENT",
    "saipen-launcher-unavailable",
  ],
  [
    "guard.recognizedContinueSaipenRefused",
    "the SAIPEN safety valve is reached: WAIT: safety valve reached (0 waves / 20 tickets)",
    "safety-valve-limit-reached",
  ],
  [
    "guard.recognizedContinueSaipenRefused",
    "SAIPEN refuses this continuation and only the operator can clear it: WAIT: one operator decision is open",
    "operator-authorization-required",
  ],
  [
    "guard.recognizedContinueSaipenRefused",
    "the SAIPEN launcher refused this continuation: INGRESS_TASK_CARRIER_INVALID",
    "saipen-continuation-refused",
  ],
  ["guard.recognizedContinueNoOwner", "no host owns this project", "guard-refused"],
];

test("T-295.UI1: one guard code no longer answers five different refusals with one sentence", () => {
  for (const [reasonCode, detail, outcome] of cases) {
    assert.equal(saipenContinueOutcome(reasonCode, detail), outcome);
  }
  assert.notEqual(
    saipenContinueOutcomeLabel("safety-valve-limit-reached"),
    saipenContinueOutcomeLabel("saipen-launcher-unavailable"),
  );
  assert.notEqual(
    saipenContinueOutcomeLabel("operator-authorization-required"),
    saipenContinueOutcomeLabel("saipen-continuation-refused"),
  );
});

test("T-295.UI2: the refused operator continuation shows its real reason and the launcher diagnostic", () => {
  const ack = classifyQueueActionAck({
    status: "refused",
    reasonCode: "guard.recognizedContinueSaipenRefused",
    message:
      "the SAIPEN safety valve is reached: RECONCILE_REAUTH_REQUIRED -- wait: safety valve reached (0 waves / 20 tickets)",
  });
  assert.equal(ack.kind, "refused-authority");
  if (ack.kind === "admitted" || ack.kind === "already-resolved") throw new Error("refusal expected");
  const line = describeQueueRefusal(ack);
  assert.match(line, /safety-valve limit reached/);
  assert.match(line, /20 tickets/);
  assert.match(line, /^safety-valve limit reached:/, "the human label leads; the code is never the explanation");
});

test("T-295.UI3: a diagnostic is sanitized and bounded so a runaway detail cannot bury the status line", () => {
  const dirty = String.fromCharCode(0) + "refused " + String.fromCharCode(8) + " by the launcher now";
  assert.equal(sanitizeRefusalDetail(dirty), "refused by the launcher now");
  assert.equal(sanitizeRefusalDetail(null), "");
  assert.equal(sanitizeRefusalDetail("x".repeat(900)).length, 398);
});

test("T-295.UI4: with no message the outcome still names what happened instead of pretending", () => {
  const ack = classifyQueueActionAck({
    status: "refused",
    reasonCode: "guard.recognizedContinueSaipenUnavailable",
  });
  if (ack.kind === "admitted" || ack.kind === "already-resolved") throw new Error("refusal expected");
  assert.equal(describeQueueRefusal(ack), "SAIPEN launcher unavailable");
});

test("T-315.UI1: the refusal flavor is read from the code; the sentence is decoration", () => {
  // Keyword-scrubbed diagnostics: no rewording changes the diagnosis.
  assert.equal(
    saipenContinueOutcome("guard.recognizedContinueSaipenValve", "terse refusal, keywords scrubbed"),
    "safety-valve-limit-reached",
  );
  assert.equal(
    saipenContinueOutcome(
      "guard.recognizedContinueSaipenOperator",
      "reworded sentence with no valve or operator keywords at all",
    ),
    "operator-authorization-required",
  );
  assert.equal(
    saipenContinueOutcome("guard.recognizedContinueSaipenRefused", "the carrier did not match"),
    "saipen-continuation-refused",
  );
  for (const code of [
    "guard.recognizedContinueSaipenValve",
    "guard.recognizedContinueSaipenOperator",
    "guard.recognizedContinueSaipenRefused",
  ]) {
    const ack = classifyQueueActionAck({ status: "failed", reasonCode: code, message: "plain words" });
    assert.equal(ack.kind, "refused-authority", code);
  }
});

test("T-315.UI2: one legacy single-code ACK still classifies on its sentence", () => {
  assert.equal(
    saipenContinueOutcome(
      "guard.recognizedContinueSaipenRefused",
      "the SAIPEN safety valve is reached: WAIT: safety valve reached (0 waves / 20 tickets)",
    ),
    "safety-valve-limit-reached",
  );
});
