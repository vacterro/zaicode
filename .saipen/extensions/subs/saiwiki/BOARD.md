# Board

<!-- Same checkbox ticket shape as Core (RFC § 1.2), never the OUTBOX.md
     bold-field shape (PROTOCOL.md § 2) -- that shape is for the deliverable
     leaving via OUTBOX, not for this board. Example, shown without its
     leading "- " so nothing parses it as a live ticket (a validator reading
     this file does NOT skip HTML comments):

       [ ] HUNT-001 short description | critical: true

     Real lines start with "- ", and use your own ID prefix (PROTOCOL.md
     § 3), never Core's T-###. -->

<!-- BOUNDARY: this is YOUR board. The main project has its own BOARD.md
     elsewhere -- never touch it directly, never write a ticket there
     yourself. Findings leave through kitchen/OUTBOX.md only; the main
     agent folds them into its own BOARD.md when it runs `saipen sub
     collect`, never the other way around. -->

## DOING

## TODO

## DONE

- [x] W-003 force-refresh the ZAICODE wiki page set to current source: re-bind all 12 pages + navigation from 4e213552/f413c6fb to HEAD a3085931/cc0018b0, fold in the 0.0.3 install/changelog/README drift (Home, Getting-Started, Changelog rebuilt), 7 unchanged pages re-bound | verify: kitchen/_verify_pages.py exits 0 on the 12-file payload and exits 1 naming 4 violations on a mutated copy; saipen outbox check saiwiki exits 0; nothing integrated, committed or pushed
- [x] W-002 initial ZAICODE wiki page set: 10 pages mirroring the project's own canonical documents (README, docs/, UI.md, CHANGELOG) with _Sidebar/_Footer navigation, bound to 4e213552/f413c6fb and the current role revision | verify: kitchen/_verify_pages.py exits 0 on the 12-file payload and exits 1 naming 4 violations on a mutated copy; saipen outbox check saiwiki exits 0; nothing integrated, committed or pushed

## BLOCKED
