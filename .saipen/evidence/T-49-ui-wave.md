# T-49 evidence -- SRC-038 UI items

Split (DEC in LOG): agents + scheduler + Automations = T-50, subscriptions as chat = T-51,
statistics = T-52, installer + Autotroubleshoot + product identity = T-53, 33 languages via
the SAIFREN pool = T-47 (last).

| Item (operator's words) | Cause found | Where |
|---|---|---|
| Settings for all highlights, starting with the title of the working session: slow pulse, strobe, shapes, full control | nothing configurable existed | Settings -> ZAICODE -> **Highlights & motion** (`settings/ZaicodeLightsSettings.tsx`). Seven targets (working / waiting / open session title, working / waiting project, title bar while working, limit meter with a prompt ready), each: on/off, effect (steady, slow pulse, breathe, heartbeat, blink, strobe, flicker), shape (text colour, glow, underline, box, fill, side bar, dot), colour (theme, state, own, rainbow), strength, speed, keep moving in the calm interface, live preview, reset. Engine: `zaicode/zaicodeHighlights.ts` (store + pure attrs), `zaicode/zaicodeMotionCss.ts` (one registered `--zh-k` animated by each effect; every shape reads it). Applied in `TaskListItem.tsx` (session titles), `WorkspaceSidebarItem.tsx` (project label), `WorkspaceHeaderSections.tsx` (title bar). |
| "What plan is this? A subSaipen should just do its part, no plan -- a result" | the free model called `EnterPlanMode` itself, then asked for plan approval | `apps/zcode-cli/packages/core/src/permission/plan-mode-policy.ts`: in ZAICODE mode a model's own `EnterPlanMode` is denied with "SAIPEN already plans the work ... carry out the task now" (`ZAICODE_AGENT_PLAN_MODE=allow` gives it back; plan mode picked by the operator in the composer still works). SAIPEN block of the agent prompt (`context/sections/identity.ts`): never EnterPlanMode, subSaipen roles deliver. |
| "Press a button to press a button" although there is room (sidebar header ⋯) | the header overlay is only as wide as the sidebar but still reserved 136 px on the right for the Windows caption buttons, which sit at the far right of the WINDOW; the toolbar got ~30 px and moved every icon into ⋯ | `DesktopTopOverlay.tsx`: no caption padding on the sidebar-width ZAICODE toolbar; the ⋯ overflow now only takes what really does not fit. |
| Visual justify left / middle / right for project names (title) | -- | Settings -> Layout & home -> Project list -> Title position (icon buttons + live sample, projects and sessions separately); also in the SLOTS right-click panel. `zaicodeSidebarPrefs.ts` `projectTitleAlign` / `sessionTitleAlign` -> CSS vars. |
| Remove empty spaces (Group / Project row) | the row wrapped its right-hand buttons onto a second, half-empty line | `WorkspaceSidebar.tsx`: one row, never wraps; a narrow sidebar drops the Group / Project words (container query) and keeps the icons. |
| 128k: artificial limit? make it 1kk / 131k | ZAICODE created SAIFREN / SAIOPP with a hard-coded 128 000 context | `zaicodeRouterSetup.ts` `zaicodePoolModelConfig` (1 000 000 context, 131 072 max output) for new pools; once per machine `useZaicodeRouterAutoSetup.ts` raises pools that still carry ZAICODE's old 128 000 (an operator-typed value stays). |
| Working icon fully configurable; "ignore reduced animation" so it keeps spinning; rotation strength, direction, ... | fixed 2.4 s spin | Settings -> Highlights & motion -> Working icon: picture (SAIPEN mark, 9 drawn glyphs, own picture), motion (spin, swing, wobble, pulse, breathe, bounce, flip, blink, still), speed, reach, size, opacity, direction (cw / ccw / back and forth), movement (even / smooth / ticks + ticks per turn), colour, glow, **Keep moving in the calm interface** (default on; overrides `No animations` and the OS reduced-motion setting for this icon only). `ZaicodeWorkingIcon.tsx`. |
| Compact mode for the message box: everything folds, buttons become small squares with icons; settings for everything about the text box | -- | ⇕ button at the end of the SAIPEN strip: compact row of square icon buttons (slot, START, STEP, CLEAR, mode squares with role glyphs, blocker mark, phase chip with NEXT/THEN/LAST in its tooltip); right-click it for every part on/off. Settings -> Layout & home -> Message box (same panel). Tight message box padding while compact. `zaicodeComposerPrefs.ts`, `ZaicodeComposerPartsPanel.tsx`, `prompt-editor/ZaicodeSaipenCompact.tsx`, `ChatPromptEditor.tsx`. |
| Manual resize must measure evenly; blur visible | the pixel font blurs on half pixels: the chat column and the message box are centred (mx-auto / justify-center) so every other width lands on x.5; virtual chat rows used fractional measured heights; worker windows / panel height took fractional pointer coordinates | `zaicode/zaicodePixelSnap.ts` (mounted in `ZaicodeAppRuntime`): centred columns, the composer and worker terminals are moved by the sub-pixel remainder after every resize (CSS `translate`, composes with their transforms). Chat rows start on whole pixels (`ConversationTimeline.tsx`, ZAICODE only). Worker window rects and the WORKERS panel height are rounded (`zaicodeWorkerLayout.ts`, `ZaicodeWorkersPanel.tsx`). |
| Text selection in the sound search resets randomly | clicks on tabs, quick slots and rows moved focus from the search box to the list (tabIndex 0), dropping the caret / selection | `ZaicodeSoundPicker.tsx`: tabs, quick slots and rows no longer take focus from the search box while it has it. |
| "Switch project" and "New task" play together; other such cases | an action sound (New task, open session, archive) changes the project / session, and the App navigation effect then played "Switch project" / "Open session" on top | `zaicodeSoundBus.ts`: navigation sounds are echoes -- silent when a direct action sound played in the last 700 ms; the same event twice within 120 ms is one sound (`App.tsx` marks the echoes). Covers New task in another project, opening a session from the meter / ring, archive -> next session. |
| Sometimes it does not fit (picker cut at the top) | the picker is ~520 px tall; Radix flipped it but nothing capped its height | picker: `max-h = --radix-popover-content-available-height`, the list shrinks first; every ZAICODE popover and context menu is capped the same way and scrolls (`zaicodeMotionCss.ts`). |
| Sound tabs: select several with Shift and/or press-and-drag | one tab at a time | `zaicodeSoundTabs.ts` + picker: click = one, Shift / Ctrl + click = add / remove, press and drag across tabs = several, All = reset; a multi-tab choice is remembered. |
| Right-click Problip opens the full Ambience settings | -- | `ZaicodeAudioPanels.tsx` `ZaicodeProblipButton`: right-click opens the full Ambience panel (+ "All sounds…"). |

## Gates (2026-09-25, from `zcode/`)

- UI `node --import tsx --test test/zaicode*.test.ts`: 142/142 (new `zaicodeWave49.test.ts` 13/13).
- Core `node --import tsx --test ../../apps/zcode-cli/packages/core/test/zaicodePlanMode.test.ts` (from `packages/services`): 4/4.
- `pnpm typecheck` (tsc -b set): 0 errors. `tsc --noEmit -p packages/ui/tsconfig.json`: 0.
- `pnpm lint`: 0 errors, 72 warnings (baseline).
- `pnpm architecture:check --changed`: OK, 0 violations.
- CLI: `pnpm --filter @zcode/core build` + `pnpm --filter @zcode/cli build` (deny rule present in `zcode.cjs`).

## MANUAL-VERIFY (operator)

1. Sidebar header: all chosen buttons show in one row; ⋯ appears only when the sidebar really is too narrow.
2. Group / Project row stays one line; narrow the sidebar -> the words go, the icons stay.
3. Settings -> Highlights & motion: pick Strobe + Box for "Session title while it works"; a working session's title flashes in a box. Working icon -> Swing, Ticks, counter-clockwise; turn on Calm -> it keeps moving.
4. Message box ⇕ -> compact row; right-click ⇕ -> hide THEN / LAST.
5. Drag the sidebar edge pixel by pixel: the chat text and the message box never go soft.
6. Settings -> Sounds -> any picker: Shift-click Clicks + Alerts, or drag across tabs; type in the search, select text, click a row: the selection stays.
7. Ctrl+N while another project is open: one sound.
8. Right-click the Problip metronome: Ambience panel.
9. A subSaipen (TRANSL / WIKI) never stops with "Implementation plan -- Approve".
10. Model settings -> SAIRoute -> SAIFREN: context 1000000, max output 131072.
