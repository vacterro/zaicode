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

## Public SAIPEN / SAIMAIL lag the local checkouts (2026-09-25, T-53; SAIPEN half corrected 2026-09-27, T-85)

On 2026-09-25 local `_SAIPEN` was 132 commits ahead of `vacterro/saipen` main
(v8.0.1 there: no `bin/`, no `bootstrap/cli_launcher.py`), and SAIMAIL's
`saimail-local` (`saimail_local.py`, the `[project.scripts]` entry) existed only
as uncommitted work in `__SAIMAIL__`. An install from GitHub therefore gets the
older SAIPEN and no `saimail-local`; the installer writes the SAIPEN launcher
itself and reports saimail-local as WARN. Publishing those repos is the
operator's call.

**Corrected 2026-09-27 (T-85):** the SAIPEN half is no longer true. A fresh
`git clone --depth 1 https://github.com/vacterro/saipen` measured
`3088efffb61de1c4cea9cde2e15daf641654c4dc` (v8.0.1, tag v8.0.1 =
`7145548211d2ee3ca9babf5e8b251960ea8f0527`) and it **does** carry `bin/saipen`,
`bin/saipen.cmd`, `bootstrap/cli_launcher.py`, `saipen/`, `tools/` and `phases/`
— the full launcher surface. A cloud executor can therefore install the real
CLI from the public repo instead of following the protocol by hand. The
SAIMAIL half (`saimail-local`) was not re-measured and stays open.

## A hand-rolled `Invoke-GitChecked` re-breaks the 5.1 stderr trap (2026-09-27, T-85)

`%APPDATA%\SAIPEN\ZAICODE_saipen-live.ps1` set `$ErrorActionPreference = "Stop"`
and then ran `& git @Arguments 2>&1` inside `Invoke-GitChecked` — the exact
combination the trap above documents as fatal in Windows PowerShell 5.1. Any
git that writes one progress line to stderr (fetch, push, pull) raised
NativeCommandError even on exit 0, so the bootstrap could not finish a fetch.
Reusable fix, copied into `tools/saipen-cloud/`: capture stderr separately or
set the preference to `Continue` around native calls and judge by
`$LASTEXITCODE`.

## The nested product repo is invisible to the transport (2026-09-27, T-85)

`zcode/` is its own Git repository, gitignored at the outer root
(`.saipen/source-nested-repos.json` declares it). A checkpoint commit of the
outer repo therefore carries **no product byte**: T-84's
`packages/desktop/src/host/zaicodeRunDispatch.ts` change sat in the outer repo's
`git status` as nothing at all. Anything that reads only the outer worktree
concludes "tree clean, safe to sync" while the product delta is still local
only. Treat `git -C zcode status` as a separate, explicit check; it is a
local-only gate the cloud cannot see.

## PowerShell unrolls a returned array, and StrictMode then eats it (2026-09-27, T-85)

A function that does `return @()` hands the caller `$null`, and
`return @('one')` hands it a bare `String`. Both break the caller:
`if ($null -eq $result)` reports a clean result as a failure, and
`$result.Count` throws `PropertyNotFoundStrict` on the string because a
`String` has `.Length`, not `.Count`.

This is what made the first transport watcher inert: `Get-DirtyPaths`
returned `@()` for a clean tree, the caller read `$null` as "git status
failed", paused on every tick, and never fetched anything at all. With one
dirty file it returned a single string instead and the pass threw.

Return a record with an explicit flag (`[pscustomobject]@{ Ok = $true;
Paths = @(...) }`), or wrap the call site in `@()`. Never return a bare
collection and read `.Count` off it.

Related, same script family: `"-File", "`"$path`""` parses on PowerShell 7
and fails the Windows PowerShell 5.1 parser in an array element. Build those
argument lists with `('"{0}"' -f $path)` instead — it is the same output and
it does not depend on backtick counting.

## A script's default parameter cannot assume where its copy will live (2026-09-27, T-85)

`ZaicodeSaipenLiveWatcher.ps1` defaulted `-Repo` to two levels above
`$PSScriptRoot`, which is correct for the repo copy under `tools/` and wrong
for the installed copy under `%APPDATA%\SAIPEN` — it resolved to
`C:\Users\<name>\AppData` and reported "not inside a Git work tree". A
default derived from the script's own location is only valid if exactly one
location is ever allowed to hold the script. `-Repo` is mandatory here
instead; the installer and the Startup entry always pass it.

## The tracked conformance receipt makes `saipen status` one commit stale by construction (2026-09-27, T-85)

`.saipen/recovery/conformance/` is tracked (193 files before T-85). A
`saipen validate` run writes a new receipt into it, so committing that receipt
changes the source identity the NEXT receipt would have to bind to. The
sequence never converges:

    saipen validate   -> Conformance: CURRENT_PASS, one untracked new receipt
    git commit        -> the receipt is now tracked, the identity moved
    saipen status     -> Conformance: STALE_PASS, "receipt is bound to a
                         different source identity than the current checkpoint"

Running `validate` again only produces another receipt. This is structural, not
a broken state, and it is the same treadmill T-73 hit with the LOG seal.

What to do: commit the receipt, so the worktree stays clean and the watcher
keeps running, and treat `saipen status`'s STALE_PASS as a known one-commit lag
rather than a regression. The authority for any given moment is
`saipen validate` run at that moment, which is what `CLAUDE.md` and
`.claude/skills/saipen/SKILL.md` both instruct an executor to do. Read
CONFORMANCE.md only when debugging a validator failure, never to argue about
this lag.

## A SAIPEN tag is not the kernel the project runs (2026-09-27, T-87)

`git clone --branch v8.0.1 https://github.com/vacterro/saipen` checks out
`7145548`. `main` is `3088eff`, and both print `VERSION` 8.0.1, but they
differ in 967 files. At `7145548` the verb `saipen validate` is a phase
trigger that transitions to VALIDATE, which mutates state. Its validator also
rejects this board's fields (`closure_mode`, `user_explicit`, `detail_ref`,
`blocker_scope`) and reports 40 false FAILs.

Pin the kernel by commit, never by tag or version string. The adapter
(`.claude/skills/saipen/SKILL.md` § 2) fetches `3088eff` by SHA and asserts
`rev-parse HEAD`.

## Long LOG events do not survive a change of checkout path (2026-09-27, T-87)

The kernel moves any LOG event over `MAX_NEW_EVENT_BYTES` (1024) into
`.saipen/recovery/log-detail/<E-###>-<hash>.{json,LOG.md}`. The line left in
LOG says only `detail_ref: <path>`. On read, `_read_detail_text` restores the
full text only if the sidecar's `project_identity` equals
`realpath(checkout)`. That is `v:\___vac\...\_zaicode` on the operator
machine and `/home/user/zaicode` in the cloud.

Where the path differs, the verdict text is gone. `closure-evidence` then reads
`detail_ref: ...` instead of `PASS ... conf: high` and FAILs the ticket. The
byte-identical sidecar makes no difference, because its sha256 is never
reached. Measured on E-1289 (T-78): `detail_integrity: invalid`, sha256
matches.

What to do:

- keep every event under 1024 bytes;
- classify the cloud FAILs as the known boundary (`SKILL.md` § 6);
- wait for the upstream fix, P1-1 in `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`.

Do not rewrite sidecar metadata to the other path: that turns the same FAIL
around onto the operator machine.
