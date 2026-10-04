# T-191: elapsed duration at both ends

Source SRC-126 requests elapsed work time at the end as well as the beginning.
The operator clarification binds this to ZAICODE chat and CLI worker terminals.
The product specification is `zcode/specs/zaicode-session-duration-tail.md`.

## Implementation and boundaries

Each ordinary projected chat segment now has a footer outside its collapsible
history. Header and footer use one small status-label component, the existing
projected timestamps and the existing localized duration formatter. Interrupted
work displays its known recorded duration. Guided segments preserve their own
durations. Unknown time remains unknown; control-only turns acquire no timer.

Every worker terminal wrapper displays its existing status and elapsed duration
below the terminal viewport. The footer's clock updates only that small child.
The existing worker record and exit timestamp remain the timing authority.
Terminal input, command, worker lifecycle, protocol and persistent state are
unchanged. The terminal renderer itself is not remounted by duration ticks.

## Frozen behavioral comparison

The instrument mounts the production `ConversationTurnGroup` and
`ZaicodeWorkerTerminal` wrappers, the real conversation projection builder,
Radix collapsible and locale provider. Heavy row rendering and PTY/service
leaves are fixture boundaries; no live operator session or process is touched.
Chromium is controlled with a fixed clock and desktop/narrow viewports.
This proves the actual rendered React duration behavior, not a live PTY handoff
or full mobile transport end-to-end acceptance.

`T-191-ui/manifest.json` binds three source paths, all three instrument files,
and the preserved twelve-path T-188 subject. Standalone oracle SHA256:
`228430d66947dc5bb9be28b6aa310059c8692e44e7cb01a014516faa6b618b0f`.
Product base: `dbe0459259019308179c5b49e7e4f76a01fdecc7`.
Changed subject digest:
`032ac8cb6f7e95fc49c9bf9dbe8f5b0853e0d9f13f2d34bcd735a5a54169e49a`.

- RED `T-191-ui/before/report.json`: 20 requested footer checks fail, 11
  existing-header/lifecycle/input positive controls pass; zero page errors.
- GREEN `T-191-ui/after/report.json`: 31/31 checks pass, zero page errors.
- Independent REVIEW `T-191-ui/review/report.json`: 31/31 checks pass,
  zero page errors; source, oracle and all twelve parent paths still match.

Coverage includes over-two-hour running/completed/interrupted durations,
frozen terminal durations on successful and failed exits, guided segments,
collapsed history, unknown/control-only durations, localized hours, floating
and docked wrapper props, no terminal input injection/remount, stable chat
row renders during ticks, and a 375-pixel-wide viewport without page overflow.
The first exploratory expectations for the existing worker formatter and
Chinese hour unit were corrected from repository source before freezing and
re-establishing the final RED; exploratory evidence is not used for closure.

Reproduce: copy `T-191-ui/verifier.cjs` to
`V:/_TEMP_/playwright-test-t191.js`, start
`node .saipen/evidence/T-191-ui/serve.mjs` from the workspace root, then
run `node run.js V:/_TEMP_/playwright-test-t191.js` from the installed
Playwright skill directory. `T191_SUBJECT=dbe0459259019308179c5b49e7e4f76a01fdecc7`
on the server selects RED; omit it for current source. `T191_OUT` selects the
evidence directory and `T191_URL` overrides the isolated server URL.

## Repository gates

- Workspace freshness: local/published `zaicode` base in sync.
- `pnpm typecheck`: exit 0 (`T-191-ui/typecheck.txt`).
- `pnpm verify:pre-push`: exit 0 (`T-191-ui/pre-push.txt`); seven test
  suites, 1341 collected, 1339 passed, two skipped, zero failures. Lint 108
  warnings/zero errors; architecture zero baseline/new violations.
- Changed files formatted with repository oxfmt.
- First core pass ended FAIL on the current-tree evidence for historical
  T-113. The emitted canonical `work reverify T-113` executed as RV-000077
  PASS_WITH_CARRIED_DEBT. Pass two returned core CURRENT_PASS,
  `receipt-a906e111bc40`; raw result `T-191-ui/core-pass2.json`.
- No P0/P1 review finding. No durable knowledge promotion is justified by this
  local presentation change; the existing elapsed-time rule is already owned.

## Publication

The reviewed scope is exactly the two duration components and their product
specification, in the separate `zcode/` repository. Carrying commit:
`d427471cdfa44349a0f7937d2463486cb152768b`, published by a fast-forward push
to `origin/zaicode` and independently confirmed by `git ls-remote`. The index
was empty before staging; its saved tree was
`7aa773c0c7e5c5cc041e245eb8c5fc9c44ffe195`. The explicitly staged set matched
the three reviewed paths, staged/working source agreed and diff check passed.
Final prepublication core receipt `receipt-8ccd7fa30343` was CURRENT_PASS.
After publication, all twelve T-188 path hashes still matched. Unpublished
T-188 implementation, its package and foreign README/provider/default edits
remain preserved. No root release, version tag, packaged runtime installation
or operator app restart is claimed by this UI branch patch.
