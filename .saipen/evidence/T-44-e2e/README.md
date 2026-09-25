# T-44 evidence -- full-system headless E2E (SRC-033 analysis 1)

Script: `zcode/packages/ui/test/e2e/zaicodeSystem.e2e.ts` (helpers: `zaicodeSystemKit.ts`)
Run (from `zcode/packages/ui`): `node --import tsx test/e2e/zaicodeSystem.e2e.ts [--out DIR] [--keep]`

Real owners, no mocks: a fresh Git project with SAIPEN memory bootstrapped from
the home's templates, the SAIPEN launcher, two real SAIMAIL workspaces
(`saimail-local`), worker processes that run the same SAIPEN operations an
agent seat runs, and the live 9router. Each step asserts what ZAICODE's own
read paths answer (desktop main `getZaicodeSaipenProjection`, renderer
`assembleZaicodeProjectRuntime` + `zaicodeProjectRuntimeState`, SAIMAIL
`parseSaimailIndex` + `buildSaimailSnapshot`, `callZaicodeRouter`, CLI
`saipenGoalVerdict`).

## Result 2026-09-25: 10/10 PASS, ~23 s of step time (`report.json`, `report.md`)

| Step | Asserted |
|---|---|
| cold-start | template bootstrap + ticket T-1; `saipen validate` VALID |
| project-detected | projection `source: saipen`, top workable T-1; verdict `pending` |
| engines | persisted engine cache: 7 accounts, 2 usable, 5 blocked, sweep 67 s old |
| start-goal | `/goal cc all` verdict not passed, next action names T-1 |
| work-claimed | worker gen 1 claims, BUILD; projection cache invalidated; verdict `working`; LOG grew |
| saimail-telegram | helper seat -> main seat; ZAICODE reader: 1 unread, from e2e-helper, on current Work; SAIPEN telegrams block agrees (unread 1) |
| worker-kill-recovery | gen 1 SIGKILLed mid-BUILD; verdict drops to `pending`; validate VALID; gen 2 routed `PHASE BUILD T-1`, finishes build, VERIFY |
| router-outage | dead URL surfaces in 14 ms ("not reachable"); live 9router 200 afterwards |
| restart | a new process reads identical projection + verdict |
| verify-done | VERIFY -> REVIEW -> SHIP -> done; verdict `done`; goal verdict passed; validate VALID |

Red control: `SAIPEN_HOME=C:/nonexistent` -> cold-start FAIL, cascade FAILs, exit 1.

## Findings recorded (not defects of this ticket)

- SAIPEN's `automation.closure_complete` stays `false` after the only ticket
  is done; ZAICODE's verdict therefore decides `done` from "no claimed and no
  top workable ticket", which the read model already does.
- ZAICODE's projection spawn does not pass the operator's SAIMAIL mailbox as
  `SAIMAIL_WORKSPACE`, so the projection's telegram count is null in the app;
  the SAIMAIL surface reads the mailbox itself (its owner), so nothing is lost.

## GUI-only steps (operator, T-9)

Listed in `report.md`: open the project (tint/chip pending), START
(`/goal cc all`), live NEXT/THEN lines, SAIMAIL ring, app restart mid-run.
