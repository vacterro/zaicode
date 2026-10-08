# T-166 — inspection of the 20261005 live receipt

**Verdict: the acceptance is NOT proven. T-166 stays open.** The receipt exists, as the
blocker said to wait for, so it was inspected as instructed. It does not pass.

## What the receipt actually says

`.saipen/evidence/T-166-live/20261005/receipt.json`, schema `zaicode-t166-live/2`:

| Field | Value |
|---|---|
| `at` (run finished) | `2026-10-05T02:41:54.577Z` |
| `rollAt` (the real vendor roll it was armed for) | `2026-10-05T03:01:07.000Z` |
| `ok` | **`false`** |
| `checks.isolatedPackagedShell` | `true` |
| `checks.liveVendorQuota` | `true` |
| `checks.noStartBeforeRoll` | `true` |
| `failures` | `["harness: page.evaluate: Target page, context or browser has been closed"]` |
| `observations` | 44, **none carrying an `error`** |
| `targetKey` | `five_hour@gemini_models` |

## Why `ok` is false, and why it matters

The Playwright page/context died mid-run (`Target page, context or browser has been closed`).
The run ended at **02:41:54Z**, roughly **19 minutes before the 03:01:07Z roll** the whole
acceptance was waiting on. The decisive event — the vendor window actually rolling over — was
never observed inside the run. The acceptance deadline was 03:41:07Z; it passed at 06:32Z.

So the three named checks that did get to evaluate are `true`, but they are not the claim.
The claim is *"for a supported auto-rolled plan, SAIHOME and the topbar clock show the same
live countdown, the anchor survives a sweep and a restart, and the window never sits on
'starts at first use' after a supported plan has been rolled"*. That needs the post-roll
state, and the run never reached it.

The `ok: false` is therefore a **harness** failure, not evidence that the product is wrong.
The two must not be conflated in either direction.

## What the observations do show (real vendor data, 0 errors)

The 44 observations are genuine live reads (`source: "agy -p /usage"`), none errored, and the
target window drains monotonically and is rendered consistently across every surface:

- `five_hour@gemini_models`: 52.84% → 43.55% over the run (real consumption)
- `startsOnUse: false` throughout, `rollingFrom: null`, `windowStarts: null`
- the same percentages appear in the tile, the topbar countdown, and the home AI LIMITS
  surface at each sample

That supports `liveVendorQuota` and the no-start-before-roll check. It does **not** support
the roll, the restart, or the post-roll anchor.

## Why T-166 was not closed and not re-run

- The preserved runner (bash PID 18220) was armed for launch 02:25:00Z against a 03:41:07Z
  deadline. That deadline is 2h51m in the past. The armed run is spent.
- Re-running is not free to decide unilaterally: it drives a **signed-in live vendor
  account** and the standing constraint on this ticket is *"do not duplicate runner, spend
  extra paid requests or fabricate an earlier reset."* Spending another vendor acceptance
  window is the operator's call.
- Nothing here may be reinterpreted as a pass. `ok` is `false` and the roll was not observed.

## What a correct re-arm would need

1. The harness teardown fixed first, so the page cannot die mid-run — otherwise a second
   run spends another acceptance window and fails the same way.
2. Re-armed against the *next* real roll, with the deadline computed from that roll rather
   than reused from 20261005.
3. The roll window has since passed, so the next run measures a **different** thing: whether
   the app shows a live, anchored countdown for an *already-rolled* window (the end state the
   acceptance wants), instead of watching the transition happen. That is a valid and cheaper
   test, but it is a different claim and should be accepted as such rather than silently
   substituted for the armed one.

## Downstream effect

T-188's verify clause requires the frozen live packaged acceptance to fail on `0cda0488` and
pass on the fix. That gate cannot be satisfied from this receipt.
