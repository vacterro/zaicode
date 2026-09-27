# ProTrail continuation after explicit operator stop (2026-09-27)

Read CLAUDE.md, .claude/skills/saipen/SKILL.md, then cold-recover STATE,
BOARD and LOG. Active T-94 remains VERIFY. The operator explicitly stopped
execution; this file is a handoff, not permission for background continuation.

## Current state

- Previous fix 4434ac4 solved the dropped initial state but the operator
  reported FAIL: only one monitor still showed trails. Screenshot:
  V:/___VAC/_PIC/_PRNTSCREEN/2026-09-27_184525.png.
- Native GetWindowRect showed all three live overlay windows at
  (0,0)-(1920,1080). Their expected origins are -1920, 0, 1920.
- Bounded real Electron probe `.saipen/evidence/protrail-bounds.cjs` proved
  that ordinary overlay windows are moved after show to the active monitor.
  Setting bounds immediately after show does not prevent this later move.
  Windows toolbar windows retain each requested rectangle, including after
  a one-second observation. FancyZones is running with
  fancyzones_openWindowOnActiveMonitor=true. No external settings changed.
- Fix **b54ecc9** adds Windows-only `type: toolbar`. Committed and pushed in
  one atomic push to origin/main and origin/zaicode. Local main also advanced.
  Product worktree is clean; active branch remains zaicode for the watcher.
- Regression in zaicodeProtrailReadiness.test.ts failed before the fix and
  passed afterwards. Focused 8/8; full UI 391/391, services 59/59, desktop
  76 passed + 2 pre-existing skips. Typecheck exit 0; lint 0 errors / 76
  warnings; architecture 0 violations. Desktop-main tsc still has exactly
  the same 83 errors (entire diagnostic output equal to pre-fix baseline).

## Interrupted build — do not launch partial staging

- `pnpm build:zaicode` completed; metadata b54ecc97 at
  2026-09-27T15:50:36.461Z.
- `pnpm bundle:zaicode --skip-prepare --skip-build` was in electron-builder
  when the operator requested stop. Its process tree rooted at PID 26860
  was deliberately terminated. **dist-next is incomplete/unverified.**
- The live application was NOT restarted: main PID 54404 still runs
  **4434ac40**, not the new fix. Previous root launcher PID 15040.
- Protocol checkpoint and `saipen stop` completed. Workspace changes
  (checkpoint receipts, diagnostics and this handoff) are local/uncommitted.
  `.saipen/MANIFEST.json` has a pre-existing timestamp-only edit; preserve it.

## Resume order

1. Fetch workspace origin and product origin, preserve histories; no force
   or rebase. Read current state before deciding anything.
2. Rebuild fresh staging. Local pinned pnpm 10 PATH prefix:
   V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/.tools/pnpm10/node_modules/.bin;
   C:/nodejs. From zcode run `pnpm build:zaicode`, then
   `pnpm bundle:zaicode --skip-prepare --skip-build`. Prepared runtime assets
   are reusable: CLI/shared/services/server sources unchanged from the prior
   working baseline. Full preparation previously hit transient EBUSY on CLI
   generated files; do not disable security settings or claim it passed.
3. Check successful packaging and staged app.asar metadata b54ecc97 before
   closing the live app. User already authorized rebuild and restart.
4. `.saipen/evidence/protrail-restart.ps1 -Action Close` uses the app's own
   Shift+close path. `-Action Start` invokes root launcher; `Inspect` shows
   native rectangles. Preserve existing rollback builds using validated
   explicit paths if needed; previous-before-p1 already exists.
5. Verify running app.asar metadata and compiled main bundle match, visible
   main window, and THREE DISTINCT actual overlay rectangles, then inspect
   again after window-manager events settle. Mere overlay count is insufficient.
6. Append this fix and Windows test steps to .saipen/evidence/T-94-src062.md,
   checkpoint and validate, commit/push the workspace evidence to saipen-live.
   Await the user's visual PASS/FAIL, especially mixed-DPI and click/hold
   alignment. Never mark T-94 PASS on unit tests or window geometry alone.
7. The broader docs/HANDOFF_A3_AUDIT.md remains open from P2 onward.

The user's publication preference persists: product fixes go to public main
as well as zaicode; workspace/protocol history remains on saipen-live.
