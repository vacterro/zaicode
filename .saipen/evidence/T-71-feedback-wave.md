# T-71 — ZAICODE user feedback wave 2026-09-26 (SRC-051)

Verify clause: "the requested change is present and demonstrated against the
user's own description of it." Every SRC-051 item below maps to code and to a
test or a concrete build artifact. Suites at the bottom.

## The 17 items

1. **Turn-failed auto-continue only fires on project visit** — now background.
   `packages/ui/src/zaicode/zaicodeTurnRetryWatch.ts` (new) mounts once in
   `ZaicodeAppRuntime` (`useZaicodeTurnRetryWatch`), sweeps every failed brief
   the sidebar sees every 15 s + on brief pushes, and retries without walking
   into the project: the session's unfinished goal again, else SAIPEN's `cc`
   (or `continue` for plain sessions). The open pane claims its session
   (`localPanes` in `zaicodeAutoRetry.ts`) so pane and host never double-fire;
   both share `attemptsBySession`, reset on the first clean finish.
   Test: `packages/ui/test/zaicodeWave71.test.ts` — "background auto-retry"
   (failed/quiet/non-local/enabled-project/inside-budget).

2. **Dev preview launcher (temp 1-time session pulling saved settings)** —
   `tools/launcher/ZaicodeLauncher.cs` `--preview`: the flag stays in the
   launcher, a fresh `%TEMP%\ZAICODE-preview-<timestamp>` dir was intended to
   be seeded with saved settings. T-72 review found that this first version
   read `Local Storage` from the user-data root, while Electron stores it under
   `session/Local Storage/leveldb`; its directory copy was also shallow.
   T-72 corrected both defects. `ZCODE_DESKTOP_USER_DATA_DIR` /
   `ZCODE_DESKTOP_SESSION_DATA_DIR` point there (honored at
   `packages/desktop/src/main/desktopRuntimeEnv.ts:86-92`). Nothing the
   preview writes reaches the real profile; preview dirs older than 7 days are
   swept. Proof: `tools/launcher/build.cmd` compile OK, root `ZAICODE.exe`
   rebuilt (74 240 B, 26.09.26 14:30).

3. **Live sorted by recently** — `liveOrder` default `"recent"`
   (`zaicodeSidebarPrefs.ts`), one-time migration flips a stored `"closest"`
   (the old default nobody chose on purpose) to `"recent"` once
   (`zaicode-sidebar-live-order-recent` flag), Settings > Sidebar > LIVE order
   lists "Most recently active" first. Tests: wave71 "LIVE defaults" and
   "LIVE recent order".

4. **Retry creates vanishing chat** — the double Retry offer is gone: the
   ChatErrorBanner no longer carries its own "Retry now"
   (`ConversationComposer.tsx`, SRC-051 comment); exactly one owner remains,
   the AutoRetryNotice under the banner (countdown + "Retry now" / Stop).
   Interpretation note: read as the duplicate-offer defect; the retry action
   itself resumes the same session (never a new chat) — `pickZaicodeAutoRetryAction`.

5. **Theme button move** — header toolbar tool `palette` (default visible,
   `zaicodeLayoutPrefs.ts`): one click opens the whole palette menu
   (`ZaicodeHeaderToolbar.tsx` case `"palette"`); menu lines shared with the
   footer submenu via `ZaicodePaletteMenuContent` (`ZaicodeFooterMenus.tsx`),
   so both stay identical.

6. **Retry/reconnect settings (100 attempts warm)** — two halves:
   UI: Settings > Workers > "Failed turns" (`ZaicodeWorkersSettings.tsx`
   `RetrySettings`): auto-retry on/off, interval 10–3600 s, give-up 1–1000
   attempts (drives both the pane countdown and the background host).
   Engine: stream recovery budget env-driven
   (`apps/.../core/src/runtime/methods/streaming-recovery.ts`):
   `ZCODE_ZAICODE_MODE=1` → 100 attempts (was hard-coded 10),
   `ZCODE_STREAM_RECOVERY_MAX_RETRIES` overrides 1..1000.
   Tests: `core/test/streamingRecoveryBudget.test.ts` (2/2).

7. **Icon workshop for all icons** — `ZaicodeIconEditor.tsx` rebuilt as a
   workshop: slots grouped by block (nav/workspace/todo/roster/pool/footer/
   profile), per-slot text/URL override, preset packs (Theme icons / Emoji /
   Gold badges), named profiles (save/apply/delete, ≤12,
   `zaicode-icon-profiles-v1`), import/export (file + clipboard + paste).
   Pure additions in `zaicodeIconSlots.tsx`: `applyZaicodeIconOverrides`,
   `readZaicodeIconProfiles`, `saveZaicodeIconProfile`,
   `deleteZaicodeIconProfile`, `ZAICODE_ICON_PRESETS`.

8. **Project-switch sound lag** — cue `sidebar.project` on by default
   (`HORSE00.wav`, −21.5 dB) with a one-time migration for stored tables that
   predate the change (`zaicodeSoundEvents.ts` `migrateProjectSwitchCue`,
   flag `zaicode-sound-project-switch-on`); every enabled cue is decoded up
   front (`preheatZaicodeSounds`, re-warmed on table change) so the first play
   is not a fetch+decode round trip; a suspended AudioContext is resumed
   before `start()` (autoplay policy / machine wake).

9. **Working-for mini indicators on project + chatbox** — project row shows
   how long the oldest running session runs
   (`WorkspaceSidebarItem.tsx` `zaicodeWorkingSince` +
   `formatZaicodeDuration`, title + inline, compact and normal rows);
   chatbox: `ZaicodeComposerWorkingFor.tsx` next to the stop control
   (change-gated 1-minute tick from T-67's `useZaicodeGatedNow`).

10. **Todolist adaptive position** — `ZaicodeTodoDock.tsx`: free positions
    clamp into the window on every resize (`clampToWindow`), width capped to
    `min(20rem, 100vw − 2rem)` docked and detached.

11. **Duplicate worker badge** — when the project row's leading glyph already
    spins (project = MAIN view, MAIN working), the trailing badge drops its
    own icon and keeps count + duration only
    (`zaicodeMainGlyphWorking` in `WorkspaceSidebarItem.tsx`, both row
    variants).

12. **Worker icon mini-editor (colors/gradients)** — the workshop's
    BadgeDesigner: two colours, solid or gradient, up to two initials →
    `buildZaicodeIconBadgeDataUri` (pure, `zaicodeIconSlots.tsx`) bakes an
    SVG data URI into any slot — worker icons included. Test: wave71
    "icon badge builder" (data URI, escaping, solid vs gradient).

13. **Title bar center** — the center title now centers on the optically free
    band, not the header's measured midpoint: left bound
    `--workspace-sidebar-panel-width`, right bound the caption-button inset
    (`ZaicodeHeaderProjectTitle.tsx`, SRC-051 comment).

14. **SUBCHAT model/effort selection + SAIPEN default** — every chat's header
    has a model field (empty = Auto — ZAICODE's own pick, the Antigravity
    pool logic; else the vendor CLI is told `--model`/`-m`) and an effort
    select (auto/low/medium/high). Effort maps to each vendor's real knob —
    Claude: `MAX_THINKING_TOKENS` 4096/16384/31999; Codex:
    `-c model_reasoning_effort="…"`; Antigravity/ZCode CLIs have none, so it
    is ignored there (nothing invented). Persisted per conversation
    (`modelChoice`, `effort` in `ZaicodeSubchatConversation` +
    normalize; `zaicodeSubchatStore.updateZaicodeSubchatChatSettings`),
    passed through desktop (`readZaicodeSubchatTurnRequest` validates; the
    operator's model wins over auto). Tests: wave71 "subchat effort",
    "subchat persistence".

15. **Project freshness indicator** — Settings > Sidebar > Project freshness:
    off / dot / tint. Buckets fresh (≤15 m), today (≤24 h), week (≤7 d),
    stale — colours on the Win95-dark ties (`ZAICODE_FRESHNESS_COLORS`),
    driven by the newest `updatedAt` among the project's sessions
    (`WorkspaceSidebarItem.tsx` `zaicodeProjectLastActivity`, dot renders
    before the label, tint colors the label when no readiness tint owns it).
    Test: wave71 "freshness buckets".

16. **Sidebar 3 display modes logic/visual audit** — the three task views
    (grouped / workspace / timeline, `WorkspaceSidebar.tsx`
    `SidebarTaskViewMode`) all render their rows through the same
    `WorkspaceSidebarItem`, so this wave's row-level fixes (working-since,
    freshness, badge dedupe) apply identically in every mode — both the
    compact (`zaicodeCompactRow`) and the normal row variants were updated
    (WorkspaceSidebarItem.tsx:1277-1331 region). LIVE hold/recency live in
    `orderZaicodeProjectSections`, shared by every mode that floats live
    projects. No mode-specific logic drifted; nothing mode-local had to
    change. Audited by code read; row behaviors covered by wave71 tests.

17. **Tooltip flicker on hover** — `ControlHintTooltip.tsx`:
    `disableHoverableContent` (pointer jitter between trigger and card can no
    longer close/reopen the tooltip in a loop — a hint is read where it
    appears, not hovered onto) + `collisionPadding={8}`.

## Suites (all green, 26.09.26)

- ui `node --import tsx --test test/zaicode*.test.ts` → **260/260** PASS
  (wave71 8/8 new)
- services → **39/39** PASS
- desktop → **49/49** PASS
- core `node --import tsx --test test/*.test.ts` → **24/24** PASS
  (streamingRecoveryBudget 2/2 new)
- tsc --noEmit: shared, ui, desktop, services, core — 0 errors
- oxlint (ui/core/shared/desktop src): 0 errors (61 pre-existing warnings)
- launcher: `tools/launcher/build.cmd` OK → root ZAICODE.exe rebuilt
