# T-254: bounded home queue overview

SAIHOME refreshed the entire queue history to derive live/today and rolling-24h
counts. T-248 had bounded only the workspace poll. Merely limiting the home
array would lose old active jobs and undercount outcomes.

The existing repository now produces a consistent read snapshot: all open
rows from the existing partial index; newest 20 global rows (1..200 caller
window) from a new ordering index; exact native outcome aggregates from a new
status/finish index. Only selected rows are decoded. Diagnostics preserve
malformed selected metadata; durable status/time facts still count. An
additive migration 0009 leaves released checksums and user rows intact.
The typed service owns current time and validates local midnight. Home and
the remote unavailable adapter use the new contract. Midnight follows the
existing refresh effect/timer, without an immediate failure retry loop.
NOW takes today's completion/failure facts from this snapshot, independent
of statistics ingestion backlog. Finite native bounds exclude SQLite text,
blob and infinite finish corruption from outcome counts.

## Required regression comparison

Before fixing the repository, extracted the old full-list algorithm behind
the same API (`pre-fix/zaicodeJobRepo.ts`). Baseline migration registry is also
preserved. This avoids a missing-method control. The final test and command
are identical in both runs; restored source bytes are SHA256-checked.

`red-control.mjs` / `regression.json`: unfixed subject 7 assertion failures,
3 passes, exit 1; fixed subject 10 passes, exit 0. Checks cover exact boundaries,
all workspaces, oldest open survival, deterministic ties, actual row reads
and query plans, diagnostics, concurrent-writer snapshot consistency,
transaction recovery, service argument bounds/time/shutdown, empty state and
v8 upgrade/reopen idempotence and damaged finish-time storage classes. Final
required pair was recorded within the current VERIFY cycle (E-4162/E-4163).

Verifier: `e5f6570b097a5ff6686c27dd964a41712386365508cc3234be6d821bd9a83fd8`.
Unfixed subject: `a030487daa485e861ff5039b226f12475e4df439f03902b591758a6650efce22`.
Fixed subject: `90b5aa469090765300deff77b72d076511995b95ad4b2a29db7dd5a364e5cffc`.

## Scale evidence

`scale-probe.mts`, `scale-probe.json`, `scale-probe.log`: real isolated SQLite
with 100k/500k old terminal rows, six old open jobs and 15 outcomes today whose
creation lies outside the recent window. Exact counts are 1 running, 2 ready,
2 waiting, 1 blocked, 12 done today and 3 failed today; rolling completion 12.
Every probe physically reads 26 job rows, retains all open identities, keeps
arbitrary old history addressable and uses all three intended indexes with
no temporary sort. Historical JSON is never decoded by the overview.

| Old terminal rows | Full row decode | Overview read/decode | Overview rows | New index build |
|---|---:|---:|---:|---:|
| 100,000 | 1030.54 ms | 1.13 ms | 26 | see JSON |
| 500,000 | 7370.14 ms | 1.44 ms | 26 | see JSON |

Table is the independent REVIEW rerun while the packaged probe also ran.
Earlier isolated final-subject results were 795.58/4244.42 ms full decode and
0.83/0.62 ms overview; both runs prove the same bounds and exact facts.

Timings describe this local run; bounded row reads and query plans are the
non-flaky correctness/performance gates. There is no claim that all Home
statistics or rendering work is constant in its own history.

## Repository gates

Pinned pnpm 10.33.2; installed Node v24.15.0. Typecheck exits 0. Full
verify:pre-push exits 0: lint has 0 errors/166 pre-existing warnings,
architecture 0 violations, 1950 collected tests (1948 pass, 2 existing skips,
0 fail). Suite totals: 118/1332/175/260/45/9/11.

Initial seam typecheck exposed the required remote unavailable adapter.
Whole-file formatting inflated two historically compact UI files beyond
max-lines; their existing format was restored. Both issues were fixed before
VERIFY admission. No lint limit or implementation guard was weakened.

## Packaged acceptance and publication

Current build is staged in `packages/desktop/dist-t254`, outside the operator
launcher's live/staged directories. Fresh final boot smoke passes (shell,
28 Settings sections, ProTrail/customization, zero renderer/console errors).
`bundle-final.log` and `boot-final-receipt.json` identify it. Frozen scoped
driver/seed SHA256 are `838dcf0e3517055910bd08fc86847036b8719876141bb0cc9fb69f57deb7c4dc`
and `99783cbc0e9179eb935388055fe76be140e125861b9878f4450bc2ba0f9dedba`.
Final asar SHA256: `8e9700525fec603393c8ae3070e94db0b5558b05d63cc26dcd27c54db4024091`.

VERIFY `packaged-final/receipt.json`: 12/12, 60.105 seconds, five actual
overview RPCs (16.2–27.7 ms), 26 rows/7685-byte responses and exact facts on
every response, zero full-history job-list calls, one usable manual refresh,
NOW/fleet projections visible and zero renderer/observer/RPC exceptions.
309 actual React root commits occurred while Home was mounted; this is root
commit instrumentation, not attribution of every commit to a Home component.

Independent REVIEW repeats native focused tests (10/10), both real scale
fixtures (`review-scale.log`) and the identical packaged oracle on unchanged
asar (`packaged-review/receipt.json`): 12/12, 60.140 seconds, five overview
RPCs, 311 root commits, no exceptions. No P0/P1 finding in the owned diff.
The probe uses a new throw-away profile with 500,021
fixture jobs, disables automatic dispatch/window starters, and sends no model
request. Real workers, paid vendor execution and unrelated manual acceptance
are not represented by fixture status rows.

The first driver run could not click Refresh because legitimate startup
notifications covered it; the driver uses normal Dismiss/Dismiss all controls.
One launch closed before observer admission; attaching before page readiness
recovered, without attributing an unknown startup cause to the product.
An early whole-home `/12 done/` assertion matched the Agents summary, so its
TODAY verdict is invalid and superseded. The frozen scoped NOW oracle genuinely
fails the original package (`packaged-scoped-red/receipt.json`,
`HOME_TODAY_MISMATCH`). Original asar
`c5902f3997d56ce055d533cdd7fb536cddee8e1cba30cd35256e55784c360ece` is
preserved in `pre-ui-fix.app.asar`. `timestamp-red.log` independently finds the
intermediate native finish bug (5 counted vs 1). Both were corrected before
the fresh final build; no failed/superseded GUI run authorizes acceptance.

The same large fixture also proves a separate pre-existing queue-statistics
pagination starvation: 500k equal-time old outcomes keep ingesting the same
5000 ids. T-256 owns its repair; `../T-256-stats-pagination/baseline-probe.json`
proves four forced ingests stay at 5000 events and never reach a new outcome.
T-255 owns the independently proven non-atomic clear/stale-batch barrier.

Published separate product commit `1f848e84964b69d94e3d8815a081f4f0329160cc`
fast-forward to `origin/zaicode`; fresh remote branch readback matches exactly.
Twelve reviewed paths only. Pre-ship index tree was
`1517316af5b5d4bf15f576bdd55760ff882d3a1b`. Foreign `.saipen-red/` scratch and
concurrent `zaicodeSettingsDefaults.json` edits are preserved/excluded.
