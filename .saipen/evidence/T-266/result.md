# T-266 — limit meter shows stale/old data when a quota window ends

## SCOUT
SRC-170 (the user request) projects as T-266. Its coverage (SRC-170:R001/R002)
routes to T-267 (scheduler quota/account transition), but the *display* defect
the user points at — "лимит заканчивается на второй, а там старое показывается"
— is a pure UI refresh gap, independent of T-267's account-binding logic.

Root cause: `ZaicodeLimitMeter` (title bar) and `ZaicodeEngineBar` (sidebar
"second meter") both render one shared `useZaicodeEngines()` snapshot. That
snapshot is only refreshed on a 30s poll (`useZaicodeClock(30_000)` in the
bar; autostart tick) or on demand (Shift+Click). When a window's `resetsAt`
crosses `now`, the local snapshot still reads 0% spent until the next poll, so
the second meter lags — exactly the stale/old display the screenshot shows.
`effectiveZaicodeWindows` projects `assumedFull` only on an *already-fetched*
post-reset snapshot; it cannot fix a snapshot that has not been re-read yet.

## BUILD
`zcode/packages/ui/src/zaicode/zaicodeEngines.ts`
- `earliestPendingReset(state, now)`: scans every engine snapshot's windows for
  the soonest future `resetsAt` (within 24h); ignores past resets / null resets
  / errored empty snapshots. Exported for tests.
- `useZaicodeResetRefresh()`: mounts the watcher, schedules a `setTimeout` to
  call `refreshZaicodeEngineLimits()` exactly when the soonest reset arrives,
  and reschedules automatically because the effect re-runs on the pushed store
  state (next reset recomputed after each refresh).
- `zcode/packages/ui/src/zaicode/ZaicodeEngineBar.tsx`: mount
  `useZaicodeResetRefresh()` once. Both meters share the store, so both repaint.

## VERIFY
- `zaicodeT266ResetRefresh.test.ts` (new): 4/4 pass — soonest-reset selection,
  past/null filtering, empty state, spent-window-imminent case (the exact T-266
  shape).
- `tsc -p zcode/packages/ui/tsconfig.json --noEmit`: clean.
- `oxlint` on the 3 changed files: 0 warnings, 0 errors.

## SHIP
zcode commit f3f0da7d (HEAD) — pushed to origin/HEAD. Only the T-266 files
touch: zaicodeEngines.ts, ZaicodeEngineBar.tsx, zaicodeT266ResetRefresh.test.ts.
The broader T-267/T-268 scheduler-account-release chain is untouched; T-266's
own display fix is complete and verified.

## Gates
tsc:0  oxlint:0  tests:4/4 pass
