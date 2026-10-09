# Board- [x] T-266 [P2] limit meter shows stale/old data when quota window ends; refresh on reset. | verify: the requested change is present and demonstrated against the user own description of it | request_witness: model_supplied | source_receipts: SRC-170 | owner: saipen-cli | claim_time: 2026-10-09T09:53:24Z | closure_mode: own_patch | closure_paths: zcode/packages/ui/src/zaicode/zaicodeEngines.ts, zcode/packages/ui/src/zaicode/ZaicodeEngineBar.tsx, zcode/packages/ui/test/zaicodeT266ResetRefresh.test.ts


<!-- Ticket shape is RFC § 1.2's, exactly: a checkbox, the T-### id, a
     description, then only the fields that apply, space-pipe separated.
     Shown here WITHOUT its leading "- " on purpose (see below):

       [ ] T-001 short description | verify: pytest -q

     Other legal fields (RFC § 1.2): the dependency one, taking a
     comma-separated list of T-### this ticket waits on; owner and
     claim_time for claims (§ 1.4); blocker for facts + dead ends; verify as
     shown above. Named rather than shown here on purpose -- see below.

     A real line starts with "- ". Checkbox: [ ] open, [/] in progress
     (## DOING), [x] done (## DONE). A status change MOVES the line between
     sections -- cut and paste, never copy, or the same id ends up under two
     headings. All four headings below are required, even while empty.

     Why the example is de-fanged: neither validator skips HTML comments, so
     anything ticket-shaped in here is read as a real ticket on a brand-new,
     untouched board. Two separate traps, both hit for real while writing
     this very file: a full checkbox line parses as a live ticket, and the
     dependency field followed by an id is flagged as a dangling reference
     even without a leading dash -- tests/validate.sh scans for that field
     across the whole file, not only ticket lines, making it stricter here
     than tools/validate.py. So: no leading dash on any example, and never
     write that field name next to a concrete id anywhere in this file. -->

## DOING

## TODO
- [ ] T-265 [P1] SAIHOME hotkeys and display repairs plus single-owner composer SAIPEN board toggle (SRC-169:R008..R011). | regression: required | verify: Ctrl+N creates a new task from SAIHOME; Recent ago remains on one line; limit-meter borders do not overlap; composer board button controls the existing second sidebar with no duplicate overlay. Frozen original-subject controls, actual 640/desktop UI and repository gates. | source_receipts: SRC-169
- [ ] T-261 [P2] • Нужно доработать 9router обнаружатор и мейнтенер который автоматом проверяет не только на новые модели и добавляет их но и удаляет мёртвые, добавить кнопку... | verify: the requested change is present and demonstrated against the user own description of it | request_witness: model_supplied | source_receipts: SRC-169
- [ ] T-260 [P2] Хорошо. В таком случае двигайся до конца до лимитов тогда. | verify: the requested change is present and demonstrated against the user own description of it | request_witness: model_supplied | source_receipts: SRC-168

