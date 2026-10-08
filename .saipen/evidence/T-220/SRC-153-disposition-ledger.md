# SRC-153 disposition ledger (fresh bundle 2026-10-05 19:47, FastPrompter)

Receipt: SRC-153 (allocated by SAIPEN, linked T-220, kind external_audit).
Bundle sha256: a5b8a91db3197f1890cf9e7f708bf66b38024d54cfd102397d522dd3c3a03e5a.
Body sha256 (md): 9db59bcdc1d4bf93922af8194364434871a1d08970e4a896d227aeb5358f3daa.
17 clauses, order + bytes identical to canonical md. 15/15 media hash-verified.
manifest.json + silo.index.json preserved under fresh-bundle-20261005-1946/.
Producer: FastPrompter. Manifest build.source_revision 4d6a59d0 is the PRODUCER
revision, NOT ZAICODE runtime identity (recorded, never used as runtime proof).
Snapshot _ZAICODE_05.10.26-T19-53-41.zip was not found; the live checkout stands
in as the source tree per standing operator selection (cf. ledger E-3772).

| Fresh REQ | SRC-153 RID | Disposition | Note |
|---|---|---|---|
| REQ-001 auto retry unpredictable | R001 | REGRESSION, BUILT | Effective-scope contract implemented 2026-10-05 (see fresh-req001-phaseA-20261005.md). Machine gates green; packaged toggle acceptance MANUAL_PENDING. Old T-201/T-217 do not close it. |
| REQ-002 auto goal smarter | R002 | SEMANTIC_EXPANSION of T-204 | Supervision contract, not one-shot augmentation. Follow-on scope, not built here. |
| REQ-003 goal cc all to completion | R003 | SEMANTIC_EXPANSION of T-204 | Same as R002, one intent. Follow-on scope. |
| REQ-004 ProTrail Save all + motion wake OFF | R004 | NEW | Follow-on scope. Save-all exists; coverage + factory-default precedence unbuilt. |
| REQ-005 reconnecting indicator | R005 | NEW | Attached to T-220 while open (connection truth). Not built here. |
| REQ-006 fallback | R006 | DUPLICATE of SRC-151:R001 | Byte-identical screenshot (245012af). Engine disp DUPLICATE set. |
| REQ-007 composer fit | R007 | DUPLICATE of SRC-151:R002 | Byte-identical (916a165b). |
| REQ-008 ProTrail z-order | R008 | DUPLICATE of SRC-151:R003 | Same clause, no media. |
| REQ-009 maximize | R009 | DUPLICATE of SRC-151:R004 | Same three screenshots. |
| REQ-010 stale working | R010 | DUPLICATE of SRC-151:R005 | Byte-identical (f4829648). |
| REQ-011 queued attachments | R011 | DUPLICATE of SRC-151:R006 | Same two screenshots. |
| REQ-012 accounts realtime | R012 | DUPLICATE of SRC-151:R007 | Byte-identical (42c3f7c2). E1 live-convergence acceptance still MANUAL_PENDING. |
| REQ-013 audit toggle | R013 | DUPLICATE of SRC-151:R008 | Same clause. E2 first-wave admission semantic still open. |
| REQ-014 button overlap | R014 | DUPLICATE of SRC-151:R009 | Byte-identical (55be341c). E3 geometry attribution still open. |
| REQ-015 tooltip corner | R015 | DUPLICATE of SRC-151:R010 | Byte-identical (4b027ca7). |
| REQ-016 right-click settings | R016 | DUPLICATE of SRC-151:R011 | Byte-identical (1bc7317c). |
| REQ-017 giant tooltip | R017 | DUPLICATE of SRC-151:R012 | Byte-identical (96738f62). |

Engine coverage: R006..R017 disp DUPLICATE with evidence links (COVERAGE_UPDATED x12).
R001..R005 left UNKNOWN (open work), no fabricated verdict. Repeated screenshots are
NOT counted as new acceptance: Group-1 visual rows stay MANUAL_PENDING.

## Ownership split (2026-10-05, /goal cc all continuation)
- T-222 Auto Goal supervisor owns R002, R003 (SRC-153). E-3802.
- T-223 Save All / ProTrail snapshot owns R004 (SRC-153). E-3803.
- T-220 VERIFY retains R001 (Phase A built, packaged click MANUAL_PENDING),
  R005 + R006..R017 as direct regressions/corrections of built Group-1 work:
  D connection truth, E1 accounts, E2 audit admission, E3 composer geometry,
  E4 remaining visual acceptance.

## Build status addendum (2026-10-05 continuation)
- R001 Phase A BUILT (machine green, packaged click MANUAL_PENDING).
- R005/D BUILT (presence projector + both surfaces, 9 tests green).
- R012/E1 machine proof BUILT (merge convergence + bound, 4 tests green);
  live two-account observation stays MANUAL_PENDING.
- R013/E2 BUILT (admission gate + copy, 36/36 services green).
- R014/E3 BUILT (extent metric; R002 did not cover it; 8/8 fit green).
- R002-R003 -> T-222 TODO; R004 -> T-223 TODO (E-3802/E-3803).
