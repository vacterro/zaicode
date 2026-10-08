# T-249 SCOUT — PERF-002 workspace refresh (audit/1.md 553-605, SRC-160:R013)

Date: 2026-10-06. Baseline: `zcode` @ `1cbb0921` + dirty working tree (the SRC-161 wave).

## Where the defect lives

`zcode/packages/ui/src/zaicode/zaicodeStore.ts` (295 lines, `create()` closure):

| site | behaviour |
|------|-----------|
| `refresh` 164-186 | `agents.list()` → `jobs.list()` → `listTemplates()` → `getMaxConcurrency()` → `refreshAutoRun()` awaited **serially**, then one `set({... loading:false})`. No `Promise.all`, no in-flight coalescing, no generation/workspace token before the commit. |
| `runAction` 108-124 | every mutation `await get().refresh(...)` — so an action-triggered refresh overlaps a 3 s poll already in flight. |
| `refreshAutoRun` 143-162 | the ONLY guarded path (`let autoRunQuery = 0`, refused at 152) — the surrounding refresh has no equivalent. |
| commit 172-181 | an older pass finishing last overwrites `agents/jobs/templates/maxConcurrency/loading/error` with a stale snapshot. |

Caller: `ZaicodeWorkspace.tsx` — mount effect (85-90) and `ACTIVE_POLL_MS = 3000`
interval (93-101) both call `store.refresh(services, workspace)`; `runAction`
adds a third source. All three can be in flight together.

Broad subscription: `ZaicodeWorkspace.tsx:82` and `ZaicodeWorkspaceBar.tsx:83`
are `const store = useZaicodeStore()` (whole-store selector), so every
refresh write — 4 `set`s including `loading:true` then the big commit —
rerenders the whole workspace. `ZaicodeSchedulerPanel/Bits` already use narrow
selectors.

## Acceptance (board verify clause, verbatim)

> two overlapping refresh calls result in one in-flight read set and a stale
> response can never overwrite a newer one; a test issues overlapping refreshes
> with delayed responses and asserts the final store state came from the newest
> request

Guardrails from audit/1.md OPTIMIZE/GUARDRAIL that must still hold: active
queue ordering and selection semantics unchanged; user mutations must not
appear complete before post-action truth; workspace A results must never
commit into workspace B; `refreshAutoRun`'s late-read protection preserved;
Autopilot stale-result protection preserved; SQLite stays the authority; no
polling state competing with the host queue.

## Planned repair

1. Single-flight refresh inside the `create()` closure: one pass at a time,
   concurrent callers coalesce into exactly **one** pending pass and await the
   pass that satisfies their request (so `runAction` still sees post-mutation
   truth).
2. Commit guard: a pass commits only if no newer request and no different
   `workspaceKey` superseded it — old-workspace snapshots are dropped, never
   merged.
3. Parallelize the four independent reads with `Promise.all`, keeping
   `refreshAutoRun` in the same pass and preserving its generation guard.
4. `loading:true` is set when a pass actually starts (not on every coalesced
   caller), so a background poll does not add extra store emissions.

Not in scope (separate findings/tickets): PERF-001's bounded query (T-248),
and the two broad `useZaicodeStore()` call sites — narrowed after the
concurrency change lands, so a selector refactor can't mask a commit bug.

## Test plan (T-249 verify)

New `zcode/packages/ui/test/zaicodeT249RefreshSingleFlight.test.ts` with
deferred/replayed `ZaicodeServices` mocks: start refresh A, start newer
refresh B, complete B first, complete A last → final store must be B's
snapshot; assert only one read set is in flight across the overlap and that a
stale response never overwrites the newer commit.
