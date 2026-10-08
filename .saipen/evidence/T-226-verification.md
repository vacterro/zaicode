# T-226 / SRC-156 — operator checklist verified against the shipped UI work; misses fixed

Date: 2026-10-06. Ticket: T-226 (SCOUT -> BUILD -> VERIFY). Source: SRC-156 (operator
asks to verify the T-224/T-225/T-222/T-223 work against the original intent and to fix
what is wrong). Screenshots remain model-unreadable: every finding below comes from the
clause text plus a code-path trace. Visual acceptance for the fixes stays
MANUAL_PENDING with the checklist at the bottom.

Working tree: `zcode/` (separate repo). Prior foreign modifications untouched.

## Per-item findings

1. **Bevels on list rows** — TWO deaths, one fixed earlier (T-225), one still real:
   the non-classic presentation killed the row rules by cascade tie (the T-225
   `[data-zaicode-style]` scope fix is present and verified), but under **Classic** the
   generic raised rule `html.zaicode-bevels [role="button"]` also matched the workspace
   row (`div[role="button"]`, `data-testid^="workspace-item-"`), so rows stayed raised
   with the sub-toggle OFF and the toggle changed nothing — exactly "no difference".
   **Fixed now**: the generic raised and pressed rules exclude the workspace-row TID;
   rows are beveled only through `zaicode-bevel-rows`.
2. **Vertical sidebar buttons** — verified: `ZaicodeProjectRail` renders through
   `ZaicXdeRailControl` from `zaicodeRailLayout` (32 px box, 16 px icon slot, icon-only
   with `aria-label`/`title`, MAIN inline, live strip bounded, scroll region for a long
   list). One control family, no per-button offsets. No change needed.
3. **Composer jitter** — verified: `composerFitDecision` quantizes every measurement to
   whole pixels and releases a rung only with 8 px of slack; the hook skips DOM writes
   when the plan equals the live state and batches observer callbacks per frame; the
   T-225 wrap fallback is on the toolbar root. No change needed.
4. **Ctrl+Alt+B SAIPEN sidebar Always-everywhere / per-project** — **REAL MISS**: in
   product mode the key was still consumed by the Usage sidebar
   (`ui.usageSidebar` default `Ctrl+Alt+B` shadows upstream `toggleSidePane` in the
   capture-phase dispatcher), so the SAIPEN side pane (the right pane with the SAIPEN /
   browser / task tabs) could not be toggled with its own key, while the settings block
   and the operator promise name exactly that pane. **Fixed now**: the Usage default
   binding is freed; a one-shot migration (`zaicode-hotkeys-sidepane-rev`) moves the old
   stored default off the key once and respects a deliberate rebinding afterwards;
   conflict detection reports a deliberate Usage binding on the key instead of hiding
   it. The persisted `sidePaneVisibility` policy (always everywhere / per owner) already
   rides this pane's toggle path (`useAppPanels`), so it applies as promised.
5. **Editable file-backed pasted text** — verified: pasted-text chips carry an Edit
   affordance (`data-composer-attachment-edit`, pencil, opens the editor on the exact
   payload), edits mint a fresh temp file, sent/session-owned attachments refuse edits,
   failed rewrites leave the item untouched, Remove stays. No change needed.
6. **Auto Retry toggle + right button -> settings** — verified: Phase A effective-scope
   contract (the click edits the scope that owns the effective answer, never a hidden
   editing scope; persistence checked against the same storage key; bounded 150 ms
   pending fence), right-click opens the shared settings surface. The master Auto gate
   is explained in the tooltip by design ("Auto is off" / session auto-continue off).
   No change needed.
7. **Auto Goal smarter** — verified T-222 supervisor: one deterministic intent per
   project prompt, idempotent across retry / compaction / provider switch / router
   fallback / restart / worker replacement, STOP wins, blocked exposed not spammed,
   bounded continuations, composer readout from the same state.
8. **Auto supervises goal cc all to completion** — verified: the observation feed folds
   authoritative session briefs (`goalStatus` active/paused/budget_limited/complete,
   running, waiting) into the intent; no second scheduler. No change needed.
9. **ProTrail Save All + Motion Wake OFF** — **GAP FIXED**: protrail itself was already
   in the allowlist and factory Motion Wake is OFF (`protrailModel` line 217, store
   reads through `readZaicodeSetting`), but the T-223 allowlist had missed durable
   families its own audit named (home, session text, change floaters, dispatch, active
   engine, presentation/size, icon profiles, scheduler marks, auto goal/continue,
   autostart, engine bar, header title, saipeggle, presets). **Fixed now**: 17
   snapshot-capable families added to `ZAICODE_SAVE_ALL_SETTING_KEYS` and to the
   coverage test's expected list. Families whose readers still use raw localStorage
   (notification sound, todo window/progress, saipen pane open, main sessions,
   session roles, home journal) are deliberately NOT added — they would be dead
   snapshot entries until their readers move to `readZaicodeSetting`.
10. **API connection indicator** — verified: `projectZaicodeConnectionState` maps
    running + router supervisor + retry ledger + quota wall onto Reconnecting
    ("attempt N/10"), Fallback active, Interrupted, Waiting for reset / retry; the
    composer mini (`ZaicXdeComposerWorkingFor`) and the sidebar row render the same
    projector; the host info carries `supervisor` from the main process. No change
    needed.

## Files changed (this pass, zcode working tree)

- `packages/ui/src/zaicode/zaicodeHotkeys.ts` — usage default binding freed; one-shot
  migration; conflict detection truthful.
- `packages/ui/src/zaicode/zaicodeBevels.ts` — generic raised/pressed rules exclude
  `[data-testid^="workspace-item-"]`.
- `packages/ui/src/zaicode/zaicodeSettingsSnapshot.ts` — 17 durable families added.
- `packages/ui/test/zaicodeT226HotkeySidePane.test.ts` (new, 3 tests).
- `packages/ui/test/zaicodeT225BevelRows.test.ts` — T-226 pin added (1 test).
- `packages/ui/test/zaicodeT223SaveAllCoverage.test.ts` — expected families aligned.

## Red control

Reverted the two source edits in place (usage default back to Ctrl+Alt+B, migration
call removed, bare role=button entries restored), ran the two suites:
3 RED (`no ZAICODE action owns Ctrl+Alt+B`, `old stored default moves off exactly
once`, `generic bevel rules leave the list rows`), 3 GREEN. Restored the exact bytes
(`cmp` identical) and re-ran: 13/13 focused GREEN.

## Gates (final tree)

- Focused: 13/13 PASS (T-226 + T-225 + T-223); plus T-224 side-pane and wave63 in the
  same run earlier, 29/29.
- Full `@zcode/ui`: 1213/1213 PASS, 0 fail, TEST_EXIT=0.
- Full repository `pnpm test`: EXIT=0 (scripts 118, ui 1213, services 103, desktop
  246 pass / 2 skipped / 0 fail, cli 45 + 9 + 11).
- `pnpm run typecheck`: TC_EXIT=0.
- `oxlint` on touched files: 0 errors, 2 pre-existing warnings in `zaicodeHotkeys.ts`
  (unused `Modifier` alias, spread in `Set`) — present on the untouched lines.
- `architecture:check --changed`: OK, 0 violations, 0 new.

## MANUAL_PENDING — operator checklist

1. **Bevels rows**: with Classic presentation, palette menu -> "Bevels on list rows"
   ON: project rows raised, open row sunken, task rows raised. OFF: rows flat while
   buttons keep their bevels. Repeat under Simple Boxes: same difference, buttons stay
   flat.
2. **Ctrl+Alt+B**: press it — the right side pane (SAIPEN / browser / task tabs)
   opens and closes. Settings -> Layout -> "SAIPEN side pane": Everywhere-open stays
   open across A -> B -> A and restart; per-owner keeps A open / B closed and returns
   A open. Hotkeys list no longer claims Ctrl+Alt+B for Usage; the Usage button still
   opens it (a key can be assigned by hand, and then it is flagged as a conflict).
3. **Save All**: Settings -> Release defaults -> Save all settings, then check the
   written JSON carries the families above (presentation, home, session text, presets,
   auto-goal, protrail with Motion wake OFF where untouched) and no token/session-id
   keys.
4. The already-MANUAL_PENDING rows of T-224 / T-225 / T-220 remain operator checks;
   nothing here claims them.
