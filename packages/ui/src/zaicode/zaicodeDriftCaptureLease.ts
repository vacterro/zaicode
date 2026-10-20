/**
 * Durable capture ownership.
 *
 * Two windows of the same application must never capture the same sessions at
 * the same time. The lease lives in local storage so it survives a renderer
 * restart, and it is re-read after a yield so the loser of a same-tick race
 * sees the winner instead of capturing in parallel.
 */

export const LEASE_TTL_MS = 2 * 60 * 1000;
export const LEASE_KEY = "zaicode-drift-capture-lease";

export interface BatchLease {
  ownerId: string;
  batchId: string;
  expiresAt: number;
}

export type LeaseStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const WINDOW_OWNER_ID = `window-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

export function defaultLeaseStorage(): LeaseStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function parseLease(raw: string | null): BatchLease | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<BatchLease>;
    if (
      typeof parsed.ownerId === "string" &&
      typeof parsed.batchId === "string" &&
      typeof parsed.expiresAt === "number"
    )
      return parsed as BatchLease;
  } catch {
    return undefined;
  }
}

export async function acquireBatchLease(input: {
  storage: LeaseStorage;
  ownerId: string;
  batchId: string;
  now: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  let current: BatchLease | undefined;
  try {
    current = parseLease(input.storage.getItem(LEASE_KEY));
  } catch {
    return { ok: false, reason: "Cannot verify capture ownership: local storage unavailable" };
  }
  if (
    current &&
    current.expiresAt > input.now &&
    !(current.ownerId === input.ownerId && current.batchId === input.batchId)
  ) {
    return {
      ok: false,
      reason: `Capture is already running in another window (batch ${current.batchId})`,
    };
  }
  try {
    input.storage.setItem(
      LEASE_KEY,
      JSON.stringify({
        ownerId: input.ownerId,
        batchId: input.batchId,
        expiresAt: input.now + LEASE_TTL_MS,
      }),
    );
  } catch {
    return { ok: false, reason: "Cannot persist capture ownership" };
  }
  // Two windows can write in the same tick; re-read after yielding so the
  // loser observes the winner instead of both capturing.
  await input.sleep(25);
  const confirmed = parseLease(input.storage.getItem(LEASE_KEY));
  if (!confirmed || confirmed.ownerId !== input.ownerId || confirmed.batchId !== input.batchId) {
    return { ok: false, reason: "Capture ownership was claimed by another window" };
  }
  return { ok: true };
}

export type LeaseRefreshResult = { ok: true } | { ok: false; reason: string };

/**
 * Extend a lease the caller still owns.
 *
 * A refresh that cannot prove ownership is not silently ignored: the caller
 * must stop starting new work, or a slow capture loses the batch to a second
 * window and both write into the same vault.
 */
export function refreshBatchLease(input: {
  storage: LeaseStorage;
  ownerId: string;
  batchId: string;
  now: number;
}): LeaseRefreshResult {
  try {
    const current = parseLease(input.storage.getItem(LEASE_KEY));
    if (current && (current.ownerId !== input.ownerId || current.batchId !== input.batchId)) {
      return {
        ok: false,
        reason: `Capture ownership moved to another window (batch ${current.batchId})`,
      };
    }
    input.storage.setItem(
      LEASE_KEY,
      JSON.stringify({
        ownerId: input.ownerId,
        batchId: input.batchId,
        expiresAt: input.now + LEASE_TTL_MS,
      }),
    );
    return { ok: true };
  } catch {
    return { ok: false, reason: "Cannot persist capture ownership" };
  }
}

/**
 * A heartbeat that keeps a long batch inside its TTL.
 *
 * The capture is mostly waiting on Host I/O, so the renderer timer is the only
 * thing that can prove the owner is alive. A lease that could not be refreshed
 * raises `onLost` exactly once and then stops.
 */
export function startLeaseHeartbeat(input: {
  storage: LeaseStorage;
  ownerId: string;
  batchId: string;
  now: () => number;
  onLost: (reason: string) => void;
  intervalMs?: number;
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}): () => void {
  const scheduler = input.scheduler ?? {
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (handle: unknown) => globalThis.clearInterval(handle as number),
  };
  const interval = input.intervalMs ?? Math.max(1_000, Math.floor(LEASE_TTL_MS / 3));
  let stopped = false;
  const handle = scheduler.setInterval(() => {
    if (stopped) return;
    const result = refreshBatchLease({
      storage: input.storage,
      ownerId: input.ownerId,
      batchId: input.batchId,
      now: input.now(),
    });
    if (result.ok) return;
    stopped = true;
    scheduler.clearInterval(handle);
    input.onLost(result.reason);
  }, interval);
  return () => {
    stopped = true;
    scheduler.clearInterval(handle);
  };
}

export function releaseBatchLease(input: {
  storage: LeaseStorage;
  ownerId: string;
  batchId: string;
}): void {
  try {
    const current = parseLease(input.storage.getItem(LEASE_KEY));
    if (current?.ownerId === input.ownerId && current.batchId === input.batchId) {
      input.storage.removeItem(LEASE_KEY);
    }
  } catch {
    // ignore
  }
}
