import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DefaultRepeatedToolFailureDetector,
  type RepeatedToolFailureDetector,
} from "../src/tool/repeated-failure.js";
import type { ToolExecutionResult } from "../src/tool/types.js";

// T-305: bounded repeated-FAILURE detection with a concise recovery hint.
//
// Incidents: (A) 11 failing Read calls with the wrong workspace-root component
// "Witage" (canonical "Wintage") -- distinct paths each, so identical-call
// detection never trips; (B) three consecutive inputSchema validation failures
// sending offset/limit as strings. The detector is failure-based: count
// consecutive failures per tool, emit ONE concise hint at the threshold, reset
// on success (corrected retry), and never suppress or rewrite anything.

const WORKSPACE_ROOT = "W:\\Vintage\\proj";

function failure(
  toolName: string,
  opts: { code?: string; message: string; modelContent?: string } = {
    message: "boom",
  },
): ToolExecutionResult {
  return {
    toolCallId: "call-1",
    toolName,
    success: false,
    output: null,
    error: {
      type: "ToolExecutionFailed",
      message: opts.message,
      ...(opts.code ? { code: opts.code } : {}),
      stack: "stub-stack",
    },
    ...(opts.modelContent ? { modelContent: opts.modelContent } : {}),
    durationMs: 1,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

function validationFailure(toolName = "read"): ToolExecutionResult {
  return failure(toolName, {
    message: "Tool input failed inputSchema validation",
    modelContent:
      "<tool_use_error>InputValidationError: read failed due to the following issues:\n" +
      "The parameter `offset` type is expected as `number` but provided as `string`</tool_use_error>",
  });
}

function detector(): RepeatedToolFailureDetector {
  return new DefaultRepeatedToolFailureDetector();
}

test("A. wrong root spelling followed by a corrected path", () => {
  const d = detector();
  // Three distinct wrong-root paths: identical-input detection would miss these.
  for (let i = 0; i < 2; i += 1) {
    assert.equal(
      d.recordFailure(failure("read", { code: "read_file_not_found", message: "not found" }), {
        workspaceRoot: WORKSPACE_ROOT,
      }),
      undefined,
    );
  }
  const hint = d.recordFailure(
    failure("read", { code: "read_file_not_found", message: "not found" }),
    { workspaceRoot: WORKSPACE_ROOT },
  );
  assert.ok(hint, "hint expected on third consecutive failure");
  assert.ok(hint.includes(WORKSPACE_ROOT), "hint must reference the verified workspace root");
  assert.ok(hint.includes("Revalidate"), "hint must ask the model to revalidate the path");

  // Corrected path succeeds -> streak resets; the next failures may hint again.
  d.recordSuccess("read");
  assert.equal(
    d.recordFailure(failure("read", { code: "read_file_not_found", message: "not found" }), {
      workspaceRoot: WORKSPACE_ROOT,
    }),
    undefined,
  );
});

test("B. repeated wrong root spelling without correction", () => {
  const d = detector();
  let hints = 0;
  for (let i = 0; i < 11; i += 1) {
    const hint = d.recordFailure(
      failure("read", { code: "read_file_not_found", message: "not found" }),
      { workspaceRoot: WORKSPACE_ROOT },
    );
    if (hint) hints += 1;
  }
  // Bounded: exactly one hint per streak, not one per failing call.
  assert.equal(hints, 1);
});

test("C. numeric strings rejected by a strict numeric schema", () => {
  const d = detector();
  // Strict validation is preserved: the deterministic rejection is unchanged.
  const first = validationFailure();
  assert.equal(first.error?.message, "Tool input failed inputSchema validation");
  assert.ok(
    first.modelContent?.includes("expected as `number` but provided as `string`"),
    "sanitized diagnostic must name the field, expected type and observed type",
  );
  assert.ok(
    first.modelContent?.startsWith("<tool_use_error>InputValidationError"),
    "diagnostic keeps its existing tool_use_error envelope",
  );
  for (let i = 0; i < 2; i += 1) {
    assert.equal(d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT }), undefined);
  }
  const hint = d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT });
  assert.ok(hint, "validation-class hint expected at the threshold");
  assert.ok(hint.includes("offset and limit are numbers"), "hint states the concrete fix");
  assert.ok(hint.includes("do not resend"), "hint forbids resubmitting the same invalid input");
});

test("D. corrected numeric arguments succeed normally", () => {
  const d = detector();
  d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT });
  d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT });
  d.recordSuccess("read");
  // After correction, a fresh failing streak must NOT be permanently suppressed,
  // and must NOT count the old streak's failures either.
  assert.equal(d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT }), undefined);
  assert.equal(d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT }), undefined);
  assert.ok(
    d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT }),
    "a corrected retry does not cause stale suppression of a later streak",
  );
});

test("E. missing file under the correct root", () => {
  const d = detector();
  for (let i = 0; i < 2; i += 1) {
    assert.equal(
      d.recordFailure(
        failure("read", { code: "read_file_not_found", message: "File does not exist" }),
        { workspaceRoot: WORKSPACE_ROOT },
      ),
      undefined,
    );
  }
  const hint = d.recordFailure(
    failure("read", { code: "read_file_not_found", message: "File does not exist" }),
    { workspaceRoot: WORKSPACE_ROOT },
  );
  assert.ok(hint);
  assert.ok(hint.includes(WORKSPACE_ROOT));
});

test("F. intentional repeated probe after filesystem mutation", () => {
  const d = detector();
  d.recordFailure(failure("read", { code: "read_file_not_found", message: "nf" }), {
    workspaceRoot: WORKSPACE_ROOT,
  });
  d.recordFailure(failure("read", { code: "read_file_not_found", message: "nf" }), {
    workspaceRoot: WORKSPACE_ROOT,
  });
  // Filesystem mutation: the probe now succeeds.
  d.recordSuccess("read");
  // The operator's probe continues legitimately; still failing afterward is a new streak.
  assert.equal(
    d.recordFailure(failure("read", { code: "read_file_not_found", message: "nf" }), {
      workspaceRoot: WORKSPACE_ROOT,
    }),
    undefined,
  );
  assert.equal(
    d.recordFailure(failure("read", { code: "read_file_not_found", message: "nf" }), {
      workspaceRoot: WORKSPACE_ROOT,
    }),
    undefined,
  );
  assert.ok(
    d.recordFailure(failure("read", { code: "read_file_not_found", message: "nf" }), {
      workspaceRoot: WORKSPACE_ROOT,
    }),
    "a legitimate repeated probe is not suppressed after mutation",
  );
});

test("G. equivalent error text from unrelated operations", () => {
  const d = detector();
  const text = "operation failed";
  for (let i = 0; i < 3; i += 1) {
    d.recordFailure(failure("read", { message: text }), { workspaceRoot: WORKSPACE_ROOT });
  }
  const readHint = d.recordFailure(failure("read", { message: text }), {
    workspaceRoot: WORKSPACE_ROOT,
  });
  // Note: this 4th read call returns undefined (one hint per streak), so read's
  // first hint already fired at call 3 above.
  assert.equal(readHint, undefined);
  // A different operation with the same text is its own class.
  assert.equal(d.recordFailure(failure("bash", { message: text }), { workspaceRoot: WORKSPACE_ROOT }), undefined);
  assert.equal(d.recordFailure(failure("bash", { message: text }), { workspaceRoot: WORKSPACE_ROOT }), undefined);
  assert.ok(
    d.recordFailure(failure("bash", { message: text }), { workspaceRoot: WORKSPACE_ROOT }),
    "unrelated operations keep independent streaks",
  );
});

test("H. Windows drive paths and mixed separators", () => {
  const d = detector();
  const root = "W:\\Vintage\\proj";
  for (let i = 0; i < 2; i += 1) {
    assert.equal(
      d.recordFailure(
        failure("read", {
          code: "read_file_not_found",
          message: "File does not exist",
          modelContent: "W:/Vintage/proj\\src\\a.ts does not exist",
        }),
        { workspaceRoot: root },
      ),
      undefined,
    );
  }
  const hint = d.recordFailure(
    failure("read", { code: "read_file_not_found", message: "File does not exist" }),
    { workspaceRoot: root },
  );
  assert.ok(hint);
  // Root is referenced verbatim; no separator mangling or auto-rewrite.
  assert.ok(hint.includes("W:\\Vintage\\proj"));
});

test("I. host and model retry boundaries", () => {
  const d = detector();
  const result = failure("read", { code: "read_file_not_found", message: "nf" });
  // Detector is advisory: it never mutates the result's success status and never
  // throws -- the tool-layer failure still returns to the caller unchanged except
  // for the appended hint, leaving model-request retry (adapters) untouched.
  for (let i = 0; i < 3; i += 1) {
    d.recordFailure(result, { workspaceRoot: WORKSPACE_ROOT });
  }
  assert.equal(result.success, false, "a deterministic failure remains a failure");
  d.recordSuccess("read");
});

test("J. long-session recovery without stale suppression", () => {
  const d = detector();
  for (let round = 0; round < 3; round += 1) {
    d.recordFailure(failure("read", { code: "read_file_not_found", message: "nf" }), {
      workspaceRoot: WORKSPACE_ROOT,
    });
    d.recordFailure(failure("read", { code: "read_file_not_found", message: "nf" }), {
      workspaceRoot: WORKSPACE_ROOT,
    });
    const hint = d.recordFailure(
      failure("read", { code: "read_file_not_found", message: "nf" }),
      { workspaceRoot: WORKSPACE_ROOT },
    );
    assert.ok(hint, `streak ${round + 1} must hint (no stale one-shot suppression)`);
    d.recordSuccess("read");
  }
});

test("K. human versus synthetic message provenance preserved", () => {
  const d = detector();
  for (let i = 0; i < 2; i += 1) {
    d.recordFailure(validationFailure(), { workspaceRoot: WORKSPACE_ROOT });
  }
  const result = validationFailure();
  const hint = d.recordFailure(result, { workspaceRoot: WORKSPACE_ROOT });
  // The hint rides model content only; the operator-visible error message keeps
  // its canonical diagnostic (UI projection strips modelContent separately).
  assert.ok(hint);
  assert.equal(result.error?.message, "Tool input failed inputSchema validation");
  assert.ok(result.modelContent?.includes("<tool_use_error>InputValidationError"));
});
