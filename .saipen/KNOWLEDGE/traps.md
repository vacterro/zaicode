# Traps and env quirks

## Upstream production install must stay untouched

User's production ZCode lives at `%LOCALAPPDATA%\Programs\ZCode` (Electron) with
data in `%USERPROFILE%\.zcode`. Never install, migrate, reset or repoint it.

## Desktop dev app writes into the real user profile

Observed 2026-09-22: `pnpm dev:desktop:test` with `ZCODE_DATA_BASE_DIR` pointed
at a workspace dir still rewrote `C:\Users\vac34\.zcode\v2\setting.json`
(production settings path). `ZCODE_DATA_BASE_DIR` only relocates the
`.zcode/` data subtree; the settings service resolves `~/.zcode` separately.

Before any desktop run: point `HOME`/`USERPROFILE` (and preferably `APPDATA`)
at a workspace-local dir, or do not run it at all.

## Agent shell PATH is incomplete

The agent bash tool's PowerShell does not see machine PATH entries
(`C:\Windows\System32` missing) -> `spawnSync powershell.exe ENOENT` during
`prepare:native-search`. Prepend
`$env:PATH = "...;C:\nodejs;" + machine + user PATH` for every build command.

## pnpm major mismatch

Global pnpm 11.x ignores `package.json#pnpm` (overrides, patchedDependencies)
and warns; repo pins pnpm 10.33.2. Use the isolated 10.33.2 install at
`_ZAICODE/.tools/pnpm10`.

## Dev-only baseline failures (pre-existing, not regressions)

- `[cua-product-helper] invalid-runtime-manifest` in desktop dev logs.
- 70 lint warnings, 0 errors; typecheck clean at baseline 872ad960.
- Desktop dev exits by itself after several idle minutes (clean exit 0,
  `app_quit`); concurrently then reports exit 1 - that is teardown noise.

## SAIPEN guard vs shell mutations (2026-09-22)

The saipen guard inspects shell calls before execution: bash that resolves
target paths dynamically (`Get-ChildItem | Where-Object`, computed `-LiteralPath`
vars) can be refused as `TARGET_UNRESOLVED`, and `Remove-Item` was refused as
`UNSEATED_MUTATION`. Use literal absolute paths in shell rename/copy commands,
prefer the `write`/`edit` tools for file content, and never point shell file
tools at `.saipen/` (that is `PROTECTED_CANONICAL_NAMESPACE`; use the saipen CLI
or the read/edit tools for protocol memory).

## Desktop smoke runs leave Electron alive if taskkill is unavailable

`taskkill` is not on the agent shell PATH. Kill dev Electron/node trees via
`Get-CimInstance Win32_Process` filtered by the ZAICODE checkout path +
`Stop-Process -Force`; never kill by process name (the user's production ZCode
is also Electron). Redirect smoke output to `.zaicode/smoke/` and never pipe the
launcher directly into the agent shell (long-lived pipe hang, same class as the
playwright trap).

## SAIPEN status was 175 s on a no-git root (fixed 2026-09-24, T-22)

Without a git repo at the workspace root, SAIPEN computes the source identity
by walking and hashing every file under the root (node_modules is excluded,
but `zcode/**/dist`, `packages/desktop/dist/win-unpacked` and `.zaicode/`
smoke homes are not): ~70k files, 4 walks per `saipen status` = 175 s, and
`validate` reported STALE_FAIL. The root is now a small git repo whose
`.gitignore` excludes `/zcode/` (own repo), `/.zaicode/`, `/.tools/`,
`/.devhome/`, logs and the launcher exe. Result: `status` 4.5 s, `validate`
VALID / CURRENT_PASS. Never remove the root repo or un-ignore those trees.

## Packaged bundle is blocked while ZAICODE runs

`pnpm bundle:zaicode` rewrites `packages/desktop/dist/win-unpacked/`; with the
operator's ZAICODE.exe running, the files are locked. Check for a running
`*\dist\win-unpacked\ZAICODE.exe` first and never kill the operator's app.

## ZAICODE shares the production CLI data root (open decision)

The packaged ZAICODE agent writes `~/.zcode/cli/db/db.sqlite` and
`~/.zcode/cli/artifacts` - the same data root as the installed production
ZCode (UI.md "Standalone Identity" says they must not share mutable state).
Moving it would hide existing ZAICODE sessions/projects, so it waits for an
explicit operator decision.
