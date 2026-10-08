# T-246 VERIFY — SRC-160:R009 (W2-003) a schedule stop is confirmed before the run is forgotten and reported ended

Date: 2026-10-06 · Ticket T-246 · Source SRC-160 (audit/1.md 346-384, STILL_PRESENT) ·
Layer SRC-160 · closure mode `own_patch` · tree: `zcode/` working tree, ticket delta 2 files
(scout: `.saipen/evidence/T-246-src160/scout.md`).

Requirement as normalized: "[W2-003 P1] Scheduler stop-at-time must confirm stop before forgetting
a run: stopZaicodeSessionRun returns true for a missing handle or a rejected stop, forget() runs
before the stop attempt, and cancellation errors are swallowed before a false success
notification."

## Board verify clause (verbatim)

"a schedule stop that the host rejects does not forget the run and does not report it ended; a test
forces a rejected stop and asserts the run is still tracked and no ended notification fired"

## Repair (what changed)

| File | Change |
|---|---|
| `packages/ui/src/zaicode/zaicodeScheduleRun.ts` | `stopZaicodeSessionRun` returns `"stopped" \| "not-session" \| "rejected"` instead of `boolean` — a missing handle (project not connected) and a rejected `handle.stop` are both rejections, so neither can read as a stop; `applyZaicodeScheduleStopRules` now attempts every due stop **first**, calls `forget` only with the ids whose stop was confirmed, keeps a rejected run in `job.runs`, and notifies only when at least one run was confirmed, its body counting the confirmed ones and naming the still-stopping rest |
| `packages/ui/test/zaicodeScheduleStop.test.ts` | new, 8 cases (below); the stop rules had no test before |

Unchanged: `zaicodeRunsToStop` and the due rule, the `forget` signature, the 15 s tick
(`TICK_MS`), `clearZaicodeBeforeRun` (it already reports `could not stop <title>` on rejection),
the notification scenario `autostart.fire` and its dismissal key, and the session-then-queue order.

## Defect → proof

| Mechanism (scout) | Case that proves it fixed | Control that puts it back |
|---|---|---|
| a missing handle or a rejected stop returned `true`, i.e. "stopped" | 1 — the stop is attempted, `forget` is **not** called, no `autostart.fire` event; 2 — a project with no handle: the run is not forgotten and the handle is never touched | C2 |
| `forget(job.id, due)` ran before anything was attempted, so no retry was possible | 1, 4 (queue path), 7 — the same rejected run is attempted again on the next tick because it never left `job.runs` | C1 |
| a rejected `jobs.cancel` was swallowed, then `N run(s) ended` was announced anyway | 4 — the cancel is attempted, nothing is forgotten, nothing is announced; 6 — a mixed job forgets only the confirmed run and says `1 … ended; 1 still stopping` | C2, C3 |
| the rule still works when the host does confirm | 3 (session), 5 (queue) — `forget` gets exactly that id, one event, body `1 run(s) ended by the stop time` | — |
| contract preservation | 8 — a queue job id is `not-session` and the session handle is never called | — |

The notification is observed through the real home journal, which `notifyZaicode` writes **before**
any card or quiet-hours filter — so "no ended notification fired" is measured, not inferred from a
toast that quiet hours could have suppressed.

## Red controls (each patch applied to the repaired file, suite re-run, file restored by sha256)

| Control | Patch | Result | Transcript |
|---|---|---|---|
| C1 forget before trying | `forget(job.id, due)` restored ahead of the attempts | exit 1 — 5 cases red (3 pass) | `V:/tmp/t246-red-C1.txt` |
| C2 rejection swallowed | both rejections return `"stopped"`, a rejected queue cancel counts as stopped | exit 1 — 5 cases red (3 pass) | `V:/tmp/t246-red-C2.txt` |
| C3 announce anyway | the confirmed-only gate removed, the body back to `due.length run(s) ended` | exit 1 — 5 cases red (3 pass) | `V:/tmp/t246-red-C3.txt` |

The three controls fail the same five cases on purpose: those cases assert both halves of the clause
("still tracked" and "not reported ended"), which each defect breaks in its own way (the failing
assertions differ — `forgets` vs `events` — and each control's transcript shows which). Restored
after each: `restored=true`, `zaicodeScheduleRun.ts` sha256
`23691791b456a9ffabe7eb1403f8f405b9fd84cad5c46156938fe8ab22c60fbe` (identical before and after all
three controls). Driver: `V:/tmp/t246-red.mjs`.

Test file sha256: `910f5a73e2cf6f80001d754510d61fa7ec34bcd91e5a11b4b052b96e014cc154`.

## Gates (this tree, after the last edit)

| Gate | Command | Result |
|---|---|---|
| typecheck | `pnpm run typecheck` | exit 0 |
| lint | `pnpm run lint` | exit 0 — 0 errors, 166 warnings (baseline; no finding in the changed files) |
| architecture | `pnpm run architecture:check -- --changed` | OK — violations 0, baseline 0, new 0 |
| scripts | `node --test scripts/*.test.mjs` | 118 pass / 0 fail |
| ui | `@zcode/ui` | 1290 pass / 0 fail (1282 + 8 new; includes the T-188 live-vendor test) |
| services | `@zcode/services` | 110 pass / 0 fail |
| desktop | `@zcode/desktop` | 257 pass / 0 fail |
| cli | core / adapters / bootstrap | 45 / 9 / 11 pass, 0 fail |
| whole chain | `pnpm run test` | exit 0 |

`fmt:check` is red repo-wide (pre-existing) and is not part of `verify:pre-push`.

## OPERATOR REQUIRED (not performed, not claimed)

1. **A live scheduler stop against a real host**: a real 15 s tick, a real session that refuses to
   stop, and the schedule row still showing the run afterwards. The unit suite drives the exact
   function the tick calls with a real registry and a refusing queue service, but no Electron
   renderer was run and no scheduled stop was watched end to end.
2. **Window behaviour of a stop that keeps being rejected**: the run stays listed (the honest
   state) with no card of its own; whether the operator wants an "N attempts, still stopping" card
   after a while is a UX decision (ceiling below).

## Declared ceiling

A stop that keeps being rejected is retried once per tick with no backoff and no attempt counter;
the run simply stays in `job.runs`, which is visible in the schedule but produces no notification
of its own. There is no new "stopping" state machine: the retry is the run staying tracked, the
option the audit itself names ("retry the stop, or keep the run listed as stopping"). Upgrade path:
an attempt counter plus one `autostart.missed`-style card after N ticks.

## Disposition

SRC-160:R009 → **IMPLEMENTED**: all three named defects (boolean success for a missing handle or a
rejected stop, forget-before-attempt, swallowed cancellation before a false success notification)
are repaired, and every case that covers them goes red when only that defect is put back. The two
OPERATOR REQUIRED items are named rather than silently skipped.
