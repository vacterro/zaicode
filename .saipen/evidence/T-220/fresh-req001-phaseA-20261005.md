# Fresh REQ-001 Phase A — Auto Retry interaction contract (2026-10-05)

## Diagnosis (reproduced from prompt + code trace, no screenshots read)
- Symptom: "Auto retry off · project retry preference is off" while scope pill shows "Global default".
- Root cause: pill rendered `prefs.autoRetryScope` (editing scope) while effective truth came from
  `effective.source` (session > project > global). Primary click wrote `zaicodeAutoRetryPatch`
  (editing scope) so with scope=global + project override present it edited the global flag and
  left the effective answer unchanged: visible press, unchanged state. Proven by new test
  "project override ON/OFF is owned by the project scope" (old patch leaves effective false).

## Change (zcode repo, dirty tree on top of T-220)
- `zcode/packages/ui/src/zaicode/zaicodeUiPrefs.ts`: added `zaicodeAutoRetryEffectiveScope`,
  `zaicodeAutoRetryEffectivePatch`, `zaicodeAutoRetryEffectiveLabel`, `ZAICODE_UI_PREFS_STORAGE_KEY`.
  Kept `zaicodeAutoRetryPatch` for explicit-scope callers.
- `zcode/packages/ui/src/zaicode/ZaicodeAutoRetryButton.tsx`: primary toggles EFFECTIVE scope;
  pill shows effective label (This session / This project / Inherited: Global ON-OFF); Inherit
  clears the effective override; bounded 150ms pending lock fences rapid double clicks; persistence
  verified against localStorage, on divergence restores snapshot + surfaces failure 4s in tooltip;
  keyboard Enter/Space == click; all surfaces derive from `zaicodeEffectiveAutoRetry`.
- Tests: new `zcode/packages/ui/test/zaicodeFreshReq001AutoRetry.test.ts` (7 tests, regression matrix);
  updated 1 stale assertion in `zaicodeT201AutoRetryScope.test.ts` (Global default -> Inherited,
  old patch -> effective patch; explicit-scope helper tests untouched).

## Gates (2026-10-05, zcode root)
- New + T201 retry tests: 12/12 PASS.
- `pnpm run typecheck`: exit 0.
- `pnpm run lint`: 165 warnings / 0 errors (baseline held).
- `pnpm run architecture:check`: 0 violations.
- Full `@zcode/ui` suite: 1117/1119 PASS; 2 FAILs are pre-existing dirty-tree inconsistency
  unrelated to this change (`zaicodeComposerStripFit`, `zaicodeComposerReq009StripExtent`:
  untracked tests expect an `extent()` helper, modified `useComposerToolbarFit.ts` uses
  getBoundingClientRect; both predated this edit, untouched by it). NOT claimed as pass.
- Red control: T-201 button test went RED (1 fail) against the new implementation before its
  contract update, then GREEN after; new matrix documents the old-patch no-op as the bug oracle.

## Not done (truthful)
- Packaged Electron toggle acceptance (several real toggles, restart, reconnect states): MANUAL_PENDING.
- Fresh bundle intake (fast_*.zip + snapshot zip absent from workspace): BLOCKED, needs operator files.
- Phases B/C/D/E: scoped as follow-on, not implemented here.
