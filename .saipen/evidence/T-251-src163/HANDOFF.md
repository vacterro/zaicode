# T-251 / SRC-163 — SAIHUNT handoff (stopped by the operator, usage limit)

SRC-163: audit how every SRC-151 bundle item (`ZAICODE (Day 05 Oct - 02-13)_bundle_20261005_041305.zip`,
same archive as `.saipen/evidence/T-220/`) is really implemented. The operator suspects "done, but
crooked and thin". Key fact: the T-220 ledger (`.saipen/evidence/T-220/disposition-ledger.md`) marked
28 of the items `DUPLICATE ... NOT_RUN` — they were never re-checked against the tree.

## Done in this session (zcode, uncommitted at stop -> committed by the stop checkpoint)

| Item | Verdict | Fix |
|---|---|---|
| R006 queued row with Auto-Goal | THIN: the attachment badge existed, but `/goal cc all` rides in the body and shows in the queue row, the sent bubble and the edit draft (not "invisible") | `splitZaicodeAutoGoal` in `zaicodeAutoGoal.ts`; used in `ConversationQueuePanel.tsx`, `ConversationRowView.tsx` (edit keeps the goal), `SessionPane.tsx` queue edit restore; "goal cc all" chip instead |
| R008 global A3 toggle | SOLID: "Generate the next wave by itself" gates smart sweep (`zaicodeAuditService.ts:894`) | none |
| R014 9router 10 restarts then fallback | THIN: after the 10th failure the operator's router was never restarted again for the life of the app | `zaicodeRouterSupervisor.ts`: silent restart every `ZAICODE_ROUTER_FALLBACK_RECOVER_MS` (5 min) while on fallback; test added |
| R010/R011/R018/R002/R005 | re-done under T-250 (tooltips, right-click, retry, composer, liveness) | see `.saipen/evidence/T-250-src162/verification.md` |

Tests: `packages/ui/test/zaicodeSrc163Hunt.test.ts` (R006), `packages/desktop/test/zaicodeRouterSupervisor.test.ts`
(new last case). UI typecheck exit 0; focused suites green. Full `pnpm run verify:pre-push` NOT RUN after
these two fixes.

## Open — next exact steps

1. Packaged hunt driver `.saipen/evidence/T-251-src163/hunt-drive.cjs` cannot send yet: neither
   `chat-send-button` nor `v4-composer-send` exists in the ZAICODE composer. The last edit adds a
   diagnostic dump of `[data-composer-trailing-actions]` buttons; run it once, take the real send
   selector, then it drives R020 (switch back to the same session after ZAICODE/SAIHOME), R009 turn
   nav with a real turn, R036 done-unseen.
2. Not yet audited: R003 ProTrail z-order, R004 maximize, R007 accounts (partly via T-250), R012 giant
   tooltips, R013/R041 scheduler continuity on vendor limit, R015 orphan child sessions in MAIN mode
   (media 014/015), R016 archive toast covers sidebar (media 016), R017 toggle hides side pane again
   (media 018), R019 edit large pasted text, R020, R021 worker 5h/weekly bars, R022 simple theme w/o
   bevels, R023 COLLECT row, R024 swapped sidebar buttons, R025 Workers tab no effect, R027 settings
   order/collapse, R028 meter refresh 10/5/3/2/1 + no "Done" + column resize, R030 settings search,
   R031 Workers buttons dead, R033 single worker collapse, R034 white sliders, R035 Ctrl+Click
   eligibility, R036 done-unseen, R038 sidebar project/session switching.
3. Bundle media is extracted at the session scratchpad only; re-extract from the zip in
   `.saipen/evidence/T-220/` (sha256 20945ec5...) into a scratch folder.
4. After the audit: write the verdict ledger here, fix BROKEN/THIN items, rebuild staged dist-next,
   re-run both drivers, close T-251. Then T-242 (blocked-for T-251), T-241, T-240 (MANUAL_PENDING;
   T-250 covered most of its packaged checks).

## Transport

- zcode `b1493cfd` pushed to github `zaicode` and `main` (fast-forward).
- Root `ad55f741` pushed to `origin/saipen-live` (new branch). Local `master` and `origin/master`
  DIVERGED (operator docs commits ab3ba095 on GitHub vs local); nothing forced, recorded in LOG.
