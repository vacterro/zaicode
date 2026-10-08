# T-248 verification — SRC-160:R012 (PERF-001) bounded active-poll job read

Date: 2026-10-06
Ticket: T-248 · Source: SRC-160 (audit/1.md 502-552, PERF-001 P1, PROVEN BOTTLENECK, STILL_PRESENT)
· Requirement: **SRC-160:R012** (the earlier R010 label in `scout.md` was wrong: R010 is the W2-004
delegation spool clause). Corrected in `scout.md`, the migration header and the store comment.

## Board clause (verbatim)

"the active-poll path never deserializes the whole durable job history: a bounded or
paged query with an index that satisfies its ORDER BY, plus a test asserting the poll
issues a bounded read"

## Repair — 5 production files

| File | Change |
|---|---|
| `packages/shared/src/zaicode-jobs.ts` | `limit?: number` on `ZaicodeJobListFilter`, with the contract spelled out: newest N rows in the list's own order (an ascending **suffix** of the unbounded read), open rows never dropped, omitted = unchanged full read. |
| `packages/services/src/zaicode/zaicodeJobRepo.ts` | Exported `zaicodeJobBoundedReadSql(conditions)` → `{ recent, olderActive }`, so a test can `EXPLAIN` the exact production text. `list()` gained a bounded branch: window read (`ORDER BY created_at DESC, sort_order DESC LIMIT @limit`), reversed to ascending; if the window came back under-filled it *is* the whole result; otherwise a second read returns "older than the window but still open" rows; merge by `job_id`, sort ascending. The unbounded path is byte-identical to before (same ASC full read → `toListResult`). |
| `packages/services/src/session/tasksDatabase/zaicode-job-query-v7.ts` (new) | Migration `0007_zaicode_job_query`: `idx_zaicode_jobs_recent (workspace_key, created_at DESC, sort_order DESC)` for the window, plus partial `idx_zaicode_jobs_open … WHERE status IN ('draft','queued','ready','running','waiting','blocked')` for the complement. |
| `packages/services/src/session/tasksDatabase/migrations.ts` | Registered `0007` in `definitions` and split the previous catch-all `else` into an explicit `0006_zaicode_stats` branch — the catch-all would otherwise have swallowed the new migration. |
| `packages/ui/src/zaicode/zaicodeStore.ts` | `ZAICODE_ACTIVE_POLL_JOB_LIMIT = 200`, passed as `limit` on the poll's `jobs.list` (the only call site that ticks every 3 s). |

### Escalation the first scale run forced

The first probe already bounded the *rows* (201 instead of 100,001/500,001) but the *work*
still grew with history — 31.54 ms @100k → 166.81 ms @500k — because the older-active
complement scanned the whole table every tick. That is exactly the audit's "work must stay
bounded as terminal history grows", so the partial index above was added and the complement
predicate pinned to the same status list. `OPEN_STATUS_SQL` in the repo and the literal in the
migration are two copies on purpose (the migration text *is* its checksum); drift is not silent
— test case 5 asserts the statement's query plan actually hits that index.

## Tests

`packages/services/test/zaicodeBoundedJobRead.test.ts` (new, 5 cases) and
`packages/ui/test/zaicodeT248PollLimit.test.ts` (new, 1 case) — **6/6 pass**.

| Case | Audit VERIFY bullet |
|---|---|
| under-limit result is `deepEqual` to the full read | contract: bounded read is a suffix, not a different ordering |
| 12 terminal rows, limit 5 → exactly `full.slice(-5)` | "returned operational row count … must stay bounded" |
| window older-active survival (oldest job `running`, newest completed) | "a bounded query containing active states plus the recent terminal tail" (audit OPTIMIZE) |
| equal `created_at` window boundary honours `sort_order` | ordering guardrail: "Active queue ordering, priority/reorder semantics … must remain identical" |
| both production statements are index-backed, no `TEMP B-TREE`, and each migration statement matches `sqlite_master.sql` | "Assert the hot query no longer requires a temp B-tree over all historical rows for its normal path" |
| store poll filter carries a finite `limit` for the workspace (1 ≤ limit ≤ 200) | board clause: "a test asserting the poll issues a bounded read" |

### Red controls (3, run on the final tree; each patch reverted and hash-verified)

| Control | Patch | Result |
|---|---|---|
| A | drop the older-active complement read | services file **2/5 fail** — "窗口之外仍在跑的任务一条都不能被截掉", "created_at 相同的行按 sort_order 划窗口边界" |
| B | rename `idx_zaicode_jobs_recent` in the migration | services file **1/5 fail** — the plan/index case |
| C | remove the store's poll `limit` | ui file **1/1 fail** — "the store's queue refresh carries a finite window limit" |

Each backup was restored in the same run and re-hashed equal to its pre-patch sha256
(`b317139f…` repo, `861bfc71…` v7, `7599ca4a…` store). Post-restore re-run: services 5/5, ui 1/1.
Transcripts: `V:/tmp/t248-red-C{1,2,3}.txt`.

## Scale evidence — `scale-probe.mts` / `scale-probe.json` (one-off, not a committed test)

Fixed active set = one `running` job older than every window. 201 returned rows = 200 window + 1 open.

| Terminal history | Full read (`list()` unchanged path) | Bounded read (`limit: 200`) |
|---|---|---|
| 100,000 (+1 active) | 100,001 rows / 784.22 ms | 201 rows / 1.54 ms |
| 500,000 (+1 active) | 500,001 rows / 4,899.57 ms | 201 rows / 2.35 ms |

Correctness invariants asserted at both sizes, all true: every bounded row exists in the full
read, every still-open job is present, and the bounded rows outside the open set are exactly the
newest 200 of the full ordering. An arbitrary old job (`job-<mid>`) stays directly fetchable via
`repo.get()`. Plans: `SEARCH zaicode_jobs USING INDEX idx_zaicode_jobs_recent (workspace_key=?)`,
no `TEMP B-TREE` (the complement's plan is asserted on the same index in test case 5).

Polls before the partial index, same seeds: 31.54 ms @100k → 166.81 ms @500k (work grew with
history); now 1.54 ms → 2.35 ms (flat, jitter-dominated).

**One-time upgrade cost on a full database:** dropping both indexes and re-running the exact
migration SQL over the seeded history took **96.33 ms @100k** and **555.96 ms @500k** rows — a
single startup-bound cost, paid once per store, inside the migration transaction.

## Gates (final tree, all rerun after the partial-index amendment)

| Gate | Command | Result |
|---|---|---|
| typecheck | `pnpm run typecheck` | exit 0 |
| lint | `pnpm run lint` | exit 0 — **0 errors, 166 warnings** (unchanged since T-240) |
| architecture | `pnpm run architecture:check` | `architecture: OK`, violations 0, baseline 0, new 0 |
| scripts | `node --test "scripts/*.test.mjs"` | exit 0 — 118/118 |
| ui suite | `pnpm --filter @zcode/ui exec node --import tsx --test "test/*.test.ts"` | exit 0 — **1282 tests, 1282 pass, 0 fail** |
| services suite | `pnpm --filter @zcode/services exec node --import tsx --test "test/*.test.ts"` | exit 0 — 110/110 |
| desktop suite | `pnpm --filter @zcode/desktop exec node --import tsx --test "test/*.test.ts"` | exit 0 — 252 tests, 250 pass, 2 skipped, 0 fail |
| cli core / adapters / bootstrap | same idiom per package | exit 0 — 45/45 · 9/9 · 11/11 |

Queue-contract re-run (audit VERIFY: "Re-run queue reorder/priority/cancel/retry/resume/delegation
tests and all CORE/W2 recovery gates"): `zaicodeJobs.test.ts` and `zaicodeDelegation.test.ts` are
inside the green services run — single-flight dispatch, idempotent cancel, stale-completion
rejection, restart reconciliation + resume, concurrency gate, autopilot refill, workspace
isolation, malformed rows still reported as diagnostics, delegation depth/budget/roles/spool, and
the W2-001 lease cases.

### T-188 live-vendor test: flaky, and green today

Earlier in this wave `test/zaicodeT188LiveAntigravity.test.ts` failed with
`five_hour@gemini_models claims a countdown its own data does not support`, then passed standalone
after my 5 files were reverted (hash-verified) and passed again with them restored. It reads the
live vendor snapshot cache (mtime rewritten by the running app) and does not import the changed
modules. In the final run above it **passed** (1.03 ms). Reported as live-data/wall-clock
flakiness — not claimed green as a general fact, and not claimed as this ticket's regression.

### `fmt:check` is red repo-wide and pre-existing (not a T-248 result)

`pnpm run fmt:check` exits 1 with "Format issues found in above **3470** files" of 3739 — the
flagged set is the whole tree, including files at HEAD that this ticket never touched. `fmt:check`
is not part of `verify:pre-push` (lint + architecture:check --changed + test). Not fixed here:
reformatting 3470 files would add an unreviewed diff to a performance ticket.

## Declared ceiling and upgrade path

The poll reads a **window, not a cursor**: 200 newest rows plus every still-open row older than
the window. That keeps the visible queue and all live status counts exact, and it is bounded in
both rows and work — but a workspace with more than 200 *open* jobs would return all of them
(no correctness loss, only that the bound degrades to "all open rows"). Audit OPTIMIZE's
"explicit pagination/cursor" surface for *historical* rows is not built: `repo.get(id)` already
fetches any old job directly, but there is no paging API. Upgrade path if ever needed: keyset
paging on `(created_at, sort_order)` — the index that would serve it is already in migration 0007.

## Not performed here — OPERATOR REQUIRED (no PASS claimed)

1. **Packaged-build measurement** (audit VERIFY, last bullet): IPC payload size and renderer heap
   over a long-running synthetic history. No packaged build was produced or inspected in this
   session; only the query-level probe above was measured.
2. **SAIHOME compact counts** (audit VERIFY, bullet 4): "exact running/queued/blocked/
   recent-completed counts without materializing every job". `zaicodeHomeFeed.ts` still calls
   `jobService.list({})` with no filter and keeps the default unbounded path — untouched by this
   ticket, so that bullet stays open.
3. **Composite RPC merge** (carried over from T-249): the four store reads are concurrent, not one
   host RPC. That is a host-contract change over the `jobs.list` payload shape, i.e. this ticket's
   territory, and it is not implemented.
4. **One-time index build on a real mature store** is measured only synthetically (96 ms @100k,
   556 ms @500k); the real installation's history size is unknown.

## Disposition rationale (DEFERRED, R013 precedent)

The board's clause is met with evidence: bounded query, index that satisfies the ORDER BY, and a
test asserting the poll issues a bounded read. The audit's fuller VERIFY set is only partly
performed — bullets 1, 2, 3, 5, 6 are answered above, bullet 4 (SAIHOME) and the final bullet
(packaged IPC/heap) are not — so R012 is disposed **DEFERRED**, not IMPLEMENTED, and the residuals
are named here rather than closed by assertion.

## Closure sequence used for SRC-160 (unchanged, recorded)

SRC-160 stays ACTIVE on purpose: coverage still carries non-terminal clauses (T-241…T-249 owners
plus the DEFERRED P2s), so no `source retire`, no `audit_inbox.consume`, and `audit/1.md` keeps
its generation.
