# T-45 evidence -- SRC-035 items 2-7 (UI wave)

Item 1 (zero-setup router) is T-46 (separate run, DEC in LOG).

| Item (operator's words) | Where |
|---|---|
| 2. Icons that do not fit are cut off, "here and everywhere" | `ui/src/zaicode/ZaicodeOverflowRow.tsx` + `zaicodeOverflow.ts` (fit rule): header toolbar buttons that do not fit move in order into a "⋯" panel and come back when there is room; the top overlay gives the row the sidebar width and puts the running meter in flow (`DesktopTopOverlay.tsx`). Wrapping instead of clipping: sidebar Group/Project row (`WorkspaceSidebar.tsx`), pool and default-model rows (`ZaicodeEngineBar.tsx`, `ZaicodeDefaultModelBar.tsx`, label widened so "SAIRoute" is readable), composer SAIPEN buttons (`ZaicodeSaipenControls.tsx`). |
| 3. Great Color Customizing | Settings -> ZAICODE -> Colors (`settings/ZaicodeColorSettings.tsx`, `ZaicodeColorParts.tsx`; store `zaicode/zaicodeColorStudio.ts`; math `zaicodeColorMath.ts`). Cascade: theme (16 built-in + own) -> whole-palette shifts (hue, saturation, lightness, contrast) -> single overrides of any of the 55 app colour variables. Own themes: copy of any theme (editing a built-in makes a copy automatically), rename, delete with confirm, per-colour reset to base, a whole theme from one colour (dark/light), export JSON to clipboard, import JSON. Readability report (WCAG contrast of six text/background pairs), live preview, Undo (50 steps). Footer palette menu lists own themes and opens the Studio. Applied by `zaicodeAppearance.ts`. |
| 4. Notifications in-app / Windows, user's choice | Notifications page "Deliver to": Per moment / In-app cards / Windows / Both; "also while ZAICODE is in front"; Test Windows / Test card buttons. Windows notifications are native (main process `desktop/src/main/zaicodeNotify.ts`, IPC `zaicode:show-notification`; a click brings ZAICODE forward), browser API as fallback. |
| 5. Several resets in a row: not all highlighted, not at once; rules for appear/disappear | Cause: resets were detected only from re-read (measured) windows; a window whose reset time had passed showed "refilled" without glow until a new reading, sometimes never. Fix: detection reads the effective windows (`ZaicodeLimitMeter.tsx`), so every passed reset is announced and glows at once, the later measured reading does not repeat it (latch). Rules (Notifications -> Glow ends): after its minutes / when I rest the pointer on it / when I click it / when that quota starts going down; "fade out as it ages". `zaicode/zaicodeGlow.ts`. |
| 6. LOG order both ways by date | SAIPEN pane LOG header button "oldest first / newest first" (`sortZaicodeLogLines` in `zaicodeSaipenDetail.ts`), remembered; "follow" keeps the newest in view at either end. |
| 7. Uploaded photo kept in a list; right-click delete with confirm | Profile menu "My photos" (`ZaicodeFooterMenus.tsx`; list rules `zaicodeAvatarUploads.ts`, store in `zaicodeProfiles.ts`): every upload is kept (24 max, newest first, stored once); click uses it, right-click asks "Delete this photo from the list?" Delete / Keep; deleting clears it from profiles that show it; photos uploaded before the list existed are adopted. |

New preference keys join the settings snapshot (`zaicode-color-studio-v1`, `zaicode-avatar-uploads`, `zaicode-saipen-log-order-v1`).

## Gates (2026-09-25, from `zcode/`)

- UI `node --import tsx --test test/zaicode*.test.ts`: 123/123 (new `zaicodeWave45.test.ts` 9/9: overflow fit, LOG order, photo list, delivery channels + settings normalize, run of resets announced at once and once, glow fade + in-use rule, colour math, one-colour palette contrast >= 4.5 both polarities, Studio cascade).
- Red controls: the reset test also runs the old input (measured windows only) and shows it announces nothing at the reset moment; a deliberate type error in `ui/src` fails `tsc --noEmit -p packages/ui/tsconfig.json`.
- Root `tsc -b` (typecheck set): 0 errors. `packages/desktop/tsconfig.main.json`: 83 errors, the pre-existing upstream baseline (T-38 count), none in ZAICODE files.
- `oxlint`: 0 errors (72 baseline warnings). `pnpm architecture:check --changed`: OK, 0 violations.
- T-44 system E2E rerun after its file split: 10/10 PASS.

## MANUAL-VERIFY (operator)

1. Narrow the sidebar: header buttons disappear from the right into "⋯"; the Group/Project row wraps; nothing is cut.
2. Settings -> ZAICODE -> Colors: click a theme, change "Window" colour -> an own copy appears (★) and the app recolours; drag Hue; override `sidebar`; Undo steps back.
3. Notifications -> Deliver to: Windows -> Test Windows shows a Windows toast even with ZAICODE in front; clicking it focuses ZAICODE.
4. Limits: after two windows reset, both rows glow at once; click one row (or the title-bar meter cell) -> it stops glowing (rule "when I click it"). The sidebar engine tile ends a glow only by hover (a click there picks the START engine).
5. SAIPEN pane LOG: "oldest first" -> "newest first" flips the list.
6. Profile menu: upload two photos; both stay under "My photos"; right-click one -> Delete asks first.
