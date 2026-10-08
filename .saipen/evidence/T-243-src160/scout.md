# T-243 (SRC-160 R003 / CORE-003) — scout

Clause (board): "concurrent delegations from one parent run can never exceed
`maxChildrenPerParent` and the per-run scope is enforced atomically in the durable store
(a probe that delegates in parallel from one run, plus a store-level assertion that the
child carries its delegating run)".

## The two defects, as measured

`packages/services/src/zaicode/zaicodeJobDelegation.ts` decided the budget from
`(await deps.repo.listChildren(parent.id)).length` (:71, pre-fix) and then created the
child in a second statement (:83). Both halves were wrong:

1. **Not the run's count.** `listChildren` returns every row whose `parent_job_id` is the
   parent — the parent's whole child history. `packages/shared/src/zaicode-delegation.ts`
   documents `maxChildrenPerParent` as "Children one parent run may create in total" and
   the prompt paragraph says "at most N for this run", but a parent row that runs again
   under a new run id (crash recovery re-claims the same row; only `retry` makes a new row)
   inherited the previous run's children, so the re-run silently got fewer helpers than the
   contract promises. Nothing durable recorded which run asked for a helper: the child row
   carried `parent_job_id` and no run.
2. **Not atomic.** Read (``listChildren``) and write (`create`) are two statements, so two
   delegations arriving together both saw `count = max - 1` and both created. The code
   comment even asserted the old, row-scoped reading on purpose ("预算按父任务行计 … 恢复同一行不重置预算").

## Design

- **A durable per-run fact.** New column `zaicode_jobs.delegated_from_run_id` (migration
  `0008_zaicode_delegation`, plus index `idx_zaicode_jobs_delegation(parent_job_id,
  delegated_from_run_id)`). It is written by the delegation path only. An ordinary child
  (the orchestration probe: `parentJobId` with no run) and a retried helper keep `NULL`,
  which is exactly the set that must not consume a run's budget.
- **The reservation is the write.** `ZaicodeJobRepo.createDelegatedChild(job, maxPerRun)`
  is one statement — `INSERT INTO zaicode_jobs (…) SELECT … WHERE (SELECT COUNT(*) …
  WHERE parent_job_id = @parentJobId AND delegated_from_run_id = @delegatedFromRunId)
  < @maxPerRun` — so under SQLite's single-writer transaction two racing requests cannot
  both see `max - 1`. `changes === 0` is the refusal; no row is written and no explicit
  transaction is needed. `ZaicodeJobRepo.create` and `createDelegatedChild` share one
  column/param list (`JOB_INSERT_COLUMNS`/`JOB_INSERT_VALUES`), so the two write paths
  cannot drift.
- **The count moved too.** `ZaicodeJobRepo.countDelegatedChildren(parentJobId,
  delegatingRunId)` groups by the delegating run, and the policy check uses it, so the
  ordinary (non-racing) refusal keeps the same `budget_exhausted` reason and wording. The
  pure policy function in `@zcode/shared` is unchanged.
- **Fail closed after the race.** When the atomic insert refuses, the module answers
  `budget_exhausted` with the same wording as the pure function. Nothing is silently
  over-issued and there is no fallback path around the store.
- **The service writes it.** `ZaicodeJobService` keeps one row builder (`buildJob`); the
  public `create()` is unchanged, and a new private `createDelegatedChild()` builds the row
  with the delegating run and goes through the conditional insert. `delegateFromRun` wires
  the new `createChild` dependency.

Unchanged on purpose: `delegateToChild` (the pre-planned, single child of a coordinator's
own `delegation` field) still creates through the ordinary path; `retry()` of a helper does
not carry the delegating run, because a retry is not a delegation request by a run.

## Declared ceiling

- Provenance is one run id, not a history: a helper knows the run that asked, not a chain.
- `maxChildrenPerParent` is enforced at the store on the delegation path. A caller that
  reaches `ZaicodeJobService.create` directly with `parentJobId` (the orchestration probe,
  which predates this ticket and is deliberate) is still uncounted — that is why a probe row
  is the second case in the migration/scope test rather than being folded into the count.
- Retries of helpers are not budget-counted (see above); the contract is what a *run* creates.

## Residual risk / follow-ups

- The desktop UI does not surface `delegatedFromRunId`; nothing needed it, so no UI change.
- A cross-process race is covered by SQLite's write serialization; two *processes* are not
  exercised by a test here (single-connection harness).
