import { z } from "zod";

export const EXECUTION_LIVENESS_INTERVAL_MS = 30_000;
export const EXECUTION_LIVENESS_TTL_MS = 4 * EXECUTION_LIVENESS_INTERVAL_MS;

export const executionWorkLeaseSchema = z.object({
  workId: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "cancelled", "orphaned", "unconfirmed"]),
  confirmedAt: z.number().finite().nonnegative().nullable(),
  pid: z.number().int().positive().optional(),
});
export type ExecutionWorkLease = z.infer<typeof executionWorkLeaseSchema>;

export const executionLivenessSchema = z.object({
  ownerId: z.string().min(1),
  released: z.boolean(),
  observedAt: z.number().finite().nonnegative(),
  validUntil: z.number().finite().nonnegative(),
  foregroundExecutionId: z.string().min(1).optional(),
  background: z.array(executionWorkLeaseSchema),
  orphaned: z.boolean(),
  unconfirmed: z.boolean(),
});
export type ExecutionLivenessSnapshot = z.infer<typeof executionLivenessSchema>;

/** Host-clock check, performed while deriving the authoritative index sample. */
export function executionWorkLeaseRunning(lease: ExecutionWorkLease, observedAt: number): boolean {
  return (
    lease.status === "running" &&
    lease.confirmedAt !== null &&
    observedAt - lease.confirmedAt <= EXECUTION_LIVENESS_TTL_MS
  );
}

/** Mixed work: one missing sibling does not withdraw another positively owned execution. */
export function executionLivenessRunning(proof: ExecutionLivenessSnapshot): boolean {
  return (
    !proof.released &&
    (Boolean(proof.foregroundExecutionId) ||
      proof.background.some((lease) => executionWorkLeaseRunning(lease, proof.observedAt)))
  );
}

/** Receipt expiry uses receiver time; a remote host's wall clock is not the client's clock. */
export function executionLivenessFresh(
  proof: ExecutionLivenessSnapshot,
  receivedAt: number | undefined,
  now: number,
): boolean {
  return (
    receivedAt !== undefined &&
    receivedAt > 0 &&
    now - receivedAt <=
      Math.min(EXECUTION_LIVENESS_TTL_MS, Math.max(0, proof.validUntil - proof.observedAt))
  );
}
