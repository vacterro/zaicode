# T-244 SCOUT — SRC-160:R004 (CORE-004) audit lifecycle swallows a failed runtime stop

Date: 2026-10-06 · Ticket T-244 · Source SRC-160 (audit/1.md 142-172, revalidated STILL_PRESENT).

## Board verify clause (verbatim)

"a rejected jobService.cancel leaves the Quick3 campaign in a non-terminal, non-launching state and
never enqueues a replacement wave past a live worker; a test drives a cancel_stop_failed rejection
and asserts the campaign status and that no wave was launched"

## Sites (verified against current bytes)

| What | Where |
|---|---|
| the swallow | `packages/services/src/zaicode/zaicodeAuditService.ts` `retry` :686 (`cancel(state.jobId).catch(() => undefined)`), `cancel` :702 (same) |
| the truthful refusal it hides | `packages/services/src/zaicode/zaicodeJobCancellation.ts` `cancelZaicodeJob` :24-40 — on a failed `handle.stop()` it writes `cancel_stop_failed: …` on the row, keeps the handle in `runningHandles`, and **rethrows** |
| why the swallow is wrong | `zaicodeJobService.ts` :323 (`retry` refuses "Retry cancellation before starting another attempt") and :356 (the same for remove) — the queue itself treats `cancel_stop_failed` as "that worker may still be alive" |
| the launch that overlaps | `zaicodeAuditService.ts` `enqueueWave` :296-345 — creates a NEW job for the wave and sets `state.status = "running"`, `campaign.status = "running"`; it does not look at the previous attempt's row |
| the durable record already available | `ZaicodeAuditCampaignWaveState` (`packages/shared/src/zaicode-audits.ts` :22-50) — `jobId`, `rejectReason`, `attempt`, `idempotencyKey`; campaign status vocabulary `planned \| running \| complete \| blocked \| cancelled` (:98) |
| the existing guard that already expects this state | `archive` :716 throws "Retry cancellation before archiving this audit." when a wave/fix job carries `cancel_stop_failed`; test `T-141: a cancelled audit with a failed runtime stop cannot be archived` |
| the tests to extend | `packages/services/test/zaicodeAudits.test.ts` (harness `createHarness` :179-231, real job repo/service + injected report factory; `drive()` :237) |

## Defect mechanism

`cancel()` sets `campaign.status = "cancelled"` unconditionally after swallowing the stop failure, so
the campaign record claims a state the queue contradicts: the worker's handle is still live, the row
carries `cancel_stop_failed`, and the queue refuses to retry it. `retry()` is worse — it clears
`state.jobId`, sets `status = "pending"`, `campaign.status = "running"` and calls `enqueueWave`, so a
second wave is dispatched **over a live worker** and the campaign no longer even names the job that
is still running (the archive guard in :716 reads the wave's `jobId`, which is now null). That is the
"still-live worker outlives and overlaps a wave that believes it is gone".

## Lifecycle decision (this ticket owns it, per the SRC-160 contract)

The truthful terminal state for a failed stop is **not** a terminal state at all:

* a worker that would not stop means the work is still going; the campaign stays where it is
  (`running` for `cancel`, `blocked` for `retry`) — non-terminal, non-launching, exactly the state
  the clause demands;
* the wave keeps its `jobId` (the only handle anyone can still stop it by) and carries the reason in
  `rejectReason`, the field the panel already shows for a refused report;
* nothing is enqueued, no index, attempt or idempotency key moves;
* the operator's existing paths stay correct: `cancel` again retries the stop, `retry` (from the
  blocked state) retries the stop, and `archive` still refuses while the row carries
  `cancel_stop_failed`. No new status value is invented, so the UI and the legacy v1 campaigns are
  untouched.

## Design (settled here)

One private helper, two call sites:

```
private async stopWaveJob(jobId: string, state: ZaicodeAuditCampaignWaveState): Promise<boolean>
```

attempts `deps.jobService.cancel(jobId)`; on rejection it writes
`state.rejectReason = "the running task could not be stopped: <message>"` and returns false, leaving
the caller to stop where it is. `retry()` returns the campaign unchanged (saved) when the stop did
not succeed; `cancel()` does the same instead of setting `cancelled`. Every other path in the class
is untouched; the `catch(() => undefined)` swallow disappears.

## Test plan — `packages/services/test/zaicodeAudits.test.ts` (extend the existing harness)

`createHarness` gains an optional `refuseCancel` message; when set, the service is constructed with a
`Proxy` over the real job service whose `cancel` always rejects
(`cancel_stop_failed: <message>`), so the *real* queue semantics are what the campaign reacts to.

| Case | Clause |
|---|---|
| `cancel` against a refusing queue: status stays `running`, wave keeps its `jobId`, `rejectReason` names the failed stop, no job added, and a cold service reads the same non-terminal state from disk | "leaves the Quick3 campaign in a non-terminal, non-launching state" |
| `retry` from a blocked campaign against a refusing queue: status stays `blocked`, wave keeps `jobId`/`attempt`/`idempotencyKey`, `rejectReason` names the failed stop, and no replacement wave (`waves[1].jobId === null`, job count unchanged) | "never enqueues a replacement wave past a live worker … no wave was launched" |
| the happy paths must not regress: `cancel` with a working queue still reaches `cancelled`; `retry` with a working queue still re-runs the same wave | contract preservation (existing tests, unchanged) |

Red controls: the same two cases against the pre-fix service (unconditional `cancelled`, and the
retry that clears the job id and enqueues) — the suite is not a gate unless it goes red there.

## Declared ceiling

The refusal is recorded on the wave and the campaign stops moving; there is no backoff, no automatic
re-attempt of the stop, and no separate "stop failed" status — the operator retries by hand, which is
what the queue's own `cancel_stop_failed` contract already asks of them. A campaign whose worker is
actually gone but whose stop call threw stays `running`/`blocked` with the reason attached; the
honest alternative (guessing that the worker died) is exactly the mistake this ticket removes.
