# ZAICODE workspace

<p>
  <img src="https://img.shields.io/badge/version-0.0.1-c9a227" alt="version 0.0.1" />
</p>

This branch is the root of a ZAICODE checkout: the launcher that starts the
packaged app, the product documentation and the SAIPEN project memory. The
application source is the `main` branch (cloned into `zcode/`).

| Path | What |
| ---- | ---- |
| `ZAICODE.exe`, `tools/launcher/` | root launcher: ZAICODE mode, crash restart, staged build swap (`tools\launcher\build.cmd`) |
| `REBUILD.cmd` | typecheck + bundle; a running app gets the new build on its next start |
| `install/` | one-click installer and Autotroubleshoot (see Install) |
| `UI.md` | what the interface does and why |
| `docs/` | architecture, implementation notes per release wave, upstream delta ledger |
| `.saipen/` | SAIPEN memory: board, log, sources, knowledge |
| `VERSION`, `CHANGELOG.md` | release identity and notes |

## Install

One click, then wait: `install\Setup-ZAICODE.cmd` (or `ZAICODE-Setup.exe`
built by `install\setup\build.cmd`). From nothing, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/workspace/install/Install-ZAICODE.ps1)))
```

It clones ZAICODE, SAIPEN and SAIMAIL from GitHub into `%USERPROFILE%\ZAICODE`,
fetches a private copy of Git, Node.js 24 or Python when the machine lacks
them, builds the app and puts a ZAICODE shortcut on the desktop and in the
Start menu. Something broke later: `install\Doctor.cmd` (Autotroubleshoot)
checks every piece and repairs it. Details: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

| Path | What (install layout) |
| ---- | ---- |
| `install/` | installer, Autotroubleshoot, their checks (`ZaicodeChecks.ps1`) |
| `zcode/`, `saipen/`, `saimail/` | the three clones |
| `.tools/`, `.venv/` | private Git / Node.js / Python / pnpm, SAIMAIL's venv |

Developer setup by hand: clone the `main` branch into `zcode/`, then follow
its README (`pnpm bootstrap`, `pnpm bundle:zaicode`) and start `ZAICODE.exe` here.
