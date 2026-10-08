# Scheduler investigation and bounded window starter

Source requests: SRC-171 through SRC-176, plus the preserved T-267 account-switch fix.
Product repository: `zcode/`, branch `zaicode`, base `e5389320`.

## What happened while the operator was away

The copied Chromium LocalStorage records contain these last schedule attempts
(Europe/Tallinn, UTC+3):

| Schedule | Recorded attempt | Recorded result |
| --- | --- | --- |
| SAIPEN / A1 | 2026-10-07 21:40:09 | project switched off |
| ZAICODE / C1 | 2026-10-07 16:45:40 | project switched off |

Both target projects were in the disabled-project list. The old scheduler
consumed those reset occurrence ids and advanced lastRunAt before checking
project admission, while its visible readiness ignored the project switch.
These records demonstrate blocked attempts, not successful project work.
The historical `runs` array alone cannot prove whether every CLI worker ran:
older CLI dispatch does not append every run to that array.

There is no recorded C1 schedule attempt for the following 21:45 refill in the
captured records. The quota cache separately records a successful C1 window
starter at 21:46 and the next reset at 02:45. This is compatible with the
reproduced race: a vendor read can advance resetsAt before the scheduler's
60-second safety delay, erasing the occurrence it was waiting for.

Evidence: `T-268-forensics/scheduler-history.json` and
`T-268-forensics/c1-quota-metadata.json`. The main log lacked the old scheduler's
admission/dispatch lifecycle events; that omission is also fixed.

## Resulting behavior

- OFF targets show their actual blocked reason. A blocked target does not
  consume its occurrence, disarm a one-shot job or claim an actual run time.
  Re-enabling within catch-up allows one attempt; expiration stays missed.
- The existing quota snapshot owner retains the last observed real vendor
  reset for the same account, exact window key and quota pool. The scheduler
  evaluates the unconsumed boundary before the next reset, including across
  cache serialization. It never synthesizes intermediate resets or turns an
  idle sliding timer into refill evidence.
- Automatic ticks await dispatch and log metadata-only admission, dispatch
  and outcome events.
- Sidebar dragging snaps to 264 px within 12 px in either placement. Reading
  a stored custom width does not rewrite it.
- A second STATE click closes the same visible pane; collapsed panes reveal,
  and another project's target replaces the old one. The draft inspector
  reserves layout width so the trigger remains reachable by a real pointer.
- Selecting A2 makes both the quota watch and actual resumed worker use A2;
  visible activity follows the actual leased worker.
- An exhausted Antigravity Claude/GPT pool does not block an independently
  usable Gemini pool. Same-pool weekly exhaustion remains a valid gate.

## Minimal window-start request and practical limits

Claude's installed CLI receives an eight-token provider output ceiling,
thinking off, no tools/MCP/user hooks, no API retries and a $0.005 budget.
The original one-token ceiling caused four automatic length continuation
requests. Eight tokens allow the one-word completion to terminate.

Codex uses a minimal instructions file, low effort/verbosity and an output
schema allowing only `{"ok":true}`. Antigravity uses an actually advertised
small model for the selected pool, the same fixed schema and a 30-second
print deadline. ZCode retains provider `max_tokens: 1` on its trusted Coding
Plan endpoint. Cooldown/admission stay in the existing persisted owner.

These bounds do not guarantee zero input or hidden reasoning tokens. The
installed Codex and Antigravity CLIs do not expose a universal provider-side
output-token ceiling equivalent to Claude's. No fake local five-hour countdown
is used: a later vendor quota read must prove the fixed reset.

Metrics-only shared Antigravity rows represent another Windows logon identity.
They carry the local single-login CLI path, so the old starter could run the
wrong account under another row's name. Both admission and execution now reject
that path. The existing T-176 identity-isolation evidence also describes this
provider limitation. Rolling such a remote identity requires an execution
owner in that Windows context; this patch cannot create that login capability.

## Verification

- Frozen T-268 original/fixed comparison: same 16 tests and verifier; original
  UI/desktop exits 1/1, fixed 0/0. Oracle:
  `41ba687ccd37641ca9000d81d321157c5e650f240fa40841e0cd9a84cfc57eb0`.
- Preserved T-267 original/fixed comparison: same 16 tests; original 9 failures,
  fixed 16 passes. Oracle:
  `592e5081ff1f885a35e90cb9e792323e4e436143a4101b8a89a8356fda6940f9`.
- `pnpm typecheck`: PASS.
- `pnpm verify:pre-push`: PASS; architecture OK, lint zero errors,
  1,990 tests collected / 1,984 passed / six existing skips / zero failures.
- `git diff --check`: PASS.
- Installed Claude CLI against an isolated HTTP fixture: one request,
  `max_tokens: 8`, zero tools, thinking absent, one output token. This is a
  wire-format check, not a live provider billing measurement. Native fixtures
  disable paid window starts and use a local fake worker. Repository tests
  also contain their existing real-free-provider checks.
- Current native verifier hash:
  `38a69911d1d13acfdb0d630405da9b9de531accab9e7bf86f8f015e726da3406`.
  The unchanged original packaged app fails the snap assertion as expected.
  Final packaged EXE acceptance: 13/13 PASS, including the actual A2 worker
  lease and one prior-reset dispatch despite an advanced quota snapshot.
  Receipt: `T-268-native/final-packaged/receipt.json`.
- Independent final review: 32 targeted tests PASS; both final source hashes
  and both frozen oracles match their original/fixed comparison receipts.
  The packaged native receipt binds the current verifier and ASAR bytes.
  Receipt: `T-268-review.json`.
- Final `pnpm bundle:zaicode --skip-prepare`: PASS; packaged boot opens 28
  Settings sections, draws ProTrail on three monitors and exercises live
  customization with zero uncaught exceptions or console errors.
  Installer size: 214,201,855 bytes (204.3 MiB).
  Artifact hashes: `T-268-build-receipt.json`.
  ASAR SHA256:
  `f022ae667282a4380ef5d832d5a74d51949743575aa2ccfa8d629654e7dc1c06`.

The graph generation was 2026-09-23 and did not track the newer ZAICODE files.
Relevant coverage checks were followed by exact source reads; graph absence
was not used to claim exhaustive discovery.

## Delivery and protocol state

The running user app and its sessions were preserved. The requested build is
staged in `zcode/packages/desktop/dist-next/`; the root ZAICODE launcher applies
it on the next start. Automatic project work still requires the user's project
switch to be ON, Autopilot ON, and the app running.

No commit, push or external publication was performed. The canonical workspace
validator has three inherited failures (SRC-151 invalid activity, old T-113
closure evidence, and a producer write-boundary record). They are unrelated to
the product test results and were not rewritten to force a protocol PASS.
Ticket lifecycle evidence remains in the canonical BOARD/STATE/LOG.

After the independent REVIEW pass, 26 exact reviewed paths were bound to T-268.
`saipen ship --dry-run --json` produced a plan with `writes: none`; its automatic
metadata list contains 1,109 paths in addition to the reviewed product scope.
No release execution or staging occurred. T-268 is parked with
`PUBLICATION_CORE_GATE`, retaining the verified local build. T-269/270/271/273
have explicit verification checkpoints. T-272 records the remaining other-logon
execution limitation rather than claiming that all remote windows now roll.
