# T-248 SCOUT — SRC-160:R012 (PERF-001) bounded active-poll job read

Date: 2026-10-06 · Ticket T-248 · Source SRC-160 (audit/1.md 502-552, PROVEN BOTTLENECK, STILL_PRESENT)

## Board verify clause (verbatim)

"the active-poll path never deserializes the whole durable job history: a bounded or
paged query with an index that satisfies its ORDER BY, plus a test asserting the poll
issues a bounded read"

## Sites (verified against current bytes)

| What | Where |
|---|---|
| unbounded query | `zcode/packages/services/src/zaicode/zaicodeJobRepo.ts:189-219` — `SELECT * FROM zaicode_jobs${where} ORDER BY created_at ASC, sort_order ASC`, no LIMIT; every row through `rowToJob()` (the deserialization) |
| poll | `zcode/packages/ui/src/zaicode/ZaicodeWorkspace.tsx:32` `ACTIVE_POLL_MS = 3000` → `zaicodeStore.refresh` → `zaicodeStore.ts:137` `services.jobs.list({ workspaceKey })` (fresh after T-249) |
| other unbounded caller (NOT this clause) | `zaicodeHomeFeed.ts:96` `jobService.list({})` — SAIHOME feed, separate; `zaicodeAuditService.ts:226,338,769` filter by status/workspace and need the whole matching set for campaign checks — both keep today's behaviour |
| filter/result contract | `zcode/packages/shared/src/zaicode-jobs.ts:145-161` `ZaicodeJobListFilter { workspaceKey?, status?, agentId? }` → `ZaicodeJobListResult { jobs, diagnostics }`; service is a pass-through (`zaicodeJobService.ts:137-139`) |
| schema/indexes | `zcode/packages/services/src/session/tasksDatabase/zaicode-v4.ts:53-57` — `idx_zaicode_jobs_workspace (workspace_key, status, priority DESC, sort_order, created_at)`; prefix `workspace_key` matches the filter but the index order (status…) does not satisfy `ORDER BY created_at, sort_order` → sort + full history read. File header: existing declarations are frozen, later changes add a NEW migration |
| migration registry | `zcode/packages/services/src/session/tasksDatabase/migrations.ts:49-82` definitions, dispatch at `129-136` (`else` currently execs the v6 stats SQL — must gain an explicit v6 branch before v7) |
| UI consumers of `store.jobs` | queue panel (`ZaicodeQueuePanel.tsx:108,115`), strips (`ZaicodeWorkspaceStrips.tsx:51-54`), waiting meter (`ZaicodeWorkspace.tsx:117`), working meter, roster depth, scheduler bits — all count/group **live status**, none needs the full archive |
| test harness to copy | `zcode/packages/services/test/zaicodeJobs.test.ts:25-60` `createHarness()` (mkdtemp + `ZaicodeJobRepo(dbPath,500)` + `ensureReady()`), and the T-249 ui suite idiom for a spy on `services.jobs.list` |

## Design (decided)

1. **Contract**: `ZaicodeJobListFilter.limit?: number` — positive integer, bounded read.
   Default unchanged, so every existing caller keeps byte-identical semantics.
2. **Repo** (`list`, filter.limit set + workspaceKey set):
   * **recent**: `WHERE workspace_key=@k ORDER BY created_at DESC, sort_order DESC LIMIT @limit`
     — the newest N; reversed back to ASC after `rowToJob`, so the returned `jobs`
     is a **suffix** of the unbounded result (not a different order).
   * **older-active**: only when the window was actually full — non-terminal rows
     older than the window (`created_at < windowStart AND status IN (non-terminal)`).
     Guarantees no `running`/`waiting`/`queued`/`blocked`/`failed` job older than the
     window disappears from the live counts (anti-regression for the strips).
   * merge by jobId, dedupe, keep the established ASC order and merged diagnostics.
3. **Index** (new file `zaicode-job-query-v7.ts`, id `0007_zaicode_job_query`):
   `CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_recent ON zaicode_jobs (workspace_key, created_at DESC, sort_order DESC)`
   — satisfies `ORDER BY created_at DESC, sort_order DESC` under `workspace_key = ?`
   with no TEMP B-tree, and makes the `LIMIT` short-circuit cheap.
4. **Store**: `services.jobs.list({ workspaceKey, limit: ZAICODE_ACTIVE_POLL_JOB_LIMIT })`
   with the constant in `zaicodeStore.ts` (UI-owned knob), value 200.
5. **Tests**
   * services: (a) all-terminal history → bounded result === `unbounded.slice(-limit)`
     and ascending; (b) an **older running** job outside the window is still returned;
     (c) `EXPLAIN QUERY PLAN` for the recent read names `idx_zaicode_jobs_recent` and
     contains no `TEMP B-TREE`; (d) below the limit the read matches today's output.
   * ui: the refresh passes a finite positive `limit` to `jobs.list` (spy).

## Guardrails read from SRC-160 (PERF-001)

- freshness must not drop: active jobs of any age stay visible (design step 2).
- do not change the queue/history contract for callers that need the full set
  (audit service, home feed) — default `list()` stays unbounded.
- `rowToJob` diagnostics must still surface for both reads.
- raw durable rows remain canonical; no retention/deletion is introduced.

## Known ceiling (declared, not hidden)

The live queue shows a **window** (newest N + every older active row) in workspaces
holding more than N jobs: oldest terminal history scrolls out of the panel counts.
Upgrade path: cursor paging (`after <sort key>`) + a history view — that is the
"paged" alternative the verify clause allows, and it needs its own UI surface.

## Command map

- typecheck `pnpm run typecheck` · lint `pnpm run lint` · architecture `pnpm run architecture:check`
- ui tests `pnpm --filter @zcode/ui exec node --import tsx --test "test/*.test.ts"`
- services tests `pnpm --filter @zcode/services exec node --import tsx --test "test/*.test.ts"`
