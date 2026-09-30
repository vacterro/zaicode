# T-113 handoff (2026-09-30 ~14:10 UTC)

Source: 5845 keys, digest f7d744b9 (en-US changed 2 TaskOutput labels in T-136: re-translate
`chat.toolCall.taskOutput.fetching` / `.timeout` in ru-RU -- delete them from drafts/ru-RU.json, re-issue).

Core (hand-written, `node tools.mjs next <locale> 200` -> write outbox/<id>.txt -> `node tools.mjs done <id> <file>`,
always under the kitchen lock `mkdir .lock` / `rmdir .lock`):
- ru-RU 5845/5845 (2 stale keys above)
- et-EE 5200/5845 -- batch et-EE.b0035 issued (outbox/et-EE.b0035.json), not answered; next is b0035's keys
- ded 0/5845 -- Core-owned Дед voice (STYLE.md: terse, blunt, factually exact, never generic Russian)

Producer (model-driven, free SAIFREN pool via the live 9router, one worker per locale):
`node produce.mjs <locale> --size 120` (targeted retries: only refused lines are asked again; log produce.log).
Running at handoff: uk-UA ja-JP de-DE fr-FR es-ES it-IT pt-BR pl-PL nl-NL sv-SE da-DK fi-FI (15-36 %).
Not started: nb-NO ko-KR th-TH vi-VN ar-SA he-IL tr-TR hi-IN id-ID el-GR cs-CZ ro-RO hu-HU bg-BG sk-SK hr-HR
(zh-CN exists upstream in the product). A stopped worker is resumed by the same command.

Measured accepted throughput: Core ~5.7 keys/s per batch loop; producer 0.7-2.3 keys/s per worker,
~12 keys/s across 12 workers.

Finish line: every locale 5845 + `node runner.mjs audit <locale>` clean -> OUTBOX.md (strict fields, see
validate warning) -> `saipen collect saitranslate` -> product locale files + IntlProvider/LocaleSwitcher/Locale type
(ded needs its own handling in zaicodeLocaleParity.test.ts) -> VERIFY/REVIEW/SHIP.
