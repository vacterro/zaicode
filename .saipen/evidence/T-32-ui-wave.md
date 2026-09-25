# T-32 ZAICODE UI wishlist verification

Source: `.saipen/intake/active/SRC-026.md`. Scope: the 2026-09-24 ZAICODE UI request. The checkout already contained much of this work before this run; this run completed the missing home, SAIMAIL, and release-default integrations.

| Request | Implementation evidence |
| --- | --- |
| Ten supplied default avatars and an uploaded photo | `zcode/packages/ui/src/assets/zaicode-avatars/` contains ten images; `zaicodeProfiles.ts` enumerates them and scales uploaded photos; `ZaicodeFooterMenus.tsx` offers selection, upload, and removal. |
| Save all current settings for later builds | `ZaicodeSettingsSection.tsx` now exposes **Save all settings**; `zaicodeSettingsSnapshot.ts` captures durable preferences and selected custom cue audio; desktop IPC writes `zaicodeSettingsDefaults.json` plus a userData backup; preference readers use the bundled snapshot only where local storage has no value. Runtime counters and active jobs are excluded. |
| Ambience can be changed during playback | `zaicodeAudio.ts` reconciles changed sound and volume live; `ZaicodeAudioPanels.tsx` exposes sound, preview, volume, and play status. |
| Per-event sound selection | `ZaicodeCuePanel` is mounted in Notifications; `zaicodeCues.ts` has done, failed, question, human, update, and started; task notifications and work start invoke the corresponding cue. |
| Live BOARD/LOG/STATE in right sidebar | `ZaicodeSaipenSidePane.tsx` is mounted from `AnimatedSidePanePanel.tsx` and reads those protocol files with status indicators. |
| Archive all via archive right-click | `TaskListItem.tsx` selects archive context menu; `TaskList.tsx` mounts `ZaicodeArchiveContextMenuContent` with project and global actions. |
| Predictable archive hover | `TaskListItem.tsx` uses mouse movement to restore action visibility after remount while the pointer remains in a row. |
| Parallel subSaipens and obvious project MAIN | `ZaicodeSaipenControls.tsx` highlights WIKI/TRANSL when MAIN works; `WorkspaceSidebarItem.tsx` exposes MAIN open/create; `zaicodeMainSession.ts` persists per-project mapping and `TaskList.tsx` pins it. |
| Configurable greeting and SAIMAIL, neutral Empty | `ConversationDraftEmptyState.tsx` now uses `ZaicodeHomeScreen.tsx` greeting hours/text, neutral Empty and SAIMAIL line with right-click settings; `ZaicodeSaimailHeaderButton.tsx` applies envelope preferences and opens its settings on right-click. |
| SLOTS/LIVE settings and centered slot titles | `zaicodeSidebarPrefs.ts` defaults alignment to center; `ZaicodeSidebarSectionSettings.tsx` offers L/C/R and right-click SLOTS/LIVE controls. |
| Project Ctrl+click, folder menu and slot move | `WorkspaceSidebarItem.tsx` handles Ctrl+click to SIDE2 and right-click context menu with priority slot choices. |
| Archive undo and working icon | `zaicodeArchiveUndo.ts` handles Ctrl+Z; `WorkspaceSidebarItem.tsx`, `TaskListItem.tsx`, and chat loading use `ZaicodeWorkingIcon.tsx`. |

Validation: `pnpm exec tsc --noEmit -p packages/ui/tsconfig.json --pretty false` passed from `zcode/` on 2026-09-24 after fixing cue-parser narrowing. `node --import tsx --test test/zaicode*.test.ts` initially found a stale five-slot expectation in `zaicodeUiWave31.test.ts`; the request explicitly includes SIDE3, so the expectation was updated and the same suite passed 28/28. The test runner's deliberate known-bad control failed 1/1 with exit code 1. The desktop source writer is reached through the existing IPC/preload/platform chain. Visual interaction still requires the running desktop application.

Review: independently reran the same 28-test suite and the UI no-emit typecheck after the final snapshot change; both passed. Review found and fixed two save-path details: a later build can resave a bundled custom cue even when its IndexedDB entry is absent, and desktop reports a failed backup accurately. No reusable knowledge card: the findings are confined to this implementation.
