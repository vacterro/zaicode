# T-53 evidence -- SRC-038: one-click installer + Autotroubleshoot

Operator's words (SRC-038 lines 10, 12, 30): installing must be as easy as
possible -- run the installer, wait, done, no actions, a shortcut waits, start
and code; ZAICODE, SAIPEN and SAIMAIL pulled automatically, fresh from GitHub,
all dependencies, reliable; on a problem an iron Autotroubleshoot that solves
install, use and deploy problems; several claude / codex subscriptions
without problems.

Ticket verify: installer script/exe built and run into a clean folder ends
with a working shortcut; Autotroubleshoot repairs seeded install faults; docs
updated.

## What was built

| Piece | Where |
|---|---|
| Installer | `install/Install-ZAICODE.ps1` (+ `Setup-ZAICODE.cmd`; `install/setup/ZaicodeSetup.cs` + `build.cmd` -> `ZAICODE-Setup.exe`, the scripts inside as resources) |
| Autotroubleshoot | `install/ZAICODE-Doctor.ps1` (+ `Doctor.cmd`), `-Repair`, `-Json`, `-JsonOut`, `-Only` |
| Checks and repairs (16) | `install/ZaicodeChecks.ps1`; mechanics `install/ZaicodeInstallLib.ps1` |
| Proof script | `install/tests/Test-ZaicodeInstall.ps1` |
| Launcher | `tools/launcher/ZaicodeLauncher.cs`: SAIPEN_HOME -> the install's `saipen\`; `.venv\Scripts`, `.tools\git\cmd`, `.tools\node` first on the app's PATH |
| Docs | `docs/ZAICODE_INSTALL.md`, root `README.md` (Install), IMPL section 31, KNOWLEDGE D-14 + commands + traps |

Operator words -> behaviour:
- "run, wait, done, no actions": one command / double-click; nothing asked; a
  re-run updates every clone and rebuilds what changed.
- "fresh from GitHub, all dependencies": shallow clones of `vacterro/zaicode`
  (workspace + main), `vacterro/saipen`, `vacterro/saimail`; Git, Node.js 24,
  Python and pnpm fetched as private copies when missing (no admin, no winget).
- "iron Autotroubleshoot": the installer IS the doctor's repair run on an
  empty folder, so every install step is also a repair.
- "several claude / codex subscriptions": every `~\.claude*` / `~\.codex*`
  home is listed (5 on this machine, all signed in); `-AddClaudeAccounts N` /
  `-AddCodexAccounts N` prepare more homes and print each login command.

## Clean install (2026-09-25, `V:\_TEMP_\zi2\ZAICODE`, Windows PowerShell 5.1, `-PortableTools`)

`T-53-install/install-run.txt`, `T-53-install/install-report.json`: one run,
9.8 min, exit 0. Portable MinGit 2.55.0.5, Node.js 24.14.0, Python 3.13.15
(NuGet), pnpm 10.33.2 downloaded; workspace, app, SAIPEN, SAIMAIL cloned;
SAIPEN launcher written; SAIMAIL installed into `.venv`; 9router from npm;
`pnpm install` 9 s (shared store); app bundle 9 min; launcher built; shortcut
created. Every check OK or FIXED; one WARN (below). 5.6 GB on disk.

## Proof (`T-53-install/test-install.json`, the installed copy's own script)

1. fresh install: doctor passes -- PASS
2. doctor reports every seeded fault (shortcut deleted, launcher deleted,
   SAIPEN launcher -> missing Python, `.venv` deleted, node_modules recorded for
   another lockfile, `dist\win-unpacked.previous` deeper than MAX_PATH) -- PASS
3. `doctor -Repair` fixes all six (FIXED each) -- PASS
4. after repair: doctor passes -- PASS
5. shortcut starts ZAICODE: launcher PID 48088 -> app PID 41396 from the
   install, isolated profile written; only that process tree stopped (by PID) -- PASS

Also: `ZAICODE-Setup.exe` run against the install -> 17 checks, exit 0; a
re-run after a workspace push -> "updated workspace 36b2ad17 -> 5495d691",
launcher rebuilt, 0.1 min. A first attempt (`V:\_TEMP_\zi`) exposed four
faults, all fixed and re-proven: tools created before the workspace clone
made the root "not empty"; the SAIPEN renderer is missing from the public
SAIPEN; a no-op `pnpm install` leaves `.modules.yaml` untouched (now a
lockfile SHA-256 marker); `Get-FileHash` hidden from 5.1 by a PS7
PSModulePath (now .NET SHA256). That half-failed install was then repaired in
place by `ZAICODE-Doctor.ps1 -Repair` (4 FIXED) -- Autotroubleshoot on a real
failure, not only seeded ones.

## Honest gaps (external; ticket T-62, OPERATOR_REQUIRED)

- `vacterro/saimail` main is 0.0.1 without `saimail-local` (the CLI ZAICODE's
  SAIMAIL panels call); it exists only as uncommitted work in `__SAIMAIL__`.
  The installer reports WARN "the published SAIMAIL (0.0.1) has no
  saimail-local yet"; it installs as soon as a release ships it.
- `vacterro/saipen` main is v8.0.1, 132 commits behind the local SAIPEN; the
  installer writes its launcher without the newer renderer. Works; older.
- `ZAICODE-Setup.exe` is built locally (ignored by git); hosting it (a GitHub
  release) is the operator's call.

Gates: all four scripts parse with Windows PowerShell 5.1 and pwsh 7; the
launcher compiles (`tools\launcher\build.cmd`, exit 0); no app code changed
in this ticket.
