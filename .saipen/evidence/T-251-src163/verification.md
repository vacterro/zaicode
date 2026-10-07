# T-251 / SRC-163 — verification record

SRC-163 asks one question: how is each item of the SRC-151 operator bundle **really** implemented in
the tree? The operator suspects "done, but crooked and thin", and T-220's ledger had left 28 of the
44 items as `DUPLICATE … NOT_RUN` — never re-checked. This ticket re-checks all 44 and drives the
visual ones on the packaged application.

## What was built in this wave

| artefact | what it is |
|---|---|
| `hunt-drive.cjs` (repaired) | packaged probe on the staged app: proves composer admission, drives one real SAIFREN turn, then R009 / R020 / R036. 24 checks |
| `surface-drive.cjs` (new) | packaged probe for the items whose acceptance is visible or runtime: R038, R017, R016, R027, R022, R034, R030, R028, R031, R004, plus the admission and session-row preconditions and a zero-renderer-exception gate. 13 checks |
| `verdict-ledger.md` | one disposition per SRC-151 item (44 rows), each with its evidence class |
| `packaged/receipt.json`, `packaged/surface-receipt.json` | machine-readable receipts for the two drivers |
| `packaged-t250/receipt.json` | T-250's driver re-run on **this** build (14 PASS / 1 SKIP / 0 renderer exceptions) |
| `r014-test.log`, `r016-test.log` | unit logs for R014 and R016 |
| `packaged/surface-*.png`, `packaged/receipt.json` screenshots | the visual artefacts behind the geometry/paint assertions |
| `zcode/packages/ui/test/zaicodeT251ArchiveNoticeRow.test.ts` | the only code added: R016 had no test at all (6/6 green) |

## Build under test

Staged `dist-next` packaged app, `resources/app.asar`
`sha256 a9e6ef6f9ec66b2751a0f246add3d4562803e312e953eaee7c88c75df7f4489e`, 420 337 911 bytes.
The hash is **identical before and after this wave**, so no production file was changed to make a
probe green: every packaged result below is a reading of the same artefact.

## Target 1 — the composer admission (why the old driver could not send)

The packaged driver used to look for `chat-send-button` / `v4-composer-send` in a place they are not,
and its failure was reported as a product defect. The real state: `[data-testid="v4-composer-send"]`
**resolves** (a submit button, `aria-label "Send"`, `disabled=true` until the draft, the model
selection and the prewarm settle). So the defect was readiness/admission, not a missing selector.

The repaired driver:

- types the prompt through the production Lexical E2E bridge on `[data-testid="v4-composer-input"]`,
  so the editor's own state is used rather than a DOM paint;
- **waits** for the send button to lose `disabled`, bounded, with diagnostics, instead of sleeping;
- never force-clicks, never touches a production guard, and aborts the run with readiness diagnostics
  when admission does not arrive;
- does not continue into R009 / R020 / R036 on a failed admission.

## Target 2 — the false-green turn check, replaced

"A real turn completed" is no longer a regex over `[data-row-id]`. The proof reads the same anchors
the turn navigation derives from (`v4-latest-user` / `v4-latest-answer`), and requires:

- the exact sent prompt inside the user bubble of that row,
- a distinct later row in the same timeline carrying the sentinel,
- session and task identity non-null and stable after draft promotion (no second state source: the
  canonical row and session ids are read, not duplicated),
- both rows and the session title surviving a navigation away and back,
- no renderer exception.

## Target 3 — R009, R020, R036 (driven only after the turn proof held)

`packaged/receipt.json`, 24 checks green: R009 (latest-user and latest-answer controls exist; the
turn-nav strip is its own lane and does not overlap the header), R020 (ZAICODE → SAIHOME → back: one
normal click restores the same conversation), R036 (a completed turn leaves a distinguishable
completed-unseen state; opening that exact project/session clears it; ordinary old projects do not
look identical).

## Surface items (R038, R017, R016, R027, R022, R034, R030, R028, R031, R004)

`packaged/surface-receipt.json`, run 8: **13/13 PASS, zero renderer exceptions**. The assertions are
geometry or state projections, not source reads: pane width before/after the sidebar toggle, the
archive notice's box against the sidebar, the theme attribute plus sampled button paint, the
accent/colour-scheme of a range input, the settings section list before/after a search plus the
`aria-current` hit, the usage refresh options, the workers panel's layout/collapse attributes after
really pressing its controls, and the maximized window against the display work area.

## Probe honesty — eight failed runs, and why they were not product verdicts

Runs 1–7 failed R028 and/or R031. Each failure was diagnosed before anything was called a defect:

- Run 1 R017 failed on a probe bug (a collapsed sidebar rail is 4 px, not 0). Product was correct.
- Runs 1–2 R016 failed because the probe right-clicked a session row; the production path is the
  project row's "More" → "Archive all sessions".
- Runs 1–2 R022 found no presets because the picker lives in an *advanced* (folded) settings section
  — that folding is R027 working.
- Runs 1–2 R028/R031: the usage footer entry ships hidden, the old Ctrl+Alt+B binding was removed by
  T-226/SRC-156, and the nav click was swallowed.
- Runs 4–7 finally showed the shared root cause: Playwright's own `locator.click()` **timed out** for
  every one of the 11 workers-panel controls and for the usage tool, and a geometry probe named the
  owner of each button's centre point — an element with `-webkit-app-region: drag` inside
  `div[settings-page]`, with the panel subtree computing `pointer-events: none`. **Settings was still
  open**, and while it is open the whole workspace subtree is inert: no workspace control can be
  clicked, by the probe or by the operator. The probe now leaves Settings by reloading the shell back
  to the workspace and records that fact (`leftSettingsForUsage`, `leftSettingsForWorkers`) instead of
  pretending a swallowed click was an effect.
- Run 8 on the same asar: R028 PASS (refresh options exactly `10/5/3/2/1`, resize handle present, zero
  bare "Done" cells) and R031 PASS (11/11 controls reachable, `Tabs:` → `tabs`, collapse → `true`,
  maximize → `false`, nothing unlabelled, no press error).

Non-goals held throughout: no production guard weakened, no `force:true`, no blind sleep presented as
readiness, no assumption that R020/R036 were broken from the earlier invalid probe, R008 not reopened,
no unrelated visual redesign, no destructive git reconciliation.

## Gates

| gate | result |
|---|---|
| focused tests added/affected | `zaicodeT251ArchiveNoticeRow.test.ts` 6/6 (`r016-test.log`); `zaicodeRouterSupervisor.test.ts` 8/8 (`r014-test.log`) |
| `pnpm run typecheck` | **PASS** — `tsc -b` over the 14 project configs, no diagnostics (`zcode-typecheck.log`) |
| `pnpm run verify:pre-push` | **PASS, exit 0** — lint 166 warnings / **0 errors** on 4729 files; `architecture:check --changed` clean; `pnpm run test` **1870 tests, 0 fail, 0 cancelled** across 7 suites (`zcode-prepush.log`) |
| staged `dist-next` rebuild | **not needed**: no production file changed in this wave (same asar sha256) |
| repaired packaged hunt driver, fresh throw-away profile | 24/24 green (`packaged/receipt.json`) |
| T-250 driver re-run on this build | 14 PASS / 1 SKIP / 0 exceptions (`packaged-t250/receipt.json`) |
| verdict ledger, receipts, screenshots | `.saipen/evidence/T-251-src163/verdict-ledger.md`, `packaged/` |

## Honest limitations

1. **Screenshots could not be visually compared.** The harness in this session has no image input, so
   the PNGs under `packaged/` are artefacts for the operator to look at; every assertion above is a
   measured DOM or state fact, not a claim to have seen a picture. Items whose acceptance is purely
   visual therefore rest on the driver's measurements and are labelled with their evidence class in
   the ledger.
2. **SKIPs are probe limits, not product facts.** The surface driver records SKIP with its reason (and
   `pass: null`, never a pass) when a precondition is genuinely absent; the T-250 re-run SKIPs the side
   pane handle it never needed.
3. **Items that need the operator's own environment** are named in the ledger's residuals: R007
   (manual add-account exists only for vendors that can hold several accounts), R035 (the readiness
   bars carry no account id, so the Ctrl+Click toggle cannot live there), R015 (MAIN mode hides the
   child session but still creates the record), R025 (a persisted `panelCollapsed:true` makes the
   WORKERS toggle return a collapsed dock), R024 (image-only complaint, no reproducible path found),
   R013/R041 (a real paid-vendor exhaustion was not reproduced — it would spend the operator's money),
   R003 (the OS z-order was not observable from the harness).
4. **AUDAPACK packaging debt (recorded, not repaired here).** The audit archive's
   `.audapack/manifest.json` names the nested `zcode` component with `origin
   github.com/vacterro/zaicode`, head `4f71888c…`, but records `included:false`, `files:0` — the
   archive does not carry the product tree it names. This is AUDAPACK's debt and was deliberately not
   rewritten inside the T-251 wave.
5. **Numbering.** Everything here uses the canonical `SRC-151:R0NN` ids from
   `.saipen/intake/coverage/SRC-151.json`. T-220's `REQ-NNN` is keyed to the bundle's source *line*
   (`REQ-009` = source line 19 = this R009); SRC-161's `REQ-009` is a different requirement.
