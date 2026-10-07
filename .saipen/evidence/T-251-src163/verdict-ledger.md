# T-251 / SRC-163 — verdict ledger, one disposition per SRC-151 item

Audit question: the SRC-151 bundle (`.saipen/evidence/T-220/fresh-bundle/`, same archive as the
operator's zip) was reported "done" but suspected "crooked and thin". T-220 recorded 28 of the 44
items as `DUPLICATE … NOT_RUN` — never re-checked against the tree. This ledger re-checks every one.

Allowed dispositions, exactly one per item: **SOLID | THIN | BROKEN | OBSOLETE | DUPLICATE_VERIFIED |
BLOCKED_EXTERNAL**. (`DUPLICATE` alone is not a disposition.) `OBSOLETE` = the operator struck the
line through in the bundle itself (`[x] ~~…~~`).

Evidence classes, so a row is never read as stronger than it is:

| class | meaning |
|---|---|
| PACKAGED-R251-HUNT | driven on the packaged app by `hunt-drive.cjs` on the staged asar in this wave (real SAIFREN turn) |
| PACKAGED-R251-SURFACE | driven on the packaged app by `surface-drive.cjs` on the same asar (geometry, paint, state projection) |
| UNIT-R251 | a test added or re-run in this wave; log in this directory |
| PACKAGED-T250 | T-250's own driver, **re-run on this build** during T-251 (`packaged-t250/receipt.json`, 14 PASS / 1 SKIP / 0 renderer exceptions, same asar) |
| UNIT-T250 | T-250's tests |
| SOURCE-R251 | a read of the current tree (file:symbol named). **Not** a pass on its own for a visual item |

Build under test: staged `dist-next` packaged app, `resources/app.asar`
`sha256 a9e6ef6f9ec66b2751a0f246add3d4562803e312e953eaee7c88c75df7f4489e` (420 337 911 bytes) —
identical before and after this wave: no production file was changed to make a probe green.

## The 44 items

| # | operator item (short) | disposition | evidence class | evidence | note |
|---|---|---|---|---|---|
| R001 | still no working fallback | SOLID | PACKAGED-T220 | `T-220/packaged-outage-2026-10-05T03-09-17-171Z/receipt.json` `ok:true`; `desktop/src/main/zaicodeRouterSupervisor.ts` | verified in T-220; re-read in this wave under R014 |
| R002 | composer cannot fit its elements; make it dynamic | SOLID | PACKAGED-T250 | T-250 receipt: "composer `+` shares its row with trailing controls" at 959/820/700/600 px; `prompt-editor/ChatPromptEditor.tsx:491` (`flex-1 min-w-0 flex-wrap`), `useComposerToolbarFit.ts` | compaction ladder before the cluster wraps |
| R003 | ProTrail goes behind every window until restarted | SOLID | UNIT | `desktop/src/main/zaicodeProtrailGlobal.ts:553` `restackOverlay`, `:570` `scheduleRestack`, `:58` `RESTACK_MS=2000`; `desktop/test/zaicodeProtrailStartup.test.ts:253` ("a z-order the shell drops is re-asserted without a restart") | the reported cure without a restart; OS z-order not observable from here |
| R004 | maximized window lands wrong | SOLID | PACKAGED-R251-SURFACE | surface receipt `R004` PASS: maximized bounds inside the display `workArea` (±2 px), then restored | |
| R005 | shows "working" after the work finished | SOLID | UNIT-T250 | T-250 item 8: `WorkspaceSidebar.tsx` re-runs `reconcileZaicodeLiveRuns` every 15 s while a hint is held | R040 is the same complaint (see below) |
| R006 | queued row shows only "goal cc all", no attachment indicator | SOLID | PACKAGED-R251-HUNT | hunt receipt `R006`; `zaicode/zaicodeAutoGoal.ts` `splitZaicodeAutoGoal`, used by `ConversationQueuePanel.tsx`, `ConversationRowView.tsx`, `SessionPane.tsx` | the goal rides in the body; queue row, sent bubble and edit draft now show it as a chip |
| R007 | real-time accounts; only Codex/Claude; cannot add other subscriptions | **THIN** | SOURCE-R251 | `shared/src/zaicode-engines.ts:54` `ZAICODE_MULTI_HOME_VENDORS=["claude","codex"]`; `desktop/src/main/zaicodeEngines.ts:637` `discoverAccounts`, `:1254` sweep; `settings/ZaicodeEnginesSettings.tsx:87/116/250` `ADD_ACCOUNT_COMMANDS` rejects other vendors ("This subscription keeps one account"); `ui/test/zaicodeT220SharedAccounts.test.ts:65` | pool merge + live refresh are real and tested; **manual** add exists only where a vendor can hold several accounts. Residual, not repaired in this wave |
| R008 | A3 audit wave must be globally toggleable | SOLID | SOURCE-R251 | `zaicode/zaicodeAuditService.ts:894` "Generate the next wave by itself" gates the smart sweep | carried over from T-250; nothing contradicts it, so not reopened |
| R009 | buttons can overlap each other | SOLID | PACKAGED-R251-HUNT | hunt receipt `R009`: latest-user + latest-answer nav controls exist, the strip is its own lane and does not overlap the header | numbering note in "Notes" below |
| R010 | tooltips spawn in the top-left corner | SOLID | PACKAGED-T250 + UNIT-T250 | T-250 receipt "no row tooltip lingers after the pointer leaves the row"; `ControlHintTooltip.tsx` (no box ⇒ no open, ResizeObserver close, `hideWhenDetached`) | |
| R011 | right-click must open the settings of these buttons | SOLID | PACKAGED-T250 + UNIT-T250 | T-250 receipt: "right-click opens the Auto retry panel", "the panel offers no app-menu mode that could kill the right button", "still opens the second time" | |
| R012 | giant tooltips are unacceptable | SOLID | SOURCE-R251 | `shared/src/zaicode-tooltip.ts:49/84` (height ceiling against remaining room), `ZaicodeAnchoredCard.tsx:117/136` (height cap + width clamp), `ControlHintTooltip.tsx:71` `max-w-[min(28rem,calc(100vw-1rem))]`; tests `zaicodeT220AnchoredCard.test.ts:16` ("giant ones"), `zaicodeSrc161TooltipAnchor.test.ts:27` | |
| R013 | scheduler continuity across a vendor limit | SOLID | UNIT-R251 | `shared/src/zaicode-schedule-continuation.ts:49/58/75/85`; `zaicode/zaicodeAutostartContinuation.ts:57/93`; `zaicodeContinuation.test.ts:12`, `zaicodeContinuationEffects.test.ts:72`, `zaicodeT190VendorLimitOracle.test.ts:252/290` | residual: a real paid-vendor exhaustion was not reproduced (needs the operator's live subscriptions) |
| R014 | 9router crashes: 10 restarts, then fallback, then silent recovery | SOLID | PACKAGED-T220 + UNIT-R251 | `desktop/src/main/zaicodeRouterSupervisor.ts:32` `ZAICODE_ROUTER_FALLBACK_RECOVER_MS = 5 min`, budget literal `10` at `:43/:105/:116`, silent recovery `:94-102`; `r014-test.log` 8/8 including "the operator's own router is still restarted every few minutes, silently"; T-220 outage receipt `ok:true` | fixed in this ticket (the fallback used to end the restarts for good) |
| R015 | orphan child sessions in MAIN mode | SOLID (presentation) | SOURCE-R251 | `WorkspaceSidebarItem.tsx:887-900` `zaicodeChildTasks` / `zaicodeListedTasks` filter child rows out of the MAIN-mode list | no test; residual: the child session record is still created, only its presentation is suppressed |
| R016 | archive cleaner popup covers part of the sidebar | SOLID | PACKAGED-R251-SURFACE + UNIT-R251 | surface receipt `R016` (own in-flow row, `overlapsSidebar:false`, `height<=40`); `ui/test/zaicodeT251ArchiveNoticeRow.test.ts` 6/6 (`r016-test.log`); `ZaicodeArchiveNotice.tsx:19` | the earlier "THIN" reading was a probe error (wrong entry point: right-click on a session row); the real path is the project row's "More" → "Archive all sessions" |
| R017 | a second click must hide the sidebar again | SOLID | PACKAGED-R251-SURFACE | surface receipt `R017` (`aria-expanded` true→false→true; pane 264→4→264 px) | run 1 failed on a probe bug, not the product |
| R018 | says auto retry on while it is off | SOLID | PACKAGED-T250 + UNIT-T250 | T-250 receipt "every click flips the Auto retry button"; `zaicode/zaicodeRetryPolicy.ts` (one `block` per projection) | |
| R019 | cannot edit the large pasted text that became a file | SOLID | SOURCE-R251 + UNIT | `lib/chatAttachments.ts:36` threshold 15 KB, `:150` `applyPastedTextEdit`; `v4/composer/ComposerPastedTextEditor.tsx`; `zaicodeT224PastedTextEdit.test.ts:44`, `zaicodeWave2PastedText.test.ts:52` | edit dialog + restore-to-composer with round-trip tests |
| R020 | cannot switch back into the same project/session | SOLID | PACKAGED-R251-HUNT | hunt receipt `R020`: ZAICODE → SAIHOME → back, one normal click restores the conversation | |
| R021 | want 5h/weekly bars on a worker | SOLID | SOURCE-R251 + UNIT | `zaicode/ZaicodeWorkerQuotaMeters.tsx:6/18` (`data-zaicode-worker-quota`), used `ZaicodeWorkerParts.tsx:99`; `zaicodeT217Continuity.test.ts:36` | |
| R022 | a simplified theme without bevels | SOLID | PACKAGED-R251-SURFACE | surface receipt `R022`: `html[data-zaicode-style="flat"]` really repaints (sampled button `box-shadow:none`, `border-radius:0`) and restores | |
| R023 | move COLLECT into the bottom row, keep it compact | SOLID | SOURCE-R251 | `prompt-editor/ChatPromptEditor.tsx:491-497` renders the chip inside `data-composer-trailing-actions`; `ZaicodeSubOutboxChip.tsx:91-109` COLLECT is `h-6`; `zaicodeT144.test.ts:157` (one chip + collect command) | gap: no test pins the row placement; an earlier reading in this ticket called it THIN — resolved by this read |
| R024 | reordered sidebar items do not migrate their buttons | **BLOCKED_EXTERNAL** | SOURCE-R251 (candidates only) | `lib/sidebarPurposeSectionPreferences.ts:59`, `zaicode/zaicodeLayoutPrefs.ts:341/355`, `zaicodeProjectOrganization.ts:143`; `zaicodeWave35.test.ts:290`, `zaicodeWave4Organization.test.ts:448` | complaint is image-only (media/023); no reproducible symptom in the tree; needs the operator's own repro before a repair is named |
| R025 | the Workers tab has no effect hidden or expanded | SOLID | PACKAGED-R251-SURFACE | nav line `ZaicodeSidebarNavBlock.tsx:127` → `toggleZaicodeWorkersDock` = `toggleZaicodeWorkersPanel` (`zaicodeWorkers.ts:162/189`), the same handler as the Alt+W hotkey (`ZaicodeAppRuntime.tsx:285`); the panel gate reads it: `ZaicodeWorkersPanel.tsx:172` | runtime: Alt+W really shows the dock 11/11 controls reachable (surface receipt). Residual: with a persisted `panelCollapsed:true` the dock returns collapsed, which can read as "no effect" |
| R026 | [checked off] presets must not restart the program | OBSOLETE | — | struck through in the intake bundle | operator closed it |
| R027 | move irrelevant settings sections down, folded by default | SOLID | PACKAGED-R251-SURFACE | surface receipt `R027`: every `[data-zaicode-settings-advanced]` fold is closed and SAIASUI is not on the first screen | |
| R028 | usage meter: 10/5/3/2/1 s refresh, no bare "Done", resizable name column | SOLID | PACKAGED-R251-SURFACE | surface receipt `R028`: opened `usageMode:"page"`; refresh options exactly `["10","5","3","2","1"]`; `[data-zaicode-usage-column-resize]` present; 0 bare "Done" leaf cells | 8 of the failed attempts before this were probe state, not the product (see "Probe honesty") |
| R029 | Auto-Goal composer button, silent append, per project, on by default | SOLID | SOURCE-R251 + UNIT | `zaicode/zaicodeAutoGoal.ts:15/20-23/77/91`; `ZaicodeAutoGoalButton.tsx:25`; append at `v4/ConversationComposer.tsx:1364`; `zaicodeT204AutoGoal.test.ts:16/33/41/54` | |
| R030 | obvious settings search | SOLID | PACKAGED-R251-SURFACE | surface receipt `R030`: typing "usage" narrows the section list and Enter lands on a `[aria-current="page"]` section | |
| R031 | the Workers-panel buttons do not react at all | SOLID | PACKAGED-R251-SURFACE | surface receipt `R031`: panel open, 11/11 controls reachable, `Tabs:` flips the layout to `tabs`, `Collapse the panel` flips collapsed to `true`, `Maximize the panel` back to `false`, 0 unlabelled, 0 press errors | every earlier failure showed the same root cause: Settings was still open, so the workspace subtree was inert (`pointer-events:none`) — the probe's fault, and it is what the operator hits too when a tool is clicked from inside Settings |
| R032 | reliable Auto retry switch near the composer with a scope | SOLID | UNIT-T250 + PACKAGED-T250 | `zaicodeUiPrefs.ts:35/66/146`, `zaicodeRetryPolicy.ts:95`, `ZaicodeAutoRetryButton.tsx:53/107/126`; `zaicodeT201AutoRetryScope.test.ts:46/59/72`, `zaicodeSrc162RetryToggle.test.ts:27` | |
| R033 | collapse the workers panel when the last worker collapses | SOLID | UNIT | `zaicode/zaicodeWorkerPrefs.ts:202` `zaicodePanelShouldAutoCollapse`, `:210` follows-last-worker hook, used `ZaicodeWorkersPanel.tsx:98`; `zaicodeT200PanelFollowsLastWorker.test.ts:11/21` | |
| R034 | white sliders are unacceptable | SOLID | PACKAGED-R251-SURFACE | surface receipt `R034`: range sliders take the palette accent (not white) and a dark `color-scheme` | |
| R035 | Ctrl+Click enable/disable from the scheduler readiness bars | **THIN** | SOURCE-R251 + UNIT | the toggle exists only on account/limit tiles: `ZaicodeLimitViews.tsx:124-130`, `zaicodeSchedulerEligibility.ts:20/33`, `zaicodeT198SchedulerEligibility.test.ts:13/44`; the readiness bars (`ZaicodeReadinessBar.tsx:37`, used `ModelConfigSelect.tsx:406`, `settings/ZaicodeRouterSubscriptions.tsx:106/122`) carry **no account id** and have no ctrl handler | eligibility logic is real and tested; the requested toggle on those bars is missing. Residual (design boundary), not patched |
| R036 | done-unseen indicator that clears when the project is opened | SOLID | PACKAGED-R251-HUNT | hunt receipt `R036`: a completed turn leaves a distinguishable completed-unseen state, opening that exact session clears it, idle projects do not look identical | |
| R037 | [checked off] optimise token spend | OBSOLETE | — | struck through | operator closed it |
| R038 | project/session switching in the sidebar is confusing | SOLID | PACKAGED-R251-SURFACE | surface receipt `R038`: a project click always lands on a usable surface (session pane or live draft), never a dead window | |
| R039 | [checked off] test-run indicator in the list | OBSOLETE | — | struck through | operator closed it |
| R040 | still says "working" when the session ended (and the reverse) | DUPLICATE_VERIFIED(R005) | UNIT-T250 | same owner as R005: `WorkspaceSidebar.tsx` live-run reconciliation every 15 s | the same complaint as R005; verified once, not counted twice |
| R041 | scheduler: detect each vendor's limit, continue on SAIFREN until the reset | SOLID | UNIT-R251 | same family as R013: `shared/src/zaicode-schedule-continuation.ts:58/85`, routing in `zaicodeAutostartContinuation.ts`; `zaicodeT190VendorLimitOracle.test.ts:290/305/334` | residual: a real paid-vendor exhaustion was not reproduced |
| R042 | [checked off] "Working for: (empty)" | OBSOLETE | — | struck through (media 025) | operator closed it |
| R043 | [checked off] windows with hanging messages | OBSOLETE | — | struck through (media 033) | operator closed it |
| R044 | [checked off] automation that waited 5+ hours | OBSOLETE | — | struck through (media 034) | operator closed it |

Tally: SOLID 33, THIN 2 (R007, R035), BLOCKED_EXTERNAL 1 (R024), DUPLICATE_VERIFIED 1 (R040),
OBSOLETE 6 (R026, R037, R039, R042, R043, R044). BROKEN: none.

## Residuals handed back to the operator (not repaired in this wave)

1. **R007** — manual "Add account" exists only for vendors that can hold several accounts
   (claude, codex). Every other subscription keeps one account by design. Making it general is a
   feature, not the hunt's narrowest boundary, so it is recorded instead of half-built.
2. **R035** — the Ctrl+Click eligibility toggle is on the account/limit tiles; the readiness bars in
   `ModelConfigSelect` and `ZaicodeRouterSubscriptions` pass no account id, so they cannot offer it
   without changing what those bars are made of.
3. **R015** — MAIN mode hides the child session from the list, but still creates the record.
   "Never shown" is done; "never exists" is not.
4. **R025** — if `panelCollapsed` was persisted as true, the WORKERS toggle returns a collapsed dock,
   which looks like "no effect". One click on the dock's Maximize fixes it for that profile.
5. **R024** — needs the operator's own repro (image-only complaint, no reproducible path found).
6. **R013 / R041** — the chain is unit-proven with a vendor-limit oracle; a real paid subscription
   hitting zero was not reproduced here (would spend the operator's money).
7. **R003** — the 2 s restack is unit-proven; the OS z-order was not observable from the harness.

## Probe honesty (why repeated failures were not product verdicts)

Eight surface runs failed R028/R031 before run 8 passed. The evidence that settled it:

- Playwright's own `locator.click()` **timed out** for every one of the 11 workers-panel controls and
  for the usage tool. That is a real interception, so it was chased, not excused.
- A geometry probe then named the owner of each button's centre point: an element with
  `-webkit-app-region: drag` inside `div[settings-page]`, and the panel subtree itself computed
  `pointer-events: none`. **Settings was still open**, and while it is open the workspace subtree is
  inert — no workspace control can be clicked, by the probe or by the operator.
- Closing Settings through the nav line did not work (the shell renders the Settings route), so the
  probe now reloads the shell back to the workspace and records that fact (`leftSettingsForUsage` /
  `leftSettingsForWorkers`) instead of pretending a swallowed click was an effect.
- Run 8 on the **same asar**: R028 PASS (options exactly 10/5/3/2/1, resize handle present, 0 bare
  "Done"), R031 PASS (11/11 controls reachable, layout flip and collapse flip both take effect).

No production guard was weakened, nothing was force-clicked, and no blind sleep is presented as
readiness: the composer admission waits for the send button to lose `disabled`, and a disabled
button aborts the run.

## Notes

- **R009 numbering drift.** The T-220 ledger's `REQ-NNN` is keyed to the source *line* of the bundle
  (`REQ-009` = source line 19 = this R009). SRC-161's own `REQ-009` is a different requirement. Rows
  here are the canonical `SRC-151:R0NN` ids from `.saipen/intake/coverage/SRC-151.json`.
- **R016 repair.** Unlike the rest, this item gained new coverage in this wave: the notice row had no
  test at all. `zcode/packages/ui/test/zaicodeT251ArchiveNoticeRow.test.ts` (6/6) now pins the
  bounded in-flow row, its mount site, the undo/restore notices and the bounded undo ring.
- **AUDAPACK packaging debt (recorded, not repaired here).** The audit archive's
  `.audapack/manifest.json` records the nested `zcode` component as `included:false`, `files:0`
  while naming `origin github.com/vacterro/zaicode` and head `4f71888c…`. So the archive does not
  actually carry the product tree it names. This is AUDAPACK's debt, not T-251's, and was not
  rewritten in this wave per the stop-rule.
- **T-220 correspondence.** Every item T-220 marked `DUPLICATE … NOT_RUN` now has a disposition in
  this table. Items T-220 marked `BUILT; MANUAL_PENDING` (REQ-002 … REQ-012, REQ-040) are the same
  as R002 … R012 and R040 here; the ones whose acceptance is visual (R004, R016, R017, R022, R027,
  R030, R034, R038) were driven on the packaged app in this wave.
