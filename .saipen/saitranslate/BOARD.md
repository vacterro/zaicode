# Board

## DOING

## TODO

## DONE

## DOING
- [ ] SAIT-001 Complete 32-language plus Дед translation coverage | owner: core | started: 2026-09-29 | progress: ru-RU 120/5845 keys accepted (b0001-b0003), runner kitchen/runner.mjs, digest sha256:72cc16a5, rate 1.169 keys/s

## BLOCKED
- [ ] (historical) SAIT-001 was blocked 25.09-27.09 on volume measurement, resolved by E-1877: resumable producer workload. Original text: PARTIALLY RESOLVED 27.09.26 (T-47). Nested-source freshness binding FIXED: zcode/ is its own Git repository and the outer repo gitignores it, so a product edit left the outer identity byte-identical and every freshness decision here was blind to the ~70k files under zcode/. Fixed in the SAIPEN engine (3088efff, published) and wired by .saipen/source-nested-repos.json; a zcode edit now moves the outer identity and restoring returns it. REMAINING, measured not asserted: the product ships 2 locales (en-US, zh-CN) at 5838 keys each, 1 missing, so 32-language coverage is 31 locales x 5838 = 180978 translations. The user deferred this to the end and assigned it to the SAIFREN pool (T-49). Blocked on content volume, not on tooling | blocker_scope: ticket
