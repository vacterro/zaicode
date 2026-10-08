# T-249 verification — SRC-160:R013 (PERF-002) workspace refresh single-flight / stale-result safe

Date: 2026-10-06
Ticket: T-249 · Source: SRC-160 (audit/1.md, generation `10f0983d…d99ca`, layer 1) · Finding: PERF-002 (P1)

## Board clause (verbatim)

"two overlapping refresh calls result in one in-flight read set and a stale response can never overwrite a newer one; a test issues overlapping refreshes with delayed responses and asserts the final store state came from the newest request"

## Repair

`zcode/packages/ui/src/zaicode/zaicodeStore.ts` (only production file touched):

1. **Single-flight queue** — `requestRefresh()` stamps every call with `++passGeneration`,
   stores it as the one `passPending` request and lets exactly one `drainRefreshPasses()`
   loop own the reads (`passRunning`). Concurrent callers coalesce into one trailing pass.
2. **Commit guard** — `runRefreshPass()` drops its whole snapshot when
   `generation !== passGeneration` (stale answer, or the caller already switched
   workspace). A dropped pass commits nothing at all — no partial state.
3. **Parallel reads** — the five serial awaits became one `Promise.all([...])`
   (agents, jobs, templates, maxConcurrency, `refreshAutoRun`). `refreshAutoRun`
   keeps its own `autoRunQuery` guard, so autopilot stale-read protection is unchanged.
4. **Callers resolve on truth** — each `requestRefresh()` promise resolves only when
   `passCommit >= its own generation`, so `runAction`'s post-mutation read always
   shows the post-mutation snapshot (SRC-160: "User-triggered actions must not appear
   complete before their authoritative post-action state is visible").

All-or-nothing error semantics kept: `Promise.all` rejects → `error` is set and nothing
in the snapshot is written (the audit's parallelization guardrail).

## Test — `zcode/packages/ui/test/zaicodeT249RefreshSingleFlight.test.ts` (new, 6 cases)

Deferred mock RPCs; every controlled read parks until the case releases its pass.

| Case | SRC-160 PERF-002 VERIFY bullet |
|---|---|
| independent reads of one pass run concurrently (`openReads() === 4`, one start per key) | "Verify the independent reads run concurrently" |
| newer request supersedes an answer that arrives late → store holds newest only; dropped response leaves no partial state | "start A; start newer B; … final store must contain B only" + "a stale response can never overwrite a newer one" |
| one refresh held open across ten tick opportunities → exactly one active read set and one trailing pass, then no further pass | "Hold one refresh open across ten three-second tick opportunities; assert at most one active refresh and at most one intentionally queued trailing refresh" |
| refresh requested during an active poll → final snapshot includes the mutation and never regresses | "Trigger a mutation during an active poll; final snapshot must include the mutation and never regress to pre-mutation state" |
| snapshot for an abandoned workspace never commits after navigation (A dropped, only B visible) | "Switch workspaces while old RPCs remain pending; no old workspace state may commit afterward" |
| burst of 11 concurrent refreshes costs 8 RPCs (4 × 2 passes), not 44 | unit proxy for the instrumented RPC-count reduction (see OPERATOR REQUIRED) |

Result: **6/6 pass**.

### Red control (proof the suite is not vacuous)

Temporarily restored the pre-T-249 serial `refresh` body (byte-identical to `git show HEAD:…`)
and re-ran the file:

```
✖ the independent reads of one pass run concurrently   — "one pass holds all four reads open concurrently", 1 !== 4
✖ a newer request supersedes an answer that arrives late — "the first refresh owns the read set", 0 !== 1
✖ one refresh held open across ten poll ticks …         — "at most one active refresh read set", 0 !== 1
```

Three definite failures (the run then stalls because the serial code never answers the
later cases — the defect itself). Control reverted afterwards; final store file restored
from `V:/tmp/store-t249.ts` and re-run green.

## Cross-ticket test adaptation (disclosed)

`zcode/packages/ui/test/zaicodeT186CollectScheduler.test.ts` (T-186, foreign ticket) hung
for 19.8 min in the full ui suite under the new code: it awaited `setAutoRun(...)`, whose
own post-action `refresh()` is now the *trailing* pass, i.e. it waits for the held pass to
be released — while the test only released that pass after the await. Deadlock, test-side.

Change (interleaving only, claim unchanged): the toggle is started and confirmed, then the
held *older* read is answered, then the trailing pass is released and both promises awaited.
The held trailing read was added so the stale answer is observed **before** any newer
pass commits, which keeps the test discriminating instead of making it vacuous.

Proof it did not weaken: with the `autoRunQuery` stale-read guard disabled
(`if (query !== autoRunQuery) return false;`) the file fails 2/8:

```
✖ the Autopilot projection reads host state and refuses a stale read after a confirmed toggle
✖ a full queue refresh cannot overwrite a confirmed Autopilot toggle with an older read
  AssertionError: an older read answering `true` after the toggle cannot resurrect Autopilot — true !== false
```

Guard restored (verified: present, no RED CONTROL marker, `requestRefresh` wired).

## Gates (final tree)

| Gate | Command | Result |
|---|---|---|
| typecheck | `pnpm run typecheck` | exit 0 |
| lint | `pnpm run lint` | exit 0 — 0 errors, 166 pre-existing warnings (unchanged since T-240) |
| architecture | `pnpm run architecture:check` | exit 0 — violations 0, new 0 |
| ui suite | `node --import tsx --test "test/*.test.ts"` | 1281 tests, **1280 pass, 1 fail** |

### The 1 failure is not from this change (exonerated, not defended)

`test/zaicodeT188LiveAntigravity.test.ts` → "a live vendor window that has started shows a
live countdown and is not re-startable" fails with `five_hour@gemini_models claims a
countdown its own data does not support`. It reads the live vendor snapshot cache
(`antigravity()`, skipped when absent) and:

* reproduces **standalone, twice**, outside the suite;
* the file **does not import `zaicodeStore`**;
* fails **identically with `git show HEAD:packages/ui/src/zaicode/zaicodeStore.ts`**
  (the pre-T-249 store) in place — i.e. it is live-vendor-data/wall-clock drift, not a
  regression of this ticket. It is reported, not claimed green.

## Not performed here — OPERATOR REQUIRED (no PASS claimed)

1. **Instrumented live run (SRC-160 PERF-002 VERIFY, last bullet):** RPC count, store
   emissions and React commits over a 60-second active-job run of the packaged UI,
   confirming material reduction without losing freshness. Only the unit-scale proxy
   above was measured; no packaged build was produced or inspected in this session.
2. **Composite RPC replacement:** the four reads are now concurrent, not merged into a
   single host RPC. That is a host-contract change and belongs with T-248 (PERF-001),
   which owns the payload shape of `jobs.list`.
3. **`--test-force-exit` was used for diagnostic runs only**; the repository's own
   `pnpm run test` invokes `node --test` without it, and the final evidence run is the
   plain suite above.

## Closure sequence used for SRC-160 (unchanged, recorded)

SRC-160 stays ACTIVE on purpose: coverage still carries non-terminal clauses
(R001…R005 → T-241…T-249 owners, plus 5 DEFERRED P2s), so no `source retire`,
no `audit_inbox.consume`, and `audit/1.md` keeps generation `10f0983d…d99ca`.
