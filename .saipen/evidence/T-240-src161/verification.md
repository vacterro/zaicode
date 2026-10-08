# T-240 / SRC-161 — evening 2026-10-06 reliability wave: verification record

Machine-complete. Packaged/manual acceptance is **not** performed on this machine and is listed
verbatim at the end — nothing in this file claims a PASS for a check that was not run.

## The seven required statements

1. **Runtime liveness is host/service-owned, not mounted-UI dependent — YES.**
   The durable owner is the job store: `zaicodeJobRepo.releaseRunningForHost()` and
   `reclaimStaleRunning()` (`packages/services/src/zaicode/zaicodeJobRepo.ts`, +18 lines), driven by
   `ZaicodeJobService`: `dispose()` releases this host's own leases, and the service's existing
   heartbeat re-runs `reconcileStaleRuns()` (`packages/services/src/zaicode/zaicodeJobService.ts`).
   Both statements carry `SRC-161:W2-001`. Nothing in that path reads a mounted React tree or the
   selected project. On the renderer side the live-run hint from the open chat is now a *bounded
   hint* reconciled against the sessions-index projection (`zaicodeLiveRuns.ts`,
   `ZAICODE_LIVE_RUN_INDEX_GRACE_MS = 60_000`), so opening a conversation can no longer be what
   corrects a row's state.
2. **The old five-hour threshold is a failsafe, not the authority — YES (with a stated ceiling).**
   Execution truth now comes from the lease/heartbeat path above and from the sessions-index
   projection. `ZAICODE_BACKGROUND_STALL_MS = 5h` survives in
   `packages/ui/src/zaicode/zaicodeStall.ts` only as a *bounded silence* window for a session whose
   sole claim is attached background work: the comment there states it is "deliberately not a
   'running for > N minutes => dead' rule", that total runtime is irrelevant, and that a job with
   fresh evidence never reaches the window. Its documented ceiling is that
   `backgroundWorkSummarySchema` carries no per-work heartbeat; a runtime-emitted heartbeat would
   replace the window entirely, and the file forbids inventing a UI-side fake one.
3. **Auto Retry visual state and execution policy share one canonical projection — YES.**
   `zaicodeEffectiveAutoRetryFor(projectKey, sessionId)` (`zaicodeRetryPolicy.ts:100`) folds master
   switch, scope, per-project/per-session override and the halted/quota gate into one value. Its
   readers in `packages/ui/src` are exactly the surfaces that must agree:
   `ZaicodeAutoRetryButton.tsx` (visual state + its tooltip), `zaicodeAutoRetry.ts` (the engine that
   acts) and `zaicodeTurnRetryWatch.ts` (the watch that acts). No surface re-derives it from prefs.
4. **Retry safety survives a renderer reload — YES.** `zaicodeRetrySafety.ts` (new) keeps the
   safety facts outside the React tree, and `packages/ui/test/zaicodeSrc161RetrySafetyReload.test.ts`
   proves the state after a simulated reload — not just within one mounted session.
5. **Metric duplicates are resolved by canonical identity, not display-name filtering — YES.**
   `mergeZaicodeSharedAccounts()` (`packages/shared/src/zaicode-engines.ts:183`) matches rows on
   `normalizeSharedLocator()` / `zaicodeSharedIdentityKey(providerId, locator)` — the home directory,
   or, for a home-less account, its credential target / config entry. `ZAICODE_MULTI_HOME_VENDORS`
   (claude, codex) and `ZAICODE_METRICS_ONLY_VENDORS` (freebuff) keep multi-install vendors and
   metrics-only planes from collapsing into one row, so `Claude 1`/`Claude 2` stay separate and no
   quota data is lost by becoming a duplicate.
6. **Latest user/assistant navigation uses stable row identities — YES.**
   `conversationLatestAnswer.ts` derives `identity = row.entityId ?? String(row.rowId)` and exposes
   `rowId`; `ConversationTurnNavStrip.tsx` jumps through the timeline's own
   `[data-row-id="<rowId>"]` anchor for both the latest user and the latest assistant side, so a
   re-render cannot re-target a neighbour.
7. **Was the packaged UI actually inspected on this machine? — NO.** No Windows package was built or
   opened in this wave; every UI claim above rests on rendered-markup tests and real geometry maths
   (see the density test below), not on looking at the packaged app. The manual checks are itemised
   under OPERATOR_REQUIRED.

## Requirements, root cause and repair

| REQ | Root cause | Repair |
| --- | --- | --- |
| 001 metrics identity | A home-less account had no locator, so the plane's own record and the generic vendor row could not match; dedupe was effectively by display name. | Canonical locator identity in `shared/src/zaicode-engines.ts` (+231/−2) with `ZAICODE_MULTI_HOME_VENDORS` / `ZAICODE_METRICS_ONLY_VENDORS`; engine settings updated to match. |
| 002 Auto Retry reachability | Visual state and the acting policy were derived separately, so the right-click flow could leave the button stale or the policy unreachable. | One projection (`zaicodeEffectiveAutoRetryFor`) read by button, tooltip, engine and watch; `zaicodeRetryPolicy.ts` (+53/−31), `zaicodeAutoRetry.ts`. |
| 003 tooltip anchor | Placement had a `(0,0)` fallback and kept a detached rect, so a tooltip could survive its anchor. | `shared/src/zaicode-tooltip.ts` (new): single gate `zaicodeAnchorBox()`, no render without a non-zero rect, detached ⇒ close, recompute on move/resize, clamped and flipped placement; `ZaicodeAnchoredCard.tsx` and the saimail reader use the live element, not a stored rect. |
| 004 audit revalidation | — | All 16 `audit/1.md` findings dispositioned with file:line evidence: 2 ALREADY_FIXED, 14 STILL_PRESENT; the 9 still-present P1s carry follow-up tickets T-241..T-249 with explicit "not repaired in this wave because …" reasons. See `REQ-004-audit1-dispositions.md`. |
| 005 CLEAR ALL DONE | A confirmation step sat in front of an action the operator had already asked for. | `ZaicodeClearAllDone.tsx` acts on the first click; `zaicodeFreshReq005Presence.test.ts` pins it. |
| 006 live execution truth | A mounted conversation published liveness and nothing else could correct it; shutdown released nothing, and staleness was only checked once at startup. | See statements 1 and 2: repo release + heartbeat reaper + bounded hint reconciliation. |
| 007 limits density | The panel asserted a 420px column inside a card whose height it could not see, while the card rendered its *unclamped* width — so the box overflowed a 380px window even though `left` had been computed for the clamped width. | Card renders `Math.min(width, viewport.width - 2 * MARGIN)` and keeps `maxHeight` + `overflow-y-auto`; panel fills the card with 4px gaps, tight leading and `compact` rows. `zaicodeSrc161LimitsDensity.test.ts` proves 436 ⇒ 364 on a 380px window with a red control against the old class string. |
| 008 composer `+` row | The attachment control could take a layout row of its own when nothing else was in it. | `composerFitDecision.ts` (new) + `useComposerToolbarFit.ts`: the strip is placed against the measured extent; `zaicodeSrc161ComposerRow.test.ts` pins "never an empty row". |
| 009 turn navigation | The latest-assistant element was positioned without a real layout lane. | `ConversationTurnNavStrip.tsx` + `conversationLatestAnswer.ts`: symmetric latest-user / latest-assistant anchors in a real lane, addressed by stable row id. |

## Tests added or corrected for this wave

New focused suites: `zaicodeSrc161Liveness`, `zaicodeSrc161TooltipAnchor`,
`zaicodeSrc161LimitsDensity`, `zaicodeSrc161ComposerRow`, `zaicodeSrc161TurnNav`,
`zaicodeSrc161RetryReachability`, `zaicodeSrc161RetrySafety`,
`zaicodeSrc161RetrySafetyReload`. Behavioural additions in
`packages/services/test/zaicodeJobs.test.ts` ("graceful shutdown releases this host's lease as
recoverable, never as a result (SRC-161:W2-001)", "shutdown releases only its own leases; a foreign
stale lease is reclaimed by staleness (SRC-161:W2-001)").

Two existing suites were corrected rather than protected, because the wave made their old premise
false:

- `zaicodeSrc85MailboxOpen.test.ts` pinned a stored-rect idiom that REQ-003 deliberately replaced;
  it now asserts the element is read live (`anchorEl={readerEl}`).
- `zaicodeT223SaveAllCoverage.test.ts` compared the shipped default to the hardcoded factory `"1"`,
  which the T-225 wave intentionally moved to `"0"`; it now compares against the shipped default, so
  the test still measures precedence (user > snapshot > factory) without freezing a build input.
- `zaicodeSrc88PresetUi.test.ts` (U3) assumed an empty preset shelf while the regenerated
  `zaicodeSettingsDefaults.json` in this tree carries real presets. The store's server-render
  snapshot is built once at import, so `setState` cannot empty it; the test now imports
  `test/support/presetStorageEmpty.ts` first, the same idiom `presetStorage.ts` already used.

Style exemption, stated plainly: `packages/services/src/zaicode/zaicodeJobService.ts` carries
`/* eslint-disable max-lines -- SRC-161:W2-001 … */` because the file sat exactly on the 400
logical-line ceiling before the wave and the two recovery statements belong beside the owner that
arms them. This is a style exemption, not a correctness claim.

## Gates on the final tree

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run test` (whole pipeline) | exit 0 — scripts 118, ui 1275, services 105, desktop 252, cli core 45, adapters 9, bootstrap 11; 0 failures |
| `pnpm run lint` | exit 0 — 0 errors, 166 pre-existing warnings |
| `pnpm run architecture:check` | exit 0 — `violations: 0`, `baseline: 0`, `new: 0` |

## Disposition of audit/1.md, and the inbox layer

audit baseline archive sha256 `9e730bdd…0de29`, AUDAPACK manifest `2026-10-06T11:47:20`, nested
zcode source `1cbb0921`, version 3.14.0. zcode HEAD **is** `1cbb0921`
(`git rev-list --count 1cbb0921..HEAD` = 0), so every finding was judged against the 130-entry
uncommitted working tree. Full table: `REQ-004-audit1-dispositions.md`.

Layer `audit/1.md` was **left in place**: `audit_inbox.delete_gate` requires the bound receipt
tombstoned *and* the linked Work `T-239` DONE, and T-239's own verify clause requires every
actionable SRC-160 clause terminal — which T-241..T-249 are not. Consuming the layer now would be a
false closure claim, and the delete is irreversible. 7 residue files stay REPORT_NEVER_DELETE.

## Remaining risks

- REQ-001 keeps preserving distinct installs of a multi-home vendor from the plane's own locator; a
  plane that reports neither `home` nor a credential target still cannot be matched, so such a row
  remains separate by design rather than guessed together.
- `ZAICODE_BACKGROUND_STALL_MS` remains the client's only evidence for a background-work claim until
  `backgroundWorkSummarySchema` carries a heartbeat (ceiling documented in `zaicodeStall.ts`).
- The 9 ticketed P1s (T-241..T-249) are open work, not regressions: each row's continue-as-`running`
  risk is bounded by the new lease path, but the underlying defects stand until their tickets land.
- `zcode/` is a separate Git repository and was left on its own branch with its uncommitted changes,
  including the concurrent T-224/T-225/T-226 work in the same tree.

## OPERATOR_REQUIRED — nothing below was performed here

1. Build and open a Windows package of this tree, then confirm in the packaged app:
   - the AI Usage Limits card fits a narrow (≲380px) window without a horizontal overflow and
     scrolls internally instead of towering;
   - the composer `+` never occupies an otherwise empty row;
   - the latest-assistant and latest-user navigation elements do not overlap neighbouring
     header/content elements;
   - a tooltip whose anchor scrolls away or is unmounted closes instead of hanging at the screen
     corner.
2. Reproduce the Auto Retry right-click flow and confirm the button's visual state and the effective
   policy agree, and that the change is reversible from the same flow.
3. Confirm on a real run that a session which ended while its project was **not** open stops showing
   as working without the user opening it.
