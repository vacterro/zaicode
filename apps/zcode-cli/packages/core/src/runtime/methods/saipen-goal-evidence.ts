import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GOAL_COMPLETION_EVIDENCE_LIMITS,
  GOAL_COMPLETION_EVIDENCE_RULE_VERSION,
  goalCompletionDispositionOf,
} from "../deps.js";
import type {
  GoalCompletionEvidenceReading,
  GoalCompletionVerificationOutput,
} from "../deps.js";
import type { SaipenGoalProjection } from "./saipen-goal-verdict.js";

/**
 * ZAICODE (SAIHANDOFF F-05 / Q5): reading the memory records into a receipt.
 *
 * The verifier's COMPLETE claim used to be a sentence with nothing behind it. This
 * module turns the records the decision actually read -- BOARD.md and LOG.md --
 * into a digest-and-count record, so a third party can recompute the same verdict
 * from the receipt alone, and so the verdict itself can refuse to claim completion
 * when that record cannot be produced.
 */

/** The receipt's proof has to survive a tamper check, so it keeps the whole digest, not an abbreviation. */
export function digestEvidenceRecord(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

/** Last `[E-####]` event in the log: the point the decision's evidence ends. */
export function saipenLogBoundary(logContent: string): string | null {
  let boundary: string | null = null;
  for (const match of logContent.matchAll(/\[(E-\d+)\]/g)) boundary = match[1]!;
  return boundary;
}

/** The board counts the decision used, taken from the bytes this module hashes. */
export interface SaipenBoardCounts {
  done: number;
  actionable: number;
  blockedIds: readonly string[];
}

/**
 * Read the records behind a SAIPEN verdict. Null when BOARD.md or LOG.md cannot be
 * read: the board bytes ARE the proof, so a caller that gets null must report the
 * verdict unverified rather than complete.
 */
export function readSaipenGoalEvidence(input: {
  workspaceRoot: string;
  goalId: string | null;
  objective: string;
  projection: SaipenGoalProjection | null;
  board: SaipenBoardCounts;
}): GoalCompletionEvidenceReading | null {
  const boardPath = join(input.workspaceRoot, ".saipen", "BOARD.md");
  const logPath = join(input.workspaceRoot, ".saipen", "LOG.md");
  let boardBytes: string;
  let logBytes: string;
  try {
    boardBytes = readFileSync(boardPath, "utf8");
    logBytes = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  const projection = input.projection;
  return {
    ruleVersion: GOAL_COMPLETION_EVIDENCE_RULE_VERSION,
    projectIdentity: projection?.projectIdentity ?? input.workspaceRoot,
    goal: { id: input.goalId, objectiveDigest: digestEvidenceRecord(input.objective) },
    protocolVersion: projection?.protocolVersion ?? null,
    authority: projection ? "saipen_projection" : "board_files",
    projection: projection
      ? {
          phase: projection.phase,
          claimedTicket: projection.claimedTicket,
          topWorkableTicket: projection.topWorkableTicket,
          closureComplete: projection.closureComplete,
        }
      : null,
    board: {
      path: ".saipen/BOARD.md",
      hash: digestEvidenceRecord(boardBytes),
      revision: projection?.head ?? null,
      done: input.board.done,
      actionable: input.board.actionable,
      blocked: input.board.blockedIds.length,
      // Bounded on purpose: the receipt names the blockers, it does not copy the section.
      blockedIds: input.board.blockedIds.slice(0, GOAL_COMPLETION_EVIDENCE_LIMITS.blockedIds),
    },
    log: {
      path: ".saipen/LOG.md",
      hash: digestEvidenceRecord(logBytes),
      boundary: saipenLogBoundary(logBytes),
    },
    evidenceLocations: [".saipen/BOARD.md", ".saipen/STATE.md", ".saipen/LOG.md"],
  };
}

/** Attach the reading to a verdict; a verdict with no readable records carries no receipt and claims nothing. */
export function withGoalCompletionEvidence(
  verification: GoalCompletionVerificationOutput,
  reading: GoalCompletionEvidenceReading | null,
): GoalCompletionVerificationOutput {
  if (!reading) return verification;
  return {
    ...verification,
    evidence: {
      ...reading,
      disposition: goalCompletionDispositionOf(verification),
      reason: verification.reason,
    },
  };
}
