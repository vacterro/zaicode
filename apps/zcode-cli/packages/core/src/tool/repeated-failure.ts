// T-305: bounded repeated-FAILURE detection with a concise recovery hint.
//
// The existing model-anomaly detector (runtime/helpers/model-anomaly.ts) watches
// identical tool CALL signatures and does not know whether they failed; a wrong
// root spelling that produces many distinct failing paths (each a different
// input) never trips it. This detector is failure-based: it counts
// consecutive FAILURES of the same tool+failure class, and after a small bounded
// threshold surfaces ONE concise recovery hint into that tool result's model
// content. It never blocks, never suppresses a retriable call, and never rewrites
// a user path — a corrected (successful) call resets the streak, so corrected
// retries proceed without obstruction (mission A–K).
import type { ToolExecutionResult } from "./types.js";

export interface RepeatedToolFailureDetector {
  /**
   * Count one deterministic failure for a tool. Returns a concise recovery hint
   * exactly once per streak, once the streak reaches the threshold.
   * `workspaceRoot` is the VERIFIED root already in executor context (no new FS
   * probing here).
   */
  recordFailure(
    result: ToolExecutionResult,
    opts: { workspaceRoot: string },
  ): string | undefined;
  /** A successful result for a tool resets its failure streak (corrected retry). */
  recordSuccess(toolName: string): void;
}

/**
 * Appends the bounded recovery hint, when one is due, to a failing result. Callers hand the
 * detector, the finished result and the already-verified workspace root; nothing is blocked
 * and no input is rewritten.
 */
export function applyRepeatedFailureHint(
  detector: RepeatedToolFailureDetector | undefined,
  result: ToolExecutionResult,
  workspaceRoot: string,
): ToolExecutionResult {
  const hint = detector?.recordFailure(result, { workspaceRoot });
  if (hint) result.modelContent = result.modelContent ? `${result.modelContent}\n\n${hint}` : hint;
  return result;
}

const REPEATED_TOOL_FAILURE_THRESHOLD = 3;

const VALIDATION_HINT_PREFIX = "<tool_use_error>InputValidationError";

export class DefaultRepeatedToolFailureDetector implements RepeatedToolFailureDetector {
  private readonly threshold: number;
  private readonly counts = new Map<string, number>();
  private readonly hinted = new Set<string>();

  constructor(threshold: number = REPEATED_TOOL_FAILURE_THRESHOLD) {
    this.threshold = threshold;
  }

  recordFailure(
    result: ToolExecutionResult,
    opts: { workspaceRoot: string },
  ): string | undefined {
    const toolName = result.toolName;
    const streak = (this.counts.get(toolName) ?? 0) + 1;
    this.counts.set(toolName, streak);
    if (streak < this.threshold) {
      return undefined;
    }
    if (this.hinted.has(toolName)) {
      // Bounded: one hint per streak, not one per failing call.
      return undefined;
    }
    this.hinted.add(toolName);
    return buildRecoveryHint(result, { workspaceRoot: opts.workspaceRoot });
  }

  recordSuccess(toolName: string): void {
    if (this.counts.delete(toolName)) {
      this.hinted.delete(toolName);
    }
  }
}

function buildRecoveryHint(
  result: ToolExecutionResult,
  opts: { workspaceRoot: string },
): string {
  const toolName = result.toolName;
  const code = result.error?.code;
  const modelContent = result.modelContent;
  if (
    typeof modelContent === "string" &&
    modelContent.startsWith(VALIDATION_HINT_PREFIX)
  ) {
    return [
      `You have called ${toolName} with input that failed schema validation ${REPEATED_TOOL_FAILURE_THRESHOLD} times in a row.`,
      "Fix the field type or value reported above (for example offset and limit are numbers, not strings) before retrying; do not resend the identical invalid input.",
    ].join("\n");
  }
  if (code === "read_file_not_found" || code === "read_file_too_large") {
    return [
      `You have repeatedly failed to read from a path.`,
      `Verified workspace root: ${opts.workspaceRoot}`,
      "Revalidate the target path against that root before retrying; do not guess or keep resending a path you have not confirmed.",
    ].join("\n");
  }
  return [
    `You have called ${toolName} and it failed ${REPEATED_TOOL_FAILURE_THRESHOLD} times in a row.`,
    `Verified workspace root: ${opts.workspaceRoot}`,
    "Use the last error to pick a different next step, or confirm the inputs before retrying.",
  ].join("\n");
}