# T-246 SCOUT — SRC-160:R011 (W2-003) a schedule stop is reported before the host confirms it

Date: 2026-10-06 · Ticket T-246 · Source SRC-160 (audit/1.md 346-384, STILL_PRESENT) ·
Owner of the schedule subsystem: this ticket.

## Board verify clause (verbatim)

"a schedule stop that the host rejects does not forget the run and does not report it ended; a
test forces a rejected stop and asserts the run is still tracked and no ended notification fired"

## Sites (verified against current bytes)

| What | Where |
|---|---|
| the session stop | `packages/ui/src/zaicode/zaicodeScheduleRun.ts` `stopZaicodeSessionRun` :262-268 — `await handle?.stop(...).catch(() => undefined); return true` |
| the stop rules | same file `applyZaicodeScheduleStopRules` :271-283 — `forget(job.id, due)` :275, `services?.jobs.cancel(jobId).catch(() => undefined)` :279, `notifyZaicode("autostart.fire", …)` :281 |
| the only caller | `packages/ui/src/zaicode/zaicodeAutostart.ts` :423-426, inside the 15 s tick (`TICK_MS` :59); `forget` filters `job.runs` by the ids it is given |
| what makes a run due | `zaicodeRunsToStop(job, now, stopMoment)` `zaicodeScheduler.ts` :157-169 — filters **`job.runs`**, so a run kept in `job.runs` is due again on the next tick |
| the other stop site | `clearZaicodeBeforeRun` :148-151 already reports `could not stop <title>` on rejection: the correct behaviour already exists here, only the stop rules lie |
| existing tests | `packages/ui/test/zaicodeWave60.test.ts` covers the board's pure planners (`planZaicodeBeforeRun`, order, score); **the stop rules have no test** |

## Defect mechanism (three, all in the stop rules)

1. **A stop that never happened is reported as stopped.** `handle?.stop(...).catch(() => undefined)`
   swallows the rejection, and `return true` says "handled as a session run" for *both* a missing
   handle (project not connected) and a rejected stop. The caller reads `true` as "stopped, move on".
2. **The run is forgotten before anything is attempted.** `forget(job.id, due)` :275 runs first, so
   the ids leave `job.runs` regardless of the outcome. A forgotten run can never be due again, so
   there is no retry and no state in which the operator could see it still stopping.
3. **The queue path swallows the same failure, then announces anyway.** `services?.jobs.cancel(jobId)
   .catch(() => undefined)` :279 hides a rejected cancel, and :281 notifies
   "`N run(s) ended by the stop time`" for the whole `due` list — the one thing the operator would
   act on, and it is false.

Consequence: the schedule's own bookkeeping says the run ended while the session may still be
running, and the operator is told so. Nothing is retried, because the retry loop *is* `job.runs`.

## Design (settled here)

* **Tri-state stop.** `stopZaicodeSessionRun` returns `"stopped" | "not-session" | "rejected"`
  instead of a boolean. `"not-session"` (a queue job) keeps the existing fall-through to the queue;
  `"rejected"` covers both a rejected `handle.stop` and a project with no handle at all — in both
  cases nothing was confirmed stopped. Single external consumer (`applyZaicodeScheduleStopRules`),
  so the signature change is contained.
* **Confirm before forgetting.** Attempt every due stop first; call `forget` with only the ids whose
  stop was confirmed. A rejected run stays in `job.runs`, which is exactly what makes the next tick
  (15 s) retry it — the audit's "keep the run listed as stopping" option, using the mechanism that
  already exists rather than a new state machine.
* **Announce only what happened.** The notification fires only when at least one run was confirmed
  stopped, and its body counts the confirmed ones and names the still-stopping rest. A stop that was
  never confirmed is silent: the run is still visible in the schedule, and the next tick tries again
  (no per-tick notification spam). Same scenario id and key, so the operator's card settings and
  dismissal still apply.
* **Queue cancel stays the queue's.** The carrier still only calls `services.jobs.cancel`; it does not
  reimplement cancellation, and a missing queue service is treated as "not confirmed" rather than as
  success.

## Guardrails

* `clearZaicodeBeforeRun` is untouched: it already pushes `could not stop <title>` on rejection.
* The due-run rule (`zaicodeRunsToStop`), the `forget` signature, the tick cadence, the notification
  scenario/key and the stop-order of session-then-queue are unchanged.
* No new module state, no new timer, no schema change: a run kept in `job.runs` is the retry.

## Test plan — `packages/ui/test/zaicodeScheduleStop.test.ts` (new, node:test)

| Case | Clause |
|---|---|
| a rejected session stop: `forget` is not called, no `autostart.fire` journal event | "does not forget the run and does not report it ended" |
| a session run whose project has no handle (not connected): same, and the handle is never called | same, the missing-handle half |
| a confirmed session stop: `forget` gets exactly that id and the event says the run ended | the rule still works when the host does confirm |
| a queue run whose `jobs.cancel` rejects: not forgotten, no event | same clause on the queue path |
| a queue run whose cancel resolves: forgotten, event fired | queue path preserved |
| a mixed job (one confirmed, one rejected): only the confirmed id is forgotten, the body counts 1 ended and 1 still stopping | no over-reporting |
| the same rejected run is attempted again on the next tick (it stays due) | "the run is still tracked" |
| `stopZaicodeSessionRun` returns `not-session` for a queue job and never touches the handle | contract preservation |

Red controls: the same file against the pre-fix stop rules (stop-first-forget-later removed,
rejection swallowed, unconditional notification) — it is not a gate unless it goes red there.

Harness: `publishZaicodeKnownProjects` + `registerZaicodeProjectContinue` (both real registry
entry points, no monkey-patching), a fake queue service, the real home journal as the
notification observable (it records `autostart.fire` before any card/quiet-hours filter), and a
fixed local-time `now` so the due computation is timezone-proof.

## Declared ceiling

A stop that keeps being rejected is retried once per tick forever (no backoff, no attempt counter,
no operator-facing "could not stop" card on this path); the run simply stays listed, which is the
honest state and the audit's own alternative. Upgrade path: an attempt counter plus one
`autostart.missed`-style card after N ticks — a UX decision, not part of this clause.
