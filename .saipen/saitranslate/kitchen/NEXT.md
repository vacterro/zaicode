# T-113 handoff for the next agent (2026-09-30)

State: ru-RU DONE in the kitchen. 5845/5845 keys in `drafts/ru-RU.json`, audit 0 stale copies
(`node runner.mjs audit ru-RU`). Kept-as-is brand/code keys in `drafts/ru-RU.kept.json`.
Not yet collected into the product: no `OUTBOX.md`, no `saipen collect saitranslate`.

## Resume (from this folder)

    cd V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE\.saipen\saitranslate\kitchen
    node tools.mjs next et-EE 200     # issue batch b0001 for the next locale
    # write outbox/<locale>.bNNNN.txt, lines:  N|"translation"   N|=  (keep as is)   N|""  (empty source)
    node tools.mjs done <locale>.bNNNN outbox/<locale>.bNNNN.txt
    node tools.mjs view <locale>.bNNNN  # re-read source lines of an issued batch

Order: et-EE, uk-UA, ja-JP, ded (default six with ru-RU), then the rest as honest partial coverage.
Rate ~4.5 keys/s accepted, 200 keys per batch, 5845 keys per locale (about 30 batches).

## Rules the runner enforces

- Placeholders `{x}` `{{x}}` `${x}` must match the source exactly.
- Unchanged English copy with words in it is REJECTED. Brands/codes/units: write `N|=`.
- Empty source value: translation must be `""`.
- Use the Write tool for outbox files, never shell heredocs (Bash tool eats backslashes; `\n` and `\\` must survive).

## Terms already fixed in ru-RU (keep consistent in other locales' glossary)

Skills=навыки, plugin=плагин, hook=хук, marketplace=маркетплейс, workflow=рабочий процесс,
workspace=рабочее пространство, session=сессия, fork=ответвить, Coding Plan / Start Plan / Lite / Pro / Max /
Computer Use / SAIRoute / SAIFREN / SAIOPP / 9router kept in Latin.

## Finish line for T-113

1. All default locales at 5845 keys, `node runner.mjs audit <locale>` clean.
2. Write `OUTBOX.md` here: status `draft` or `blocked`, with per-locale coverage gaps stated honestly.
3. Product integration only via `saipen collect saitranslate` with a ready handoff; then
   `zaicodeLocaleParity.test.ts` in zcode, then T-113 verify / review / ship.

Other open tickets: T-94 (ProTrail multi-monitor acceptance) and T-9 (interactive desktop E2E) are OPERATOR_REQUIRED, parked.
Latest staged bundle: zcode 73f0ccb in `dist-next`, boot gate passed. All T-125..T-132 closed.
