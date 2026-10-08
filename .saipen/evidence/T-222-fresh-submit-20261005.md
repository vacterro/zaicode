# T-222 fresh-submit wiring (stop-then-resubmit) — 2026-10-05

## Problem
`registerZaicodeGoalIntent` learned a `fresh?: boolean` flag (fresh composer
submit after an explicit stop replaces the stopped lifecycle under the same
deterministic id; re-presentations never resurrect), but the composer call
site still called it without `fresh: true` — so a stop-then-resubmit stayed
STOPPED and the operator's new prompt never resumed. The focused stop test
did not cover the fresh path either.

## Change (zcode dirty tree, 3 files)
- `zcode/packages/ui/src/v4/ConversationComposer.tsx`: submit path passes
  `fresh: true` — only a real user submission resets a stopped lifecycle.
  The observation feed (`observeZaicodeGoalFromBrief`) passes no flag, so it
  still never resurrects a stopped goal.
- `zcode/packages/ui/test/zaicodeT222GoalSupervisor.test.ts`: stop test now
  proves all three legs — plain re-presentation stays stopped, `fresh: true`
  resubmit creates a live intent (`created: true`, `outcome: active`,
  `stopped: false`, may-continue sends), and the feed after a re-stop stays
  stopped. Composer assertion requires `fresh: true` at the submit call.
  New test: provider retry, router fallback and compaction re-present one
  intent (no fork, no continuation spent, still live).
- `zcode/packages/ui/test/zaicodeT204AutoGoal.test.ts`: two stale
  source-shape assertions updated to the T-222 shapes they were red on —
  `goalText` split (`const goalText = withZaicodeAutoGoal(...)` then
  `serializeComposerPromptContexts(goalText, {`) and the button's
  `sessionId={sessionId}` prop. Behaviour asserted is unchanged: the goal
  rides the outgoing text (never editor/history) and the switch stays
  project-keyed.

## Gates (measured this turn, exit codes preserved via log files)
- focused T222: 17/17 (`/tmp/t222-test2.log`, exit 0)
- T204+T222: 21/21 (`/tmp/t204-t222.log`, exit 0)
- full ui suite: 1149/1149 (`/tmp/t222-uifull2.log`, exit 0) — an earlier
  full run caught the 2 stale T204 assertions (red), fixed, re-run green
- `pnpm run typecheck`: exit 0 (`/tmp/t222-typecheck.log`)
- `pnpm run lint`: 165 warnings / 0 errors = baseline (`/tmp/t222-lint2.log`)
- `pnpm run architecture:check`: OK, 0 violations (`/tmp/t222-arch.log`)

## T-222 verify-clause coverage (all in zaicodeT222GoalSupervisor.test.ts)
one prompt → one intent; duplicate submit; provider retry; router fallback;
compaction; restart re-derivation; explicit stop; stop + fresh resubmit;
real blocker; terminal completion; second prompt (different objective,
serial); mid-run detach + re-enable. No timers/scheduler (source-grepped).
