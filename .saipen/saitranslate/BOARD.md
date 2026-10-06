# Board

<!-- Historical, resolved, kept for the record. A DONE producer board may hold
     no open BLOCKED entry, so the 25.09-27.09 blocker lives here instead:
     SAIT-001 was blocked on content volume, resolved by E-1877 as a resumable
     producer workload. The nested-source freshness binding was fixed first --
     zcode/ is its own Git repository and the outer repo gitignores it, so a
     product edit left the outer identity byte-identical and every freshness
     decision here was blind to the ~70k files under zcode/; fixed in the
     SAIPEN engine (3088efff, published) and wired by
     .saipen/source-nested-repos.json, so a zcode edit now moves the outer
     identity and restoring returns it. The volume measurement that followed
     was the real residual: the product shipped 2 locales at 5838 keys each, so
     32-language coverage meant 31 locales x 5838 translations. The operator
     deferred that to the SAIFREN pool on 27.09.26 and SAIT-001 then completed
     it. -->

## DOING

## TODO

## DONE

- [x] SAIT-002 refresh the README source-digest markers for the 29 producer-owned locales and README.ja.md | owner: saitranslate | closed: 2026-10-06 | verified: kitchen/_verify_restamp.py --project-root . exits 0 (30 staged restamps, every staged marker satisfies freshness.digest_marker_matches against the 783b916d4bee01ac the validator's own read path yields, every differing byte inside the marker digest) and --red-control catches all 4 mutations; saipen outbox check saitranslate exits 0 on the ready package sha256:305d7e05b6ee69cfabe9bb8f0ab9d7b87c916e68b31da63f32d473e30f6c3464 bound to 4e2135523fda59b7f055667dd0fbd4a6fd039f3c / git-delta-v1:f413c6fb489b6f016ce446022a0bfa2c943c1b7bc4bf46389c991f2ee078f8d9 / role sha256:7d18729f8d94eb58471ae3bb5fad9151e8499fea291e574b26439c5c89012e41; the 5 Core-owned stale surfaces are reported, not written; nothing integrated, committed or pushed
- [x] SAIT-001 complete 32-language plus Дед translation coverage | owner: core | started: 2026-09-29 | closed: 2026-10-06 | verified complete and current in the product, not merely produced: zcode HEAD 1cbb0921, test/zaicodeLocaleParity.test.ts 5/5 PASS, 33 locales x 5884 UI keys with matching tokens, 199 CLI strings (33/33 catalogs carry the current locale list), 50 native-menu + 30 auxiliary strings; docs/locales carries 32 locale sets and the three root mirrors; payload integrated into the product at zcode e9091481

## BLOCKED
