# T-242 / CORE-002 — verification record

**Ticket verify:** "an Auto Goal continuation budget survives a renderer reload — a goal that already
spent its continuations cannot continue after reload, proven by a test that reloads the supervisor
module against persisted state."

## What the SCOUT found

The defect the audit described (`audit/1.md:81-111`) is **already repaired in the tree**: the durable
half landed in zcode commit `b1493cfd` (T-250's wave), and its comments name T-242 explicitly.

| piece | where | state |
|---|---|---|
| durable budget ledger (intent id → spent continuations) | `packages/ui/src/zaicode/zaicodeGoalSupervisor.ts` `GOAL_BUDGET_STORAGE_KEY = "zaicode-goal-budget-v1"` | present, entry-capped at `MAX_INTENTS` (200) |
| durable spend **before** the send can escape | `recordZaicodeGoalContinuation` writes the ledger first, then updates the table | present |
| the only spend path | `claimZaicodeGoalContinuation` → `recordZaicodeGoalContinuation` (nothing else may send) | present, structurally asserted in the test |
| hydration on re-presentation | `registerZaicodeGoalIntent` without `fresh` reads `spentZaicodeGoalContinuations(intentId)` | present; `observeZaicodeGoalFromBrief` is the non-fresh path |
| new user submission starts a new lifecycle | `ConversationComposer.tsx:1369` passes `fresh: true` → count 0 and its ledger entry cleared | present |
| stop / complete across a reload | the session's own brief (`manuallyStopped`, `goalStatus`) owns it — `observeZaicodeGoalFromBrief` returns `null` for a stopped session | present; no second ledger needed |
| turn-end evidence, in-flight mark | process-local **on purpose** (a reload must not resurrect them) | documented intent |

What was missing was the acceptance itself: **no test read the ledger.**
`zaicodeT234GoalContinuation.test.ts:182` asserts only that the intent and its `sawRunning` evidence
are dropped by a reload — true, but not the budget.

## The repair (test only)

`zcode/packages/ui/test/zaicodeT242GoalBudget.test.ts` — 6 cases, built on the reload pattern
`zaicodeSrc161RetrySafetyReload.test.ts` established: a fake `globalThis.localStorage` plus a
cache-busted dynamic import (`...js?reload=N`) per renderer, so each "reload" really is a fresh module
instance hydrating from the record the previous one left on disk.

1. the spent count is on disk **before** the intent table learns about it, and every claim spends it
   durably (source-order + caller assertions on `recordZaicodeGoalContinuation` / `claim…`);
2. a reloaded renderer resumes at 19, spends the 20th, and is refused at 21 with
   `continuation budget exhausted` — then three more reloads keep the cumulative count at 20;
3. a fresh user submission is a new lifecycle at zero and clears the old ledger entry;
4. the in-flight mark and the turn-end evidence do **not** come back, so a reloaded renderer cannot
   replay the send (`sawRunning` is gone ⇒ the owner gate refuses until a real turn ends);
5. stop / blocked come from the brief, never from a local ledger;
6. an unreadable ledger (`{not json`, `[]`, a non-number count, `null`) degrades to "nothing spent",
   never to a crash and never to "everything spent".

## Red controls (the test discriminates)

Both applied to `packages/ui/src/zaicode/zaicodeGoalSupervisor.ts`, run, then reverted with
`git checkout --`; the file's sha256 is identical before and after
(`b34c05ef2fef9157c99ebcc951f1eabb3cffbb8910055668793b1f6513767a5d`) and `git status` reports it clean.

| control | mutation | result |
|---|---|---|
| C1 | `const continuations = input.fresh ? 0 : spentZaicodeGoalContinuations(intentId)` → `const continuations = 0` (no hydration) | **2 fail** — "reloaded renderer resumes at 19…", "in-flight mark… stays process-local" |
| C2 | delete the `writeZaicodeGoalContinuationLedger(intentId, spent)` line (no durable spend) | **4 fail** — "on disk before the table learns it", "resumes at 19…", "fresh user submission…", "in-flight mark…" |

Untouched by both controls: the stop/blocked and corrupt-ledger cases (they assert unrelated
behaviour) — which is what makes the failures above specific.

## Gates

| gate | result |
|---|---|
| focused suites (`T-242` new, `T-222`, `T-234`, `T-204`) | **39/39 green** (`focused-goal-suites.log`) |
| `pnpm run typecheck` | **PASS, exit 0** (`zcode-typecheck.log`) |
| `pnpm run verify:pre-push` | **PASS, exit 0** — lint 166 warnings / **0 errors**, `architecture:check --changed` clean, **1876 tests, 0 fail, 0 cancelled** across 7 suites; the six new cases run inside the full suite (`zcode-prepush.log`) |
| dist-next rebuild | **not needed**: no production file changed (only a test file) |
| packaged driver re-run | **not needed**, same reason: nothing the driver observes moved |

## Decisions and deviations from the audit's wider REPAIR list

The audit's `REPAIR` section asked for more than the ticket's `verify` line; three of its asks are
deliberately **not** done here, and the reasons are the design, not a shortcut:

1. **"Persist the intent ledger on the host"** — the production code keeps it in renderer
   `localStorage` with an explicit `ponytail:` note naming the ceiling (a second process sharing the
   budget would need it beside the session state on the host) and the upgrade path. The audit's own
   alternative was "host-owned vs persisted settings"; persisted state is the one that keeps one
   decision. It is NOT in the release-snapshot allowlist (`zaicodeSettingsSnapshot`), so a profile
   restore legitimately starts a fresh budget — runtime bookkeeping, not an operator preference.
2. **"Persist pending / failure / terminal in the same ledger"** — pending and terminal state already
   have a durable owner: the session brief, which `observeZaicodeGoalFromBrief` folds in after every
   reload, and which refuses to manufacture an intent for a manually stopped session. Duplicating
   those into a second ledger would create the second state source the ticket forbids.
3. **"Spend a claim durably before the send escapes"** — already how `recordZaicodeGoalContinuation`
   is written; the test pins the order so it cannot drift.

Deliberately out of scope: no second scheduler, no change to the observation/continuation send path,
no new persistence schema, no production change at all in this wave.
