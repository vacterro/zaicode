# T-52 evidence -- SRC-038 statistics

Operator's words (SRC-038 lines 32, 34): streak squares like Claude Code
desktop, collected locally; detailed statistics, tokens spent yesterday, today,
week, month and so on "here" (screenshot clipboard_20260925_051301: an arrow at
the top left of the home screen). SRC-041 later moved home to SAIHOME and asked
to "preserve the original statistics requirements inside it".

| Requirement | Where |
|---|---|
| Local stats store | T-56: migration `0006_zaicode_stats`, `services` stats ingestion (agent usage store, queue runs, worker sessions) -- evidence T-56-saihome.md |
| Totals today / yesterday / week / month / all | T-56 Tokens & work card; T-52: `ZaicodeHomeTokenRibbon` in the SAIHOME title row, top left, every preset |
| Streak squares | T-56 Activity card (five measures, keyboard-walkable, current / longest streak) |
| More measures | T-56 Numbers card (ratios, busiest day, peak hour, favourite model) |
| Unit tests for aggregation | T-56 `services/test/zaicodeStats.test.ts` (6: periods in Europe/Tallinn, DST end, dedupe, late rows, clear floor, empty profile) |

Gates (2026-09-25): UI `zaicode*` 210/210 (new `zaicodeWave52.test.ts` 3:
ribbon order and exact tooltip, stale mark and empty state, pref default);
services `zaicode*` 30/30; `tsc --noEmit -p packages/ui/tsconfig.json` 0;
`pnpm lint` 0 errors (72 baseline warnings). Red control: default
`tokenRibbon: false` -> the default test fails 1/3; restored -> 3/3.

MANUAL-VERIFY: after the next ZAICODE start, SAIHOME's title row reads
"SAIHOME  TODAY … YDAY … WEEK … MONTH … ALL …"; Layout & home -> STATISTICS ->
untick "Token totals in the SAIHOME title row" brings back "what is happening".
