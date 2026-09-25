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
| `UI.md` | what the interface does and why |
| `docs/` | architecture, implementation notes per release wave, upstream delta ledger |
| `.saipen/` | SAIPEN memory: board, log, sources, knowledge |
| `VERSION`, `CHANGELOG.md` | release identity and notes |

Setup: clone the `main` branch into `zcode/`, then follow its README
(`pnpm bootstrap`, `pnpm bundle:zaicode`) and start `ZAICODE.exe` here.
