# T-186 verification: Scheduler, Collect and redundant hints

Source: SRC-123, exact duplicated user message retained in
`.saipen/incoming/20261003-scheduler-auto-hover.md`. Three distinct requests;
the Collect loop is the user's P0. Implementation is in the separate `zcode/`
repository. No protocol-home files or another ticket owner's seat changed.

## Behavior and cause

- Collect: the old composer-local signature was cleared every time submission
  disabled the composer. Reopening it submitted the same ready producer again.
  The application guard now admits a producer's recorded package generation
  once per canonical workspace identity. Busy/draft cycles, Auto toggles,
  remounts and old-package reappearance retain admission. New packages and
  remote identities remain independent. False/throwing local sends roll back
  admission; manual Collect remains an explicit retry. Accepted queues remain
  owned by the existing submission path.
- Scheduler: host job-service Autopilot is the launch gate and source of truth.
  Its existing store projects confirmed state and rejects late reads, including
  full queue refreshes. Automatic scheduler ticks read the host gate before
  consuming occurrences. Stop rules still run while off. Scheduler's visible
  warning/action, rows, sidebar and SAIHOME expose OFF/paused state; the Now
  card stops presenting an unconditional countdown. Manual Run now remains
  explicit. Existing catch-up/missed semantics remain in the evaluator.
- Hints: the shared primitive suppresses a string title only when it repeats a
  fully visible label and has no description/shortcut. Icon-only, hidden,
  horizontally clipped and vertically clamped text retain useful hints.
  Keyboard focus and plain-text trigger refs are covered.

## Frozen regression instrument

Playwright 1.62.1, real React/hooks, Chromium, fixed clock and 1100x700 viewport.
Actual production chip, scheduler runner/page/sidebar, SAIHOME Scheduler and
shared Radix hint primitive are mounted. External service/projection leaves
are fixtures; no live user session, accepted inbox or host queue is mutated.
This does not claim a mobile end-to-end run or an overnight real-time soak.

`T-186-ui/manifest.json` binds all 16 product paths and the three verifier files.
Verifier SHA256: `807ef59aa26002adb0812a3f432d3fc812155e1a26d51c8c69b41bece301a7b0`.
Pre-fix subject: `1f65c4cdada05c2e7e8ffe99dcc6c349cf14bad3`.
Post-fix subject digest: `690d96dc17a50b76a03801fb4b5c63e12ebc6ea63c4f062f7c7a3652b2d6633c`.

- RED: `T-186-ui/before-final/report.json`, exit 1; 18 failures and 13 positive
  controls pass, zero page errors. The real old runner launches with Autopilot
  off; twelve busy cycles enqueue thirteen identical Collect commands; the
  visible label repeats on hover and keyboard focus.
- GREEN: `T-186-ui/after/report.json`, exit 0; 31/31 checks, zero page errors.
  The actual runner pauses without consuming an occurrence, launches once
  after enabling and still applies its stop rule while off. The page's Enable
  Autopilot action is exercised, alongside paused rows/sidebar/SAIHOME.

Earlier exploratory fixture revisions are not spent as regression evidence.
The runtime fixture initially used an ISO string where `at` requires epoch
milliseconds; its known-good launch exposed that instrument failure. A later
local-rejection scenario accidentally retained the previous remote identity;
the corrected input explicitly restores local identity. Both corrections and
the expanded positive controls precede the final paired RED/GREEN runs above.

Reproduce: copy `T-186-ui/verifier.cjs` to the Windows temporary directory,
start `node .saipen/evidence/T-186-ui/serve.mjs` from this project root, and run
the temporary script via the installed Playwright skill's `node run.js PATH`.
Set `T186_SUBJECT=1f65c4cd` only for the red subject; omit it for current source.
`T186_OUT` changes only the evidence destination. Stop the isolated server
between subjects. Production files are never reverted for the control.

## Repository gates

- Focused native regression and adjacent tests: 34/34 PASS, including eight
  new behavioral cases and stale host-read races.
- `pnpm verify:pre-push`: exit 0; lint 108 warnings/0 errors, architecture
  0 violations, seven test suites: 1328 discovered, 1326 PASS, 2 skipped,
  0 failures. Raw output: `T-186-ui/pre-push.txt`.
- `pnpm typecheck`: exit 0 on final source; `T-186-ui/typecheck.txt`.
- `pnpm build:zaicode`: exit 0; production host/renderer built. Existing
  chunk-size warnings remain visible in `T-186-ui/build.txt`.
- `pnpm bundle:zaicode --skip-build --skip-prepare`: exit 0; 190.4 MiB
  installer, runtime dependency closure and packaged boot PASS. Boot mounted
  the workspace shell, opened 28 Settings sections and reported zero uncaught
  exceptions/console errors. Receipt copied to `T-186-ui/boot-receipt.json`;
  the new package is staged in `zcode/packages/desktop/dist-next/`.
- Independent REVIEW rerun: `T-186-ui/review/report.json`, 31/31 PASS. All
  16 subject files, six foreign files and frozen instrument still matched
  recorded hashes. No P0/P1 review finding.
- Root conformance first reported one expired legacy T-113 closure receipt.
  This ended the first verification pass; canonical `work reverify T-113`
  executed its declared contract as RV-000073 PASS_WITH_CARRIED_DEBT. A new
  pass returned CURRENT_PASS, zero blocking findings/27 warnings. Final
  pre-publication core check also returned CURRENT_PASS, zero findings.

## Publication

Carrying commit: `0cda0488466aebd07ec6cec92d9226d0054d0ee5`, in the separate
`zcode/` repository. Exactly 16 reviewed paths were explicitly staged, the
index was checked against the manifest, and staged/working bytes agreed.
Saved pre-stage index tree: `5618366c1463349c9a3144cd7203797443f0a123`.
Fast-forward branch push `1f65c4cd..0cda0488` landed on `origin/zaicode`;
`git ls-remote origin refs/heads/zaicode` independently returned the carrying
commit. This is a product branch patch and local staged package, with no
synthetic root release, version bump or tag. Foreign changes remain local.

Foreign README/provider-node/release-default file hashes are preserved in the
manifest. Before replacing generated staged output, the prior verified package
and its receipt/installer were moved to `zcode/.release-work/T-186-prior-stage`
using checked absolute paths. The running application remains in `dist/`.
The new staged package requires a normal app restart through the root launcher.
