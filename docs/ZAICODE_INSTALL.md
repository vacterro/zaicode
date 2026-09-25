# Installing ZAICODE

ZAICODE is three projects that work as one: the ZAICODE app, SAIPEN (the
protocol that keeps agent work on track) and SAIMAIL (the mail agents use to
tell each other things). Installing them by hand means three clones, a Node.js
toolchain, a Python environment and a build. The installer does all of it:
run it, wait, and a ZAICODE shortcut is on the desktop.

## One click

- `install\Setup-ZAICODE.cmd` (double-click), or `ZAICODE-Setup.exe` (built by
  `install\setup\build.cmd`; it carries the scripts inside).
- From nothing, in PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/workspace/install/Install-ZAICODE.ps1)))
  ```

Nothing to click on the way. The first run builds the app on this machine,
which takes a while; later runs only update and repair.

## What it does

The installer is the Autotroubleshoot checks run with "repair" on an empty
folder, in this order. Each step is idempotent, so running it again updates
the install and fixes what broke.

| Check | Repair |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | uses the machine's copy when it fits; otherwise a private copy in `.tools\` (MinGit from Git for Windows, Node.js 24.14.0 from nodejs.org, Python from its NuGet package). No administrator rights. |
| pnpm | the pinned pnpm 10.33.2 in `.tools\pnpm10` |
| ZAICODE workspace | clone of `vacterro/zaicode` branch `workspace` (launcher source, docs; the developer's `.saipen/` memory is left out) |
| ZAICODE app source | clone of branch `main` into `zcode\` |
| SAIPEN | clone of `vacterro/saipen` into `saipen\`; its `bin\saipen.cmd` is written for this clone and this Python |
| SAIMAIL | clone of `vacterro/saimail` into `saimail\`, installed into `.venv\` |
| saimail-local | SAIMAIL's command-line client, which ZAICODE's SAIMAIL panels use (WARN until the published SAIMAIL ships it) |
| 9router package | `9router` from npm into `.tools\router`, bundled so SAIFREN works with zero setup (WARN if npm cannot reach it) |
| App dependencies | `pnpm install --frozen-lockfile` (again when `pnpm-lock.yaml` changes) |
| App build | `pnpm bundle:zaicode`; while ZAICODE runs the new build is staged and swapped in on the next start |
| Staged build swap | clears a `win-unpacked.previous` left behind by a long-path swap failure and swaps a waiting build in while ZAICODE is closed |
| Root launcher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Shortcuts | Desktop and Start menu `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex logins | reported only: every `~\.claude*` / `~\.codex*` login is its own engine in ZAICODE (A1, A2, C1, ...); a login needs you, in the browser |

The root launcher points ZAICODE at the installed SAIPEN (`saipen\`) and puts
`.tools\` and `.venv\Scripts` first on the app's PATH, so the app, its agents
and its workers use the installed copies.

## Several subscriptions

Every Claude Code or Codex login lives in its own home: `~\.claude`,
`~\.claude-account2`, ... and `~\.codex`, `~\.codex-account2`, ... ZAICODE finds
them all. To prepare more at install time:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

The installer creates the homes and prints the exact login command for each
(`$env:CODEX_HOME = '...'; codex login`). The same is in ZAICODE: Settings ->
Engines & limits -> add another login.

## Autotroubleshoot

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status per check: OK, FIXED (was broken, repaired), WARN (works, but something
optional is missing), INFO (needs you: a login), FAIL. Logs are in
`install\logs\`; the last install's summary is `install\install-report.json`.
In the app, Router -> Autotroubleshoot repairs the running router and pools.

## Options

| Parameter | Default | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | where everything goes |
| `-ShortcutDir` | Desktop | where the ZAICODE shortcut goes |
| `-NoStartMenu`, `-NoShortcut` | | skip those shortcuts |
| `-PortableTools` | | private Git / Node.js / Python even when the machine has them |
| `-Launch` | | start ZAICODE when done |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | the GitHub repos | another source (a fork, a local clone path) |

## Proof

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
checks a fresh install, seeds faults (shortcut and launcher deleted, SAIPEN
launcher pointed at a missing Python, SAIMAIL's venv deleted, node_modules
recorded for another lockfile, a leftover build folder deeper than MAX_PATH),
asserts the doctor reports and repairs every one, then starts the shortcut's
target with an isolated profile and stops exactly the process tree it started.
