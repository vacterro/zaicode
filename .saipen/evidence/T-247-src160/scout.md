# T-247 SCOUT — SRC-160:R010 (W2-004) delegation spool run-scoping + crash recovery

Date: 2026-10-06 · Ticket T-247 · Source SRC-160 (audit/1.md 385-426, STILL_PRESENT) ·
Owner of the run-scoped schema gap is CORE-003/T-243; this ticket must not depend on it.

## Board verify clause (verbatim)

"a claimed-but-unprocessed delegation request is recovered (or explicitly failed) after a
restart, two runs of one parent job cannot consume each others requests, and dispose() cannot
leave an in-flight scan writing after shutdown"

## Sites (verified against current bytes)

| What | Where |
|---|---|
| the spool | `packages/desktop/src/host/zaicodeDelegationSpool.ts` — `dirFor` :43-45, `open` :48-65, `close` :68-73, `dispose` :75-78, `scan` :81-118, `reportChild` :121-146 |
| the one constructor | `packages/desktop/src/host/index.ts` :2868-2882 (`join(getZCodeDataRootDir(), "delegation")`) + `dispose()` at :2154, :2220, :2868 |
| the run that opens it | `packages/desktop/src/host/zaicodeRunDispatch.ts` :201-213 (`runId` = `job.runId`, per attempt), `close(job.id)` at :242, :283, :287 |
| the policy it feeds | `packages/shared/src/zaicode-delegation.ts` `evaluateZaicodeDelegation` :89-144 (`stale_run` compares `parent.runId !== input.runId`) |
| the queue-side entry | `packages/services/src/zaicode/zaicodeJobDelegation.ts` :57-92 (`delegateFromRun`) |
| existing tests | `packages/services/test/zaicodeDelegation.test.ts` (policy only). **The spool has no test today.** |

## Defect mechanism (three, all in the carrier)

1. **Shared folder across attempts.** `dirFor` keys on `parentJobId` alone; `open` passes the
   *watcher's* `runId` to the gateway, never one carried by the request. A leftover `<x>.json`
   written by attempt 1 is claimed by attempt 2's scanner and handed to `delegateFromRun` **with
   attempt 2's runId**, so the `stale_run` check passes and one run consumes another run's request.
2. **Claim without recovery.** `scan` renames to `<base>.taken` (:94) and writes the answer
   separately (:112). A crash in that window leaves a claimed request nobody will ever look at
   again: `.taken` fails `isZaicodeDelegationRequestFile`, and there is no sweep.
3. **Unfenced dispose.** `dispose()` clears timers only (:75-78). A scan already past its `await`
   keeps its `dir/parentJobId/runId/gateway` and writes its answer after shutdown.

## Design (settled here)

* **Run-scoped folder.** `dirFor(parentJobId, runId)` → `<root>/<spoolName(parent)>__<spoolName(run)>`.
  `open` still returns the folder for the prompt, so the agent-visible contract ("a folder only
  this run knows") becomes true rather than aspirational. Two attempts never share a folder.
* **Explicit failure, not replay.** Recover a claimed-but-unanswered `.taken` by writing
  `{ok:false, reason:"unprocessed_after_restart"}` — *not* by re-delegating. Re-running the
  gateway could create a second child for a request whose child was already created before the
  crash, and the carrier has no idempotency key that would prevent it. The board clause allows
  "recovered **or** explicitly failed"; failing is the honest, duplicate-free choice, and the
  coordinator's prompt already tells it not to wait for helpers.
* **Two recovery paths, because run ids are per attempt.** `job.runId` is claimed per attempt, so a
  resumed run gets a *new* runId and therefore a new folder. Hence (a) `open()` fails unanswered
  `.taken` in its own folder — that folder is exclusively ours, no grace needed; and (b)
  `sweepOrphans()` fails unanswered `.taken` older than `ORPHAN_GRACE_MS` under every folder in the
  root — that covers attempts that never come back. The grace keeps a live scan's
  claim→answer window (milliseconds) out of the sweep's reach.
* **Outcome routing without a schema change.** The child row carries `parentJobId` only (T-243 owns
  the run link), so `reportChild` routes by the answer file: an in-memory `childJobId → dir` index
  written when the spool answers, and after a host restart a bounded scan of the parent's folders
  for the `.result.json` that names the child. Nothing found → warn; the child's own SAIMAIL
  telegram is the documented backstop, and no unfounded routing is invented.
* **Fence + await.** `dispose()` becomes `async`, sets a fence, clears timers, and awaits the
  in-flight scans; a scan re-checks the fence before every write and stops. After `await
  dispose()` no answer file can appear.

## Guardrails

* The queue stays the only owner of jobs: the spool still only claims files and calls
  `delegateFromRun`; no policy logic moves into the carrier.
* `isZaicodeDelegationRequestFile`, the 64 KB request cap, the `ok/reason/detail` answer shape,
  the `.result.json` / `.done.json` names and the malformed-request answer stay as they are.
* `close(parentJobId)` keeps its signature and widens to "close every watch of this parent" — the
  three dispatch call sites stay untouched, and a stale watch can no longer outlive its run.
* Retention: folders are never deleted (the audit forbids deleting durable history); a folder's
  request/answer/outcome files are the audit trail of that attempt.

## Test plan — `packages/desktop/test/zaicodeDelegationSpool.test.ts` (new, node:test, tmpdir)

| Case | Clause |
|---|---|
| two runs of one parent get different folders; run 2's scan neither claims nor answers run 1's leftover | "two runs of one parent job cannot consume each others requests" |
| a `.taken` without an answer is failed explicitly on `open()`, gateway never called | "a claimed-but-unprocessed request is … explicitly failed after a restart" |
| `sweepOrphans()` fails an old `.taken` in a folder no run will reopen, and leaves a fresh one alone | same, the attempt-never-resumes path |
| `await dispose()` during an in-flight scan leaves no answer file behind | "dispose() cannot leave an in-flight scan writing after shutdown" |
| `reportChild` after a restart finds the run folder that names the child and writes `done.json` there | outcome routing across attempts |
| happy path unchanged: request → `result.json` with the child id and status | contract preservation |

Red controls: the same file against the pre-fix spool (shared folder, no recovery, unfenced
dispose) — it is not a gate unless it goes red there.

## Declared ceiling

Recovery answers "explicitly failed"; it does not resume a claimed request. An attempt whose
folder is never opened again is swept once at startup, not on a timer. Folders accumulate one per
attempt with no retention policy (upgrade path: a retention pass over the spool root, which is a
policy decision for the operator, not a correctness fix).
