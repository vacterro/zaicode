# T-43 evidence -- SRC-033 analysis 4: fault-injection matrix

Verify: a fault matrix runner executes each automatable scenario with a
recorded verdict; non-automatable ones listed with manual steps.

Runner: `zcode/packages/ui/test/e2e/zaicodeFaults.e2e.ts` (+ `zaicodeFaultKit.ts`).
Full run 2026-09-25 with the 30 s router outage: `T-43-faults/faults.md`,
`T-43-faults/faults.json` -- 12/12 PASS, exit 0. Manual scenarios with steps and
expected results are in the same report.

| SRC-033 scenario | Matrix row | Verdict / key fact |
|---|---|---|
| kill ZAICODE renderer | manual `renderer-kill` | steps + expected |
| kill whole ZAICODE | manual `app-kill`; automated part `crash-plans` | PASS: resume old:goal, new:text; relaunch cap 16 |
| kill worker during write | `worker-kill-mid-write` | PASS: gen2 routed PHASE BUILD T-1, phase VERIFY |
| kill worker during SAIMAIL delivery | manual `saimail-kill-delivery`; reader side `saimail-malformed-tail` | PASS: 3 whole rows of a torn index |
| router gone 30 s / back | `router-outage` (30 000 ms) | PASS: 6 failed calls, slowest 2 ms, then 200 |
| router process dies | `router-crash-restart` | PASS: back in 1110 ms, restarts 1, clean stop stays down |
| quota hits zero / resets | `quota-zero-reset` | PASS: blocked -> available after reset; weekly gate |
| Windows sleep / resume | manual `sleep-resume` | steps + expected |
| network disappears | manual `network-loss` | steps + expected |
| malformed SAIMAIL index tail | `saimail-malformed-tail` | PASS |
| stale SAIPEN snapshot | `stale-snapshot` | PASS after fix: file fallback "pending", recovered in 6.8 s |
| foreign ownership | `foreign-ownership` | PASS: REFUSE [TICKET_NOT_WORKABLE] |
| worker terminal detach / reattach | manual `worker-detach` | steps + expected |
| project renamed / relocated | `project-relocate` | PASS: moved path same Work; old path ENOENT |
| project switch mid-run | `project-switch` | PASS: answers kept apart |
| 12 workers finish at once | `twelve-finish-at-once` | PASS: 12 results, one each, none crossed |
| restart with detached workers | `crash-plans` (relaunch list) + manual `app-kill` | PASS |

Defect found by the matrix and fixed: a failed SAIPEN projection was cached
until STATE / BOARD / LOG changed (run 2: `stale-snapshot` FAIL "projection
back: not within 12000 ms", and `project-switch` FAIL from the same cached
null). Fix: retry a failure after 5 s. Regression test
`desktop/test/zaicodeSaipenProjection.test.ts`; red control (old condition) ->
"after the retry window SAIPEN is asked again" fails; restored -> pass.

Harness fix: the E2E kit accepted only a flat SAIPEN home; the launcher's
SAIPEN_HOME is a source checkout (`<home>/saipen/BOOT.md`). `saipenProtocolDir`
follows BOOT.md's two layouts (KNOWLEDGE traps.md).

Gates (2026-09-25): system E2E (refactored kit) 10/10 PASS; desktop `zaicode*`
44/44; UI `zaicode*` 210/210; `pnpm typecheck` 0; UI `tsc --noEmit` 0;
`pnpm lint` 0 errors; `pnpm architecture:check --changed` OK.
