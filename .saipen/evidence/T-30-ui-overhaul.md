# T-30 ZAICODE launcher UI+behavior overhaul — evidence

Date: 2026-09-24  Owner: claude-code  Receipt: SRC-024

## Changes landed (source, verified by typecheck+lint)
- START button now sends `/goal cc all` (continue+finish all tickets); added STEP button for single `cc`.
  file: packages/ui/src/prompt-editor/ZaicodeSaipenControls.tsx
- Suggested prompts suppressed on ZAICODE draft home.
  file: packages/ui/src/v4/SessionPane.tsx (isZaicodeProductMode guard)
- Tinted ":( Empty" draft empty-state in ZAICODE.
  file: packages/ui/src/v4/ConversationDraftEmptyState.tsx
- SAIMAIL header button gets the unread outline (gold ring); editor "Open in editor/explorer" outline removed in ZAICODE; corporate Share menu hidden in ZAICODE.
  files: ZaicodeSaimailHeaderButton.tsx, WorkspaceEditorButtonGroup.tsx, WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx
- Footer user menu: duplicate generic light/dark theme submenu hidden in ZAICODE (Wintage palettes already cover appearance).
  file: packages/ui/src/WorkspaceSidebarFooter.tsx
- Min window height 640 -> 540 (640x540 minimum now allowed).
  file: packages/desktop/src/main/desktopWindowSize.ts
- Battlezone F-group readiness meter: one black->red->amber->green bar per running worker + live running count, in ZAICODE workspace header.
  files: zaicodeTodoProgress.ts (todoReadinessRatio, readinessBarColor), ZaicodeWorkingMeter.tsx (new), ZaicodeWorkspace.tsx
- saifren-not-glm retry regression fixed: fallback de-dup ref resets whenever provider is not GLM, so undo/resend after a GLM limit re-switches to SAIFREN instead of being pinned to GLM by a one-shot key.
  file: packages/ui/src/v4/SessionPane.tsx

## Gates
- typecheck: `tsc -b packages/shared packages/ui packages/desktop/tsconfig.host.json` -> EXIT=0 (PASS)
- lint: `oxlint <10 changed files>` -> 0 errors, 0 warnings (PASS)

## Deferred (need operator asset or product decision, not code-blocked)
- Archive-all button, collapsible New-task/search toolbar (default hidden), working-first sidebar stacking, AUDAPACK MAIN0/SIDE0 priority slots, remove duplicate tasks panel, draggable/toggle todo refinements, readable-icon replacement image, custom "working" indicator image asset, subsaipen modes Hunter/Tester/Cleaner/Wikier/Translator, /goal until-done protocol semantics.
  Reason: these want either a user-supplied image asset (custom indicator, readable icons) or a larger design/protocol decision (sidebar slot system, subsaipen roles, /goal semantics change in the SAIPEN protocol repo, not this app).

## Amendment 2026-09-24 (operator asset delivered)
- Working spinner replaced with operator's SAIPEN avatar in ZAICODE mode (breathing pulse instead of spin).
  asset: packages/ui/src/assets/zaicode-working.png (from V:\___VAC\_PIC\_AVATARS\_vacuum34\__SAIPEN_Alpha_128.png, 128x128 RGBA)
  file: packages/ui/src/components/ai-elements/chat-loading.tsx (isZaicodeProductMode branch)
- Gates re-run: tsc -b shared+ui+desktop -> EXIT=0; oxlint full -> 0 errors, 69 warnings (baseline). PASS.
