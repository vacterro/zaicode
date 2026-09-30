# Installing ZAICODE

ZAICODE is three projects that work as one: the ZAICODE app, SAIPEN (the
protocol that keeps agent work on track) and SAIMAIL (the mail agents use to
tell each other things). Installing them by hand means three clones, a Node.js
toolchain, a Python environment and a build. The installer does all of it:
run it, wait, and a ZAICODE shortcut is on the desktop.

## One click

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  download, double-click, press **INSTALL**. The window (gold on dark, the
  SAIPEN banner) shows every step as it runs, the time so far and the log on
  demand; at the end **START ZAICODE**, or **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** when a step did not finish. Pointed at an existing ZAICODE
  folder the button reads **UPDATE**: the same run updates and repairs. The
  exe carries the install scripts and needs nothing next to it; it is built by
  `install\setup\build.cmd` (the .NET Framework compiler every Windows 10/11
  has).
- `install\Setup-ZAICODE.cmd` (double-click): the same install in a console.
- From nothing, in PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Setup options: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (preset folder),
`/auto` (starts at once), `/quiet` (no window: the console installer, exit code
= result). The first run builds the app on this machine, which takes a while;
later runs only update and repair.

## Free models, nothing to set up

The app ships its own 9router. On a machine without one ZAICODE runs it
privately (isolated mode, port 20138), fills **SAIFREN** from keyless free
tiers and makes `SAIRoute / SAIFREN` the model of new tasks, so the first task
typed into New task gets an answer: no key, no account, no setting. Claude
Code, Codex and Antigravity logins are optional; a login never set up on the
machine shows as "optional, sign in any time", not as a "needs you" item.
Proof: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
starts the packaged app on an empty profile (its own HOME, APPDATA and
LOCALAPPDATA) and passes only when the router is isolated, SAIFREN answers its
first-token probe and a task in New task is answered.

## Updates: four parts, one ZAICODE

The workspace (launcher, installer), the app, SAIPEN and SAIMAIL are four
clones. Each one updates on its own: **Settings -> ZAICODE -> Updates** lists
them with their version and commit, updates one by hand or all of them, and
has a "by itself" switch per part (on by default in an installed ZAICODE, off
in a developer checkout). ZAICODE looks a few minutes after the start and then
every six hours. After an update each part gets what it needs: the app its
dependencies (when `pnpm-lock.yaml` moved) and a new build (staged while
ZAICODE runs, started on the next start), SAIPEN its launcher, SAIMAIL its
`.venv` install, the workspace a new root launcher. A clone on another branch,
with local commits, or with edits the update would overwrite is reported and
left exactly as it is.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## What it does

The installer is the Autotroubleshoot checks run with "repair" on an empty
folder, in this order. Each step is idempotent, so running it again updates
the install and fixes what broke.

| Check | Repair |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | uses the machine's copy when it fits; otherwise a private copy in `.tools\` (MinGit from Git for Windows, Node.js 24.14.0 from nodejs.org, Python from its NuGet package). No administrator rights. |
| pnpm | the pinned pnpm 10.33.2 in `.tools\pnpm10` |
| ZAICODE workspace | clone of `vacterro/zaicode` branch `master` (launcher source, installer, docs; the developer's `.saipen/` memory is left out; branch `workspace` until 2026-09-27) |
| ZAICODE app source | clone of branch `zaicode` into `zcode\` |
| SAIPEN | clone of `vacterro/saipen` into `saipen\`; its `bin\saipen.cmd` is written for this clone and this Python |
| SAIMAIL | clone of `vacterro/saimail` into `saimail\`, installed into `.venv\` |
| saimail-local | SAIMAIL's command-line client, which ZAICODE's SAIMAIL panels use (shipped since SAIMAIL `0.0.2a3`; the `saimail-cli` check reports OK) |
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

`install\tests\Test-ZaicodeUpdate.ps1` builds four throw-away repositories on
disk and an install of their clones, then proves that a check changes nothing,
that one part updates alone with its follow-up (SAIPEN launcher, root
launcher), that overlapping local edits and local commits are kept, and that an
unknown part name is refused. No network.
