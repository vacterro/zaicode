# OUTBOX

## SAIT-001: locale production in progress (resumable)
- **status:** ready-partial
- **summary:** Deterministic batch runner live at kitchen/runner.mjs; Core-owned ru-RU production started, 120/5845 keys accepted across batches b0001-b0003 at 1.169 keys/s measured. Drafts only in this kitchen; nothing integrated into the product tree yet.
- **producer:** core (RU/EE/DED) + saitranslate (29 producer locales, UK/JA next by default-set priority)
- **source_head:** 6fa47dbaca8f66e13c146bdb19e4486c0cd80768
- **source_digest:** sha256:72cc16a5bd030ed6f422eb780ef5be0eba86bb3ace3a1fc1fab5c87b6372025e
- **source_keys:** 5845 (packages/ui/src/i18n/locales/en-US.ts, single- and double-quoted plus next-line values)
- **rule:** a locale lands in the product tree only as a complete catalog passing packages/ui/test/zaicodeLocaleParity.test.ts (key parity, placeholder parity, Locale type, switcher); partials stay drafts here
- **next:** node kitchen/runner.mjs batch ru-RU 40 -> translate -> accept; repeat to 5845, then et-EE, then ded; producer batches for uk-UA/ja-JP follow the same runner
- **verified:** BLOCKED -- coverage is honest partial: ru-RU 120/5845; no completeness claim is made
