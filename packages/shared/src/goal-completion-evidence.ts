import { z } from "zod";
import { GoalCompletionDispositionSchema } from "./goal-completion-disposition.js";

/**
 * ZAICODE (SAIHANDOFF F-05 / Q5): the inspectable proof behind a completion verdict.
 *
 * In a SAIPEN workspace the verifier answered COMPLETE with a sentence -- "board
 * clear: 43 done, nothing left" -- and no artifact anyone could check. The receipt
 * records what the decision actually read: the digest of the exact board bytes and
 * the counts derived from them, the log boundary the board was read at, and which
 * authority decided. A reader can recompute it without the transcript; a verdict
 * whose receipt cannot be produced is reported unverified, never complete.
 *
 * Deliberate ceiling: the receipt proves a state of the memory records, not that
 * the work behind a closed ticket was good -- that stays REVIEW's job.
 */

/** Which decision rules produced the verdict; a reader that does not know this version must not read the receipt. */
export const GOAL_COMPLETION_EVIDENCE_RULE_VERSION = "zcode.saipen-goal-evidence/1";

/** A receipt is bounded data, not a copy of the board: long lists are truncated, counts stay exact. */
export const GOAL_COMPLETION_EVIDENCE_LIMITS = {
  blockedIds: 20,
  locations: 8,
} as const;

export const GoalCompletionBoardEvidenceSchema = z
  .object({
    /** Workspace-relative record path, so the receipt reads the same on another machine. */
    path: z.string().min(1),
    /** Whole `sha256` digest of the board bytes the decision read. */
    hash: z.string().min(1),
    /** SAIPEN's own board revision (`saipen status --json` head) when it answered. */
    revision: z.string().nullable(),
    done: z.number().int().nonnegative(),
    /** Live tickets a session could pick up; a TODO line naming a blocker is blocked, not actionable. */
    actionable: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    blockedIds: z
      .array(z.string().min(1))
      .max(GOAL_COMPLETION_EVIDENCE_LIMITS.blockedIds),
  })
  .strict();

export const GoalCompletionLogEvidenceSchema = z
  .object({
    path: z.string().min(1),
    hash: z.string().min(1),
    /** Last `[E-####]` event in the log: where the evidence the verdict read ends. */
    boundary: z.string().min(1).nullable(),
  })
  .strict();

export const GoalCompletionProjectionEvidenceSchema = z
  .object({
    phase: z.string(),
    claimedTicket: z.string().nullable(),
    topWorkableTicket: z.string().nullable(),
    closureComplete: z.boolean().nullable(),
  })
  .strict();

export const GoalCompletionEvidenceReceiptSchema = z
  .object({
    ruleVersion: z.literal(GOAL_COMPLETION_EVIDENCE_RULE_VERSION),
    projectIdentity: z.string().min(1),
    goal: z
      .object({
        id: z.string().nullable(),
        /** The objective's digest: the receipt stays bounded and carries no prompt text. */
        objectiveDigest: z.string().min(1),
      })
      .strict(),
    protocolVersion: z.string().nullable(),
    /** Who decided: SAIPEN's own projection, or the board bytes alone. */
    authority: z.enum(["saipen_projection", "board_files"]),
    projection: GoalCompletionProjectionEvidenceSchema.nullable(),
    board: GoalCompletionBoardEvidenceSchema,
    log: GoalCompletionLogEvidenceSchema,
    evidenceLocations: z
      .array(z.string().min(1))
      .max(GOAL_COMPLETION_EVIDENCE_LIMITS.locations),
    disposition: GoalCompletionDispositionSchema,
    reason: z.string(),
  })
  .strict();

export type GoalCompletionEvidenceReceipt = z.infer<
  typeof GoalCompletionEvidenceReceiptSchema
>;

/** The receipt before the verdict names itself: the producer adds `disposition` and `reason`. */
export type GoalCompletionEvidenceReading = Omit<
  GoalCompletionEvidenceReceipt,
  "disposition" | "reason"
>;

/**
 * Why this reading cannot back a COMPLETE claim, or null when it can. The answer
 * depends on the authority: SAIPEN's projection has to say the closure is complete
 * and name no work, while a board-files decision has to have found nothing
 * actionable in the bytes it hashed.
 */
export function goalCompletionEvidenceGap(
  reading: GoalCompletionEvidenceReading,
): string | null {
  if (!reading.log.boundary) {
    return "the log carries no boundary event for the decision";
  }
  if (reading.authority === "saipen_projection") {
    if (!reading.projection) {
      return "the decision cites SAIPEN's projection, but none was recorded";
    }
    if (reading.projection.closureComplete !== true) {
      return "SAIPEN did not report the closure complete";
    }
    const open =
      reading.projection.claimedTicket ?? reading.projection.topWorkableTicket;
    return open ? `SAIPEN still names work: ${open}` : null;
  }
  return reading.board.actionable === 0
    ? null
    : `${reading.board.actionable} actionable ticket(s) in the board the decision read`;
}
