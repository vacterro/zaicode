# T-194 verification

Owner: T-194 / saipen-cli. Separate product repository: `zcode`, branch `zaicode`.
Current base: `c21dfde1f2380e1a483a5bfca95f687e520dc690` (the independently shipped T-196 lint repair).
Implementation has not been reviewed or published as T-194 yet.

## Subject and preservation

`T-194-subject-final.json` freezes 49 owned paths and 18 foreign paths.
All 12 frozen T-188 paths match their inherited hashes. The foreign saved
settings export is preserved at its operator-updated hash recorded by T-196;
it is excluded from this ticket's scope. No broad staging or restoration.

## Requirement evidence

| Source clause | Concrete result | Actual verification |
| --- | --- | --- |
| SRC-129:R001 | Deterministic provider-visible extension and built-in tool ordering preserves identical prefix bytes across reversed discovery, without changing schemas or causal history. Existing cache breakpoints/accounting retained; vendor cache-hit guarantees and paid warm-ups are not claimed. | `zaicodePromptCacheOrder.test.ts`: 2 PASS in the full suite; the prior pre-fix order control failed. Research and limits are in the product spec. |
| SRC-129:R002 | Project labels repeatedly open meaningful MAIN; an empty MAIN never wins a fallback. Named MAIN survives working-only filters; a separate accessible chevron folds without changing the conversation; an empty project opens a draft. | Actual production React browser, 4 viewport/layout variants; restored six pre-fix production files: 28 FAIL/17 positive controls, current:45 PASS/0 errors. An intermediate missing-chevron regression produced 4 FAIL/41 positive controls before the button was added. |
| SRC-129:R003 | Repeated not-satisfied goal control notices and their empty turns are hidden in presentation; errors, verification failures and successful completion remain. | `zaicodeEfficientAutomation.test.ts` exercises the real turn-render-unit builder, retaining failed/pass controls and original input rows; pre-fix UI unit control failed. |
| SRC-129:R004 | The actual sessions-index derives test-command activity from live tools/background work. Project/session/timeline TEST marks have independent motion preferences. Completion clears marks. | Bootstrap projection:3 PASS; UI behavior:8 PASS; actual browser covers project/session/timeline presence, command tooltip, independent motion and clearing. |
| SRC-129:R005 | Ended foreground work cannot continue animating from stale phase data; genuine quiet background work remains Working, including after five hours. Runtime death invalidates local live reports. | Real row mapping/activity predicates and bootstrap lifecycle tests, browser ending controls, preserved unproven-foreground stall positive control. |
| SRC-129:R006 | The existing persisted Scheduler owns delayed vendor limit handoffs, ordered selected subscriptions/in-app SAIFREN, fresh quota recovery, exact execution leases, restart idempotency, cancellation and stop time. A slow preparation cannot dispatch after its latest deadline. | Continuation decisions:5 PASS; actual executor:6 PASS, including unchanged deadline oracle RED1/5 positive controls then GREEN6; dispatch host:3 PASS; vendor signal parsing:4 PASS; browser exact SAIFREN selection/reordering, delays and enable/disable callbacks. No live paid vendor recovery was claimed. |
| SRC-129:R007 | Recognized startup folder/hooks menus are trusted on owned live terminals without run-age/answer-count cutoffs; delayed answers recheck identity, generation, control ownership and current menu. | Actual terminal watcher:4 PASS, including five-hour-old and repeated menus, transferred/exited/replaced terminals, redraw/prose negatives and cancelled dispatch. |

## Mandatory gates

- Root typecheck: exit 0 (`T-194-typecheck-deadline-final.txt`).
- CLI typecheck:27 successful tasks; implementation files unchanged by the later UI deadline fix (`T-194-cli-typecheck-final.txt`).
- Root lint:162 warnings/0 errors (`T-194-lint-deadline-final.txt`).
- Forced CLI lint:14 successful tasks,0 cached,0 errors (`T-194-cli-lint-final.txt`).
- Architecture:0 violations (`T-194-architecture-deadline-final.txt`).
- Full repository suite:1474 PASS/2 skipped/0 FAIL,1476 tests collected (`T-194-full-tests-deadline-final.txt`).
- Actual browser:45 PASS/0 errors (`T-194-ui-green.json`).
- Subject/foreign identity after gates:67 checked,0 changed (`T-194-gates-final.json`).
- Fresh packaged desktop build and isolated boot: exit 0; 28 Settings sections,
  3 ProTrail monitors, live customization0->1->2->0, four locales and Russian
  locale restart,0 renderer exceptions/0 console errors (`T-194-bundle-proof.json`).
- Fresh CLI source/staged/packaged bundles have the same SHA256
  `9548b66a7a42701f01443992bb69069fe6d38468e7426d3757599d4a459150f2`.
- The local candidate installer is
  `zcode/packages/desktop/.release-work/t194-20261003-2310/ZAICODE-3.14.0-win-x64_TEST.exe`
  (199656530 bytes, SHA256 `594d254486ae73ce80d771578c164b098ca47355b98daa74d938eb78b083862a`).
  It is isolated from the live/staged launcher paths and has not been published.

## Reproducible UI oracle

Frozen browser program: `T-194-ui/browser-oracle.js` (byte-identical to the OS
temporary script run with the installed Playwright skill). `T-194-browser-regression.json`
binds the program, actual React fixture and esbuild server hashes. The subject
selector restores exactly six UI production files from `dd9c0e9` using esbuild
onLoad, without replacing the live working tree. Known-good controls render
successfully, and both subjects have zero browser errors. Fixtures only replace
host I/O leaves; the actual sidebar, task rows, test indicators, preferences and
Scheduler continuation component render and respond to clicks/keyboard input.

For independent review restart `node .saipen/evidence/T-194-ui/serve.mjs` from
the project root, copy the frozen oracle to the OS temp directory and execute
through the Playwright skill's `run.js`. Set `T194_UI_URL` and
`T194_EVIDENCE_PREFIX`; keep all other oracle/fixture bytes unchanged.

## Pending separate requests

T-197 through T-206 are preserved, unimplemented, independent user intakes:
unseen completion, Ctrl+Click Scheduler account toggles, themed native controls,
empty Worker panel collapse, composer Auto retry scopes, unresponsive Worker
controls, settings keyword search, project Auto-Goal, Usage refresh/column sizing,
and moving secondary/game settings last in default-collapsed disclosures.
They are not discharged by this ticket or silently included in its scope.
