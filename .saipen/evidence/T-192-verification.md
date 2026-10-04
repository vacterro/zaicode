# T-192: transfer a live CLI worker to PowerShell

SRC-127 requires one-way transfer of the already running CLI process, retaining
its state across ZAICODE quit/restart. The product contract is
`zcode/specs/zaicode-worker-powershell-handoff.md`.

The independent broker owns the PTY from worker creation. The authenticated
external console commits exclusive ownership only after it is ready. The UI
then removes its worker presentation; disposal cannot stop the transferred PTY.
Failures retain app ownership, concurrent clicks share one attempt, and stale
generation callbacks cannot remove a replacement worker. Closing the external
window stops only its own shell subtree. Other terminal kinds and platforms
keep the existing owner. Existing workers from older binaries cannot be
retroactively transferred.

## Final subject and preserved work

The exact fifteen-path subject is `T-192-subject.json`, fingerprint
`c4b2ee10200ad4632c8aff4b6b8a17d45bca90da0c04e90b8f10ec84c4f85770`,
based on product HEAD `d427471cdfa44349a0f7937d2463486cb152768b`.
All eighteen foreign dirty files, including all twelve T-188 frozen paths,
remain byte-identical. No operator application or worker was stopped for testing.

## Behavioral evidence

- Frozen native oracle SHA256
  `10a534171e95f311bf6d3d9dd581e80a6a2c6cc2a6e92dc23e2d583c625ef0b1`:
  pre-fix `T-192-native-red-final/receipt.json` has three required failures and
  working positive controls; `T-192-native-resize/receipt.json` has eight passes.
  Independent final REVIEW `T-192-native-review-release/receipt.json` also has
  eight passes with the unchanged oracle. The first independent review exposed
  a real exit/resize race (seven passes/one failure), preserved in
  `T-192-native-review-dll/receipt.json`. Diagnostic traces show external pipe
  close immediately after resize, before the original PTY exit. The specific
  node-pty already-exited resize error now retains the pipe until `onExit`.
  A tentative acknowledgement change did not fix this and was removed.
- Actual production React menu/control oracle SHA256
  `d17cba028440b122a03b2dd5bb1c3e92286e41d7cc6497551ec0575dff850cb2`:
  `T-192-ui/review-red/receipt.json` has twelve failures; unchanged
  `T-192-ui/review/receipt.json` has thirty-five passes. Covers successful/failed
  handoff, capability/start/exit guards, deduplication, stale generation, and
  unchanged original command and registry lifetime.
- The mandatory service Unicode assertion remained unchanged through the last
  fix. `T-192-unicode-dll.txt` has two passes. Wire and owner controls proved full
  Cyrillic/emoji reaches `pty.write`; the bare PowerShell/PSReadLine 2.4.5 control
  loses emoji with system ConPTY and preserves it with the bundled DLL. The
  broker now uses that existing DLL, with explicit own-process exit after
  socket flush/server close/config cleanup. Baseline and traces remain in
  `T-192-unicode-pty-baseline.json`, `T-192-unicode-trace.json`, and
  `T-192-unicode-owner-control.json`.
- Frozen packaged oracle SHA256
  `53952960d68becd1dccba298180dd9c6c3e6b12761eda810cf269f1bc11232f1`:
  `T-192-packaged-stop/receipt.json` retains the actual ENAMETOOLONG failure;
  `T-192-packaged-release/receipt.json` has five passes. The actual shipped factory
  and broker open a visible interactive PowerShell; the same CLI PID and UUID
  continue with a strictly advancing counter after forced packaged-host termination.
  Fixture exit completes the original shell with no second CLI.

Earlier failed gates and preview packages remain preserved. Source-side injected
clients did not prove GUI Electron console stdio; the actual packaged check
exposed that defect. A single PowerShell/.NET native Unicode console path now
ships, and its already encoded payload is not encoded again by the short
launcher. Occasional node-pty cleanup `AttachConsole failed` diagnostics do not
change successful assertions/exit codes and are not claimed absent.

## Repository and package gates

- `T-192-typecheck-resize.json` and `T-192-build-resize.json`: exit 0.
- `T-192-pre-push-resize.json/txt`: exit 0; 1343 passes, two skips, zero failures;
  lint 108 warnings/zero errors; architecture zero violations.
- `T-192-bundle-final.json/txt`: exit 0, fresh package built from the final source
  using the already prepared runtime assets and completed production build.
  The mandatory boot gate ran: 28 Settings sections, three monitors, live
  customization 0 to 1 to 2 to 0, zero uncaught/console errors. Vendor window
  starts are disabled in the verified scratch userData profile.
- Package directory: `zcode/packages/desktop/dist-test-20261003-t192-final`.
  Packaged `app.asar` SHA256
  `d06d516feefe4687f7aed8991436c484747cb70bd237ed7815705fe0978ace9b`.
- Canonical historical core reverify: RV-000078, executed
  PASS_WITH_CARRIED_DEBT (one inherited problem, 27 warnings), retained without
  rewriting historical T-113 evidence.

SRC-128's pass3 preview delivery and actual stop were fulfilled before new
SRC-129/SRC-130 user instructions reauthorized continuation. Its preview guide
now references the immutable pass3 manifest rather than the subsequent working
subject. This final package supersedes that preview's known Unicode limitation;
it does not rewrite the old preview or its verdict.

## Review and publication

Independent native and Unicode reruns, exact-scope review, final canonical core
gate and carrying commit are recorded separately before ticket closure.

Carrying commit `6fa72c2959567c01f72dc6c2058a5b01217bed4d` was published to
the established product `origin/zaicode`, then independently confirmed by
`git ls-remote`. The empty pre-ship index was saved; the fifteen staged paths
matched the manifest and `git diff --cached --check` passed. Canonical core
reported CURRENT_PASS with zero blocking findings (27 inherited warnings).
T-192 closed as own_patch in E-3148; SRC-129/SRC-130 remain active new work.
