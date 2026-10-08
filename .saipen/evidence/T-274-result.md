# T-274 / T-275 / T-276 -- ZAICODE 0.0.3 first-tester readiness

Sources: SRC-177 (suite install, component uninstall, drag reorder, Full without
scroll, no fades), SRC-178 (installer artwork), SRC-179 (keep hardening, a
normal installer for first testers).

## Delivered

- `ZAICODE-Setup-0.0.3.exe`: one file carrying the whole suite (built app,
  SAIPEN, SAIMAIL, private Git/Node.js/Python, SAIMAIL wheels). SHA-256 checked
  before anything is unpacked; refuses a non-empty folder, a path too long for a
  MAX_PATH Windows, and too little free space, each with the fix in the message.
- Small `install/ZAICODE-Setup.exe` stays the source fallback (fetch + build).
- Setup window: launch art for 2 s, then a movable/minimizable window over the
  supplied background; the logo stays clear of the panel (panel 500 px, art
  drawn at its own proportions). Text says "a few minutes" for the bundled
  Setup and "15-30 min" for the fallback.
- Uninstaller: `Uninstall-ZAICODE.cmd` and Windows Installed apps
  ("ZAICODE + SAIPEN + SAIMAIL"); checkboxes per part, ZAICODE alone by default,
  "Select whole suite". Removes only unchanged recorded files; build output,
  dependencies, venv and runtimes are removed whole (rd: junctions unlinked,
  never followed); a clone's .git goes only when nobody worked in it; the last
  part takes workspace files, install records, logs, registry entry and the
  folder. Data (protocol memory, mail, profiles, logins, edited files) stays.
- Hardening found by the clean-machine run:
  - inherited `ELECTRON_RUN_AS_NODE=1` (editor terminals, agent apps) made the
    boot gate and the root launcher run ZAICODE.exe as plain Node: the build was
    rejected and the app could not start. Stripped in the launcher, installer
    library and boot verifier.
  - a live build that failed the boot gate was reported "app OK" by the next
    install/doctor run: the gate now leaves `boot-failed.json`, the `app` check
    fails until a newer build passes.
  - `build-suite.mjs` overflowed the git ls-files buffer (ENOBUFS).
  - `ZaicodeQueuePanel.tsx` crossed the 400-line lint limit (redundant key).

## Evidence

| Check | Result |
| ---- | ---- |
| UI oracle `.saipen/evidence/T-274-ui.cjs` | original subject red on 9 of 10 checks; current 10/10 green (`T-274-ui-original`, `T-274-ui-fixed`). Instrument fix only: rows dragged from the list centre (bottom-edge autoscroll moved the drop target). |
| Focused UI tests | `zaicodeRelease003Transcript`, `zaicodeSaipenToggle`: 5/5 |
| Boot gate unit test | new marker case red before the change, 9/9 green after |
| `pnpm typecheck`, `tsc --noEmit -p packages/ui` | pass |
| `pnpm verify:pre-push` | 1994 tests, 1988 pass, 6 existing skips, 0 failures; lint 0 errors |
| `install/tests/Test-ZaicodeSuite.ps1` (PS 5.1) | 20 checks pass |
| `install/tests/Test-ZaicodeUpdate.ps1` | pass (fixture now carries the suite scripts) |
| `tools\launcher\build.cmd` | pass |
| `pnpm bundle:zaicode` (dist-next, appVersion 0.0.3) | boot gate pass |
| Clean source install, PATH = System32 only, portable tools | first run exposed the Electron flag defect; rerun 17/17 OK |
| Bundled Setup /quiet, PATH = System32, ELECTRON_RUN_AS_NODE=1 | 17/17 OK, EXIT 0, 2.8-5.1 min, no Git/Node/Python on PATH |
| Installed app boot (`verify-zaicode-boot.cjs`) | pass |
| Installed app free models (`verify-zaicode-free.cjs`, empty profile) | pass: SAIFREN first token 1.7 s, task answered |
| `Update-ZAICODE.ps1 -Check` on the bundled install | 4 parts up to date |
| Uninstall ZAICODE alone, then SAIPEN+SAIMAIL (old code) | left logs-named router files, root files, .git skeletons (the defects above) |
| Uninstall -All (new code) on a fresh bundled install | 20328 files, folder, registry entry and shortcut gone, nothing left |
| Setup GUI screenshots | splash 906x323 titled 0.0.3; window 1140x640, logo clear |

## Not proven here

- Clean Windows 10 and Windows 11 VMs: not available; the isolated PATH run on
  this Windows 10 machine is an approximation.
- MAX_PATH machine: this machine has LongPathsEnabled=1; the guard is code-read
  plus arithmetic (longest payload path 203 characters).
- Unsigned exe: SmartScreen "More info -> Run anyway" is documented, not avoided.
- The candidate payload was built from the local working tree; the release
  payload must be rebuilt after the product and workspace are pushed, so the
  bundled clones match their GitHub history (see release steps in
  docs/ZAICODE_INSTALL.md).
