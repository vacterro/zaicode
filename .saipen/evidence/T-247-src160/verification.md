# T-247 VERIFY — SRC-160:R010 (W2-004) delegation spool run-scoping + crash recovery

Date: 2026-10-06 · Ticket T-247 · Source SRC-160 (audit/1.md 385-426, STILL_PRESENT) ·
Layer SRC-160 · closure mode `own_patch` · tree: `zcode/` working tree, ticket delta 4 files
(scout: `.saipen/evidence/T-247-src160/scout.md`).

Requirement as normalized: "[W2-004 P1] Delegation spool requests must be run-scoped and
crash-recoverable: dirFor keys only on parentJobId, scan submits with the current runId,
.json->.taken->result has no recovery, and dispose() fences nothing."

## Board verify clause (verbatim)

"a claimed-but-unprocessed delegation request is recovered (or explicitly failed) after a
restart, two runs of one parent job cannot consume each others requests, and dispose() cannot
leave an in-flight scan writing after shutdown"

## Repair (what changed)

| File | Change |
|---|---|
| `packages/desktop/src/host/zaicodeDelegationSpool.ts` | rewritten: `dirFor(parentJobId, runId)` → `<root>/<name(parent)>__<name(run)>`; `open()` recovers its own folder before watching; `sweepOrphans()` for attempts that never come back; `dispose()` became async — fence + `await` of in-flight scans; `scan()` re-checks the fence before claiming and before writing; `reportChild()` routes by remembered/derived folder instead of a passed-in dir |
| `packages/desktop/src/host/index.ts` | construction block: dispose the previous instance, wire `setZaicodeChildFinishedListener` to the new per-run routing, run `sweepOrphans()` once at startup and warn with the count; the three teardown sites now `await`/`void` the async dispose (:2154 async shutdown, :2220 sync teardown, :2869 rebuild) |
| `packages/desktop/test/zaicodeDelegationSpool.test.ts` | new, 7 cases (below); the spool had no test before |
| `packages/services/test/zaicodeDelegation.test.ts` | cross-ticket adaptation, claim unchanged: `spool.dispose()` → `await spool.dispose()` in the existing happy-path test's `finally`, because dispose is now async (T-247 owns the signature) |

`packages/desktop/src/host/zaicodeRunDispatch.ts` was **not** changed: it already passes
`job.runId` (per attempt) to `open()`, and `close(job.id)` kept its signature — the run-scoped
folder is derived inside the carrier, so the three dispatch call sites stay untouched.

Design decisions and their reasons (explicit-failure recovery instead of replay, two recovery
paths, outcome routing without the run-link schema owned by CORE-003/T-243) are in the scout doc.

## Defect → proof

| Mechanism (scout) | Case that proves it fixed | Control that puts it back |
|---|---|---|
| shared folder: a leftover request of attempt 1 is claimed by attempt 2 and submitted under attempt 2's runId | 1 — two runs get different folders; run 2's scan neither claims nor answers run 1's request (gateway never called) | C1 |
| claim without recovery: crash between `.taken` and `.result.json` loses the request forever | 2 — `open()` fails an unanswered claim explicitly (`unprocessed_after_restart`), the gateway is never called, an already-answered claim is left alone; 3 — `sweepOrphans()` fails an old claim in a folder no run reopens and leaves a fresh one (live claim window) alone | C2 |
| unfenced dispose: a scan past its `await` writes after shutdown | 4 — `dispose()` does not settle while the timer's scan is parked in the gateway, the claim stays unanswered, and a later scan on the disposed spool answers nothing | C3 |
| outcome routing across attempts | 5 — a **restarted** spool instance (nothing in memory) finds the run folder whose answer names the child and writes `<child>.done.json` there, not in the other run's folder; 6 — an unroutable outcome warns once and writes nothing | C1 |
| contract preservation | 7 — request → `result.json` with the child id and status, a malformed request still answers `invalid_request`, nothing is answered twice | — |

## Red controls (each patch applied to the new spool, suite re-run, file restored by sha256)

| Control | Patch | Result | Transcript |
|---|---|---|---|
| C1 shared folder | `dirFor` ignores `runId` | exit 1 — cases 1, 5 red (5 pass) | `V:/tmp/t247-red-C1.txt` |
| C2 no claim recovery | `failClaimedWithoutAnswer` returns 0 | exit 1 — cases 2, 3 red (5 pass) | `V:/tmp/t247-red-C2.txt` |
| C3 unfenced dispose | both `if (this.fenced) break;` removed | exit 1 — case 4 red (6 pass) | `V:/tmp/t247-red-C3.txt` |

Restored after each: `restored=true`, spool sha256
`722ef507a5722789e0087ac8c293c4695726520544ab0b98213e611ba51b38ae` (identical before and after
all three controls). Driver: `V:/tmp/t247-red.mjs`.

Test evidence sha256: `zaicodeDelegationSpool.test.ts` `b3a78287…`, `services/test/zaicodeDelegation.test.ts` `f36b40a1…`.

## Gates (this tree, after the last edit)

| Gate | Command | Result |
|---|---|---|
| typecheck | `pnpm run typecheck` | exit 0 |
| lint | `pnpm run lint` | exit 0 — 0 errors, 166 warnings (baseline; the one warning T-247 introduced, `no-useless-spread` on the dispose snapshot, was removed by taking the snapshot with `Array.from`) |
| architecture | `pnpm run architecture:check -- --changed` | OK — violations 0, baseline 0, new 0 |
| scripts | `node --test scripts/*.test.mjs` | 118 pass / 0 fail |
| ui | `@zcode/ui` | 1282 pass / 0 fail (includes the T-188 live-vendor test, green this run) |
| services | `@zcode/services` | 110 pass / 0 fail (4 delegation-policy/spool cases included) |
| desktop | `@zcode/desktop` | 257 pass / 0 fail (7 new carrier cases included; 250 + 7) |
| cli | core / adapters / bootstrap | 45 / 9 / 11 pass, 0 fail |
| whole chain | `pnpm run test` | exit 0 |

`fmt:check` is red repo-wide (pre-existing, 3470/3739 files) and is not part of
`verify:pre-push`; T-247's files were not run through `oxfmt` to avoid reformatting untouched
code in the same commit.

## OPERATOR REQUIRED (not performed, not claimed)

1. **A real host restart on a packaged build**: kill the host between the claim rename and the
   answer write, restart it, and observe the `sweepOrphans()` warning and the
   `unprocessed_after_restart` answer in the affected run folder. The unit suite proves the
   carrier's behaviour on disk and the host wiring is typecheck-clean, but no packaged process
   was restarted to watch the startup sweep fire.
2. **Retention decision**: run folders accumulate one per attempt and nothing deletes them
   (durable history is deliberately preserved). Whether an operator-facing retention pass is
   wanted is a policy decision, not a correctness gap.

## Declared ceiling

Recovery is *explicit failure*, never replay: the carrier has no idempotency key, so
re-submitting a claimed request could create a second child for a request whose child already
existed. The board clause explicitly allows this ("recovered **or** explicitly failed"). A
folder that is never reopened is swept once at startup (not on a timer), so a claim can stay
unanswered until the next host start. Outcome routing after a restart derives the folder from
the answer file (bounded scan over the parent's folders), because the child row carries only
`parentJobId` — the run link belongs to CORE-003/T-243; if T-243 lands a run column, the
in-memory index and the derivation can both be dropped.

## Disposition

SRC-160:R010 → **IMPLEMENTED**: all four defects named in the clause are repaired and each is
covered by a case that goes red when only that defect is put back. Residuals above are ceilings,
not unaddressed parts of the clause; the two OPERATOR REQUIRED items are named rather than
silently skipped.
