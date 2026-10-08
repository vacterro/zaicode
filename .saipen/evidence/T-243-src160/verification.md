# T-243 (SRC-160 R003 / CORE-003) — verification

Clause: concurrent delegations from one parent run can never exceed `maxChildrenPerParent`
and the per-run scope is enforced atomically in the durable store (a probe that delegates in
parallel from one run, plus a store-level assertion that the child carries its delegating run).

## Change (hashes are sha256)

| file | what changed |
| --- | --- |
| `shared/src/zaicode-jobs.ts` `413655eb…` | `zaicodeJobSchema` gains `delegatedFromRunId` (optional; the schema is `.strict()`, so the field had to be declared to travel). |
| `shared/src/zaicode-delegation.ts` `d49ac5b3…` | `maxChildrenPerParent` documented as run-scoped and atomically reserved. No behaviour change (pure function untouched). |
| `services/src/session/tasksDatabase/zaicode-delegation-v8.ts` `43cf4a52…` | new migration `0008_zaicode_delegation`: `ALTER TABLE zaicode_jobs ADD COLUMN delegated_from_run_id TEXT` + `idx_zaicode_jobs_delegation(parent_job_id, delegated_from_run_id)`. |
| `services/src/session/tasksDatabase/migrations.ts` `2a03f3f4…` | registers `0008_zaicode_delegation` (ledger id + dispatch branch). |
| `services/src/zaicode/zaicodeJobRepo.ts` `b0fc0434…` | row mapping for the column; `countDelegatedChildren(parentJobId, delegatingRunId)`; `createDelegatedChild(job, maxPerRun)` (conditional `INSERT … SELECT … WHERE count < max`); `create` and the conditional insert share `JOB_INSERT_COLUMNS`/`JOB_INSERT_VALUES`. |
| `services/src/zaicode/zaicodeJobDelegation.ts` `89d0365b…` | budget read is `countDelegatedChildren(parent.id, input.runId)`; the write is the new `createChild` dep; an atomic refusal returns `budget_exhausted` with the pure function's wording. |
| `services/src/zaicode/zaicodeJobService.ts` `2c2f84b3…` | `buildJob(input, delegatedFromRunId?)` extracted; private `createDelegatedChild` writes through the conditional insert; `delegateFromRun` wires `createChild`. |
| `services/test/zaicodeDelegation.test.ts` `3aea128d…` | harness exposes `jobRepo`; two new tests. |
| `services/test/zaicodeJobs.test.ts` `d7257aeb…` | one new migration test over an existing queue table. |

## Tests

1. "T-243: six concurrent requests from one run create exactly the budget and refuse the
   rest" — six `delegateFromRun` calls issued together in one `Promise.all` from one parent
   run; exactly 3 report `ok`, the other 3 report `budget_exhausted`, `listChildren` returns
   3, and every created child's `delegatedFromRunId` equals the parent's run id.
2. "T-243: the durable budget is scoped to the delegating run, not the parent row" — an
   orchestration-probe child (`parentJobId`, no run) is asserted to carry no
   `delegatedFromRunId` and to consume nothing: `countDelegatedChildren(parent, runId)` stays
   `0` with the probe present; after three delegations it is `3`, a different run id reads
   `0`, and the parent still has 4 children. Each delegated child reports the run id through
   `repo.get`, i.e. through sqlite and back.
3. "T-243: the delegating-run column and its index arrive by migration over an existing
   queue" — a database built from the frozen `ZAICODE_SCHEMA` with a pre-existing job row,
   then `runTasksDatabaseMigrations`: the column exists, `idx_zaicode_jobs_delegation`
   exists, `0008_zaicode_delegation` is in `tasks_schema_migration`, and the legacy row's
   value is `NULL` (its data is untouched).

## Red controls (`V:/tmp/t243-red.mjs`, transcripts `V:/tmp/t243-red-C{1,2,3}.txt`)

Each control restores the file from a backup, patches it, runs the delegation suite, then
restores again.

| control | patch | result |
| --- | --- | --- |
| C1 | the child insert unconditional again (`repo.create`), per-run count kept | exit 1, 5 pass / 1 fail — only the concurrency test red |
| C2 | pre-T-243 behaviour wholesale: count over the parent's whole child history + read-then-create | exit 1, 4 pass / 2 fail — both new T-243 tests red |
| C3 | the child stops recording the run that asked | exit 1, 3 pass / 3 fail — both new T-243 tests **and** the pre-existing enforcement test red |

C1 pins the atomicity, C2 pins the run scope, C3 pins the durable fact. After the run the
sources are byte-identical (the driver restores from the backups it took first; the three
anchors — `createDelegatedChild(job, maxPerRun)`, `countDelegatedChildren(parent.id,
input.runId)`, the `delegatedFromRunId` field write — are present in the restored files).

## Gate table

| gate | command | result |
| --- | --- | --- |
| package suites | `node --import tsx --test test/zaicodeJobs.test.ts test/zaicodeDelegation.test.ts` (cwd `packages/services`) | 24/24 pass, 0 fail, exit 0 |
| full suite | `pnpm run test` (cwd `zcode`) | exit 0 — 118 / 1296 / 115 / 259 (2 pre-existing skips) / 45 / 9 / 11, 0 failing |
| lint | `pnpm run lint` | 0 errors, 166 warnings (all pre-existing; none in a touched file) |
| typecheck | `pnpm run typecheck` | exit 0, 0 TS errors |
| architecture | `pnpm run architecture:check -- --changed` | OK, 0 violations, 0 new |

One interruption to record honestly: an earlier full-suite run exited 1 on
`packages/desktop/test/zaicodeRuntimeIdentity.test.ts` ("machine endpoint is read-only …",
`TypeError: fetch failed` / `bad port`) — a local-port binding race in that test, in a package
this ticket does not touch. The file passes alone (9/9), the desktop suite passes alone
(259 tests, 257 pass, 2 skipped, 0 fail), and the next two full-suite runs exited 0. It is
reported here rather than hidden; it is not attributed to T-243.

## Disposition

R003: IMPLEMENTED.

## OPERATOR REQUIRED

none.
