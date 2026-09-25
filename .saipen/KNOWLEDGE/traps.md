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

## Bundle EBUSY while the operator's ZAICODE agents scan the repo (2026-09-24, T-31)

`REBUILD.cmd` rebuilds the agent CLI (`apps/zcode-cli/packages/*/dist`) with tsc.
While the running packaged ZAICODE has agents grepping the same checkout
(`resources\tools\ugrep\ugrep.exe`) or Defender scans fresh output, tsc can fail
with `error TS5033: Could not write file ... EBUSY: resource busy or locked` on
a random `dist` file. It is contention, not a code error: rerun (a retry loop
passed on the next attempt). Never kill the operator's ugrep/ZAICODE processes.

`REBUILD.cmd --fast` used to forward `--fast` to the bundler (`shift` does not
change `%*`; bundle.mjs rejects unknown flags). Fixed: arguments are rebuilt
without `--fast` before `bundle-zaicode.mjs`.

## Targeted oxlint is not the lint gate (2026-09-24, T-34)

Several tickets reported "oxlint 0 errors" from a targeted run over the files
they touched, while the canonical `pnpm lint` (upstream AGENTS.md makes it
mandatory) failed with 7 `eslint(max-lines)` errors (limit 400 non-blank,
non-comment lines, `.oxlintrc.json`) in ZAICODE files. A ZAICODE diff had also
deleted upstream's own `/* eslint-disable max-lines -- ... */` header from
`desktopMainIpcPlatform.ts`. Run the full `pnpm lint` at VERIFY; a file that
legitimately stays long gets the upstream idiom
`/* eslint-disable max-lines -- <why one owner module> */` as its first line.

## Desktop main/preload/renderer tsconfigs are not in the typecheck gate

`pnpm typecheck` builds only `packages/desktop/tsconfig.host.json` from the
desktop package; `tsconfig.main.json` / `preload` / `renderer` carry many
upstream type errors (esbuild bundles them without a type pass). Checking a
ZAICODE change there means filtering that output to the touched files.

## Pixel font blurs on half pixels (2026-09-25, T-49)

ZAICODE draws its UI with a pixel font and no antialiasing, so any text box
that starts on a fractional x/y renders soft. Browser centring (`mx-auto`,
`justify-center`) of a fixed-width column in a container of odd width lands on
x.5; measured virtual-row heights and pointer coordinates on a scaled display
are fractional too. `zaicode/zaicodePixelSnap.ts` moves every element matching
`ZAICODE_PIXEL_SNAP_SELECTOR` by its sub-pixel remainder; a new centred or
percentage-placed text container should carry `data-zaicode-pixel-snap`, and
drag-resize code should round to whole pixels.

## Agent shells export TZ=UTC (2026-09-25, T-56)

The agent shells on this machine run with `TZ=UTC`. A ZAICODE started from
one shows every clock three hours off, because Chromium fixes its time zone
before main-process code can delete the variable. The launcher and
`ZAICODE.ps1` drop TZ; a packaged app that still inherited it relaunches once
without it. Node tests that depend on the local zone run with `TZ=` (empty)
or pass an explicit IANA zone.

## Sidebar-width top overlay must not reserve caption space (2026-09-25, T-49)

`DesktopTopOverlay` reserves 136 px on the right for the Windows caption
buttons. That is right for a window-wide overlay, wrong for the ZAICODE
toolbar overlay that is only as wide as the sidebar: the reservation squeezed
the toolbar to ~30 px and pushed every icon into the overflow menu.

## An agent inside ZAICODE killed ZAICODE by image name (2026-09-25, T-60)

The "8 tasks at once, it crashed" report (SRC-044) was not load: at 16:19:03
the in-app session `PHASE SCOUT T-55` (`_ZAICODE`, a free-tier model) got
`/goal cc all`, decided to "clean up the process tree" and ran
`taskkill //F //IM ZAICODE.exe //T`. The root launcher is also `ZAICODE.exe`,
so launcher, app and all eight agents died without a log line (launcher.log
has nothing after 12:32Z; the app log just stops). The agent CLI now refuses a
Bash command that stops processes by the ZAICODE image name, pipeline or path
(`permission/zaicode-self-protection.ts`, rule `zaicode.selfProtect.kill`,
even in yolo), and the ZAICODE identity prompt says why. Claude/Codex workers
are other CLIs and are not covered by that guard: stop only PIDs you started.

## File names differ only in case: Windows overwrites (2026-09-25, T-60)

`packages/ui/src/zaicode/` holds `ZaicodeX.tsx` components next to `zaicodeX.ts`
modules. On NTFS `zaicodeWorkersDock.tsx` IS `ZaicodeWorkersDock.tsx`: writing
the new module silently replaced the worker-window component (restored from
git, module renamed `zaicodePanelDock.tsx`). Before creating a file there,
check that no name equal up to case exists (`ls | grep -i`).

## Launcher swap fails on long paths (2026-09-25, T-58)

The bundled 9router ships a Next.js output whose deepest files
(`...\.next\...\__PAGE__.segment.rsc`) pass MAX_PATH under
`dist\win-unpacked.previous`. The csc-built launcher is not long-path aware,
so `Directory.Delete(previous)` threw "Could not find a part of the path",
the swap was skipped and the OLD build started again (launcher.log: "Staged
build swap failed"). `RemoveBuildDirectory` now falls back to
`rd /s /q "\?\<path>"` and, last, moves the folder aside. A launcher that is
already running keeps its old code until it restarts; clearing
`win-unpacked.previous` by hand (PowerShell 7 or `rd` with `\?\`) unblocks it.

## SAIPEN home has two layouts (2026-09-25, T-43)

`SAIPEN_HOME` from the ZAICODE launcher is `%LOCALAPPDATA%\saipen\scheduled-source`,
a source checkout: BOOT.md / STYLE.md live in `<home>/saipen/`, the templates in
`<home>/extensions/templates`, the launcher in `<home>/bin`. The skill install
(`~/.config/opencode/skills/saipen`) is flat. A check for `<home>/BOOT.md`
alone wrongly reports "no SAIPEN home"; resolve the protocol folder the way
BOOT.md says (`<home>/saipen`, else `<home>`), e.g. `saipenProtocolDir`.

## Windows PowerShell 5.1 turns native stderr into errors (2026-09-25, T-53)

With `$ErrorActionPreference = 'Stop'`, `& git.exe ... 2>&1` in Windows
PowerShell 5.1 throws NativeCommandError on the first line git writes to stderr
(progress, warnings), although git succeeds. Set the preference to `Continue`
around native calls and judge by `$LASTEXITCODE` (`Invoke-ZaicodeCommand`).
Also: a script block does not close over its creator's locals, and
`GetNewClosure()` loses script-scope functions; the installer's checks are
switch arms over a context object for that reason.

## Public SAIPEN / SAIMAIL lag the local checkouts (2026-09-25, T-53)

On 2026-09-25 local `_SAIPEN` was 132 commits ahead of `vacterro/saipen` main
(v8.0.1 there: no `bin/`, no `bootstrap/cli_launcher.py`), and SAIMAIL's
`saimail-local` (`saimail_local.py`, the `[project.scripts]` entry) existed only
as uncommitted work in `__SAIMAIL__`. An install from GitHub therefore gets the
older SAIPEN and no `saimail-local`; the installer writes the SAIPEN launcher
itself and reports saimail-local as WARN. Publishing those repos is the
operator's call.
