import type { ZaicodeJob } from "@zcode/shared";
import type { ZaicodeJobRepo } from "./zaicodeJobRepo.js";

export async function retainZaicodeCancellationFailure(repo: ZaicodeJobRepo, hasHandle: boolean, jobId: string, message: string, now: number): Promise<boolean> {
  if (!hasHandle || (await repo.get(jobId))?.status !== "cancelled") return false;
  await repo.setCancellationStopError(jobId, `cancel_stop_failed: ${message}`, now);
  return true;
}

/** Uses the queue service's existing handles; failed runtime stops remain retriable. */
export async function cancelZaicodeJob(input: {
  repo: ZaicodeJobRepo;
  handles: Map<string, { runId: string; stop?: () => Promise<void> }>;
  jobId: string;
  now: () => number;
  emitChanged: () => void;
  log: (message: string, error?: unknown) => void;
}): Promise<ZaicodeJob | null> {
  const { repo, handles, jobId, now, emitChanged, log } = input;
  await repo.ensureReady();
  const { job, applied } = await repo.cancel(jobId, now());
  const handle = handles.get(jobId);
  if (handle && (applied || job?.status === "cancelled")) {
    try {
      await handle.stop?.();
      await repo.setCancellationStopError(jobId, null, now());
      handles.delete(jobId);
    } catch (error) {
      log(`ZAICODE runtime stop failed during cancellation: ${jobId}`, error);
      await repo.setCancellationStopError(jobId, `cancel_stop_failed: ${error instanceof Error ? error.message : String(error)}`, now());
      emitChanged();
      throw error;
    }
  }
  emitChanged();
  return job ? repo.get(jobId) : null;
}
