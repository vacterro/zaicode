# ZAICODE Upstream Delta Ledger

Every upstream-owned file ZAICODE modifies, why it had to be touched, why an
additive extension was not sufficient, and the expected rebase risk. New
ZAICODE-owned files are not listed here; they are rebase-free.

Rule: prefer new ZAICODE modules and centralized capability switches; no
mechanical renaming of upstream protocol identifiers, package names, storage
schemas, environment variables or RPC contracts.

| Upstream file | Change | Why additive was insufficient | Rebase risk |
|---|---|---|---|
| `packages/shared/src/index.ts` | exports `zaicode*` contracts | barrel export is the only public surface consumers may import | trivial (one block) |
| `packages/shared/src/channels.ts` | two `ServiceChannels` entries | channel registry is a closed const map | trivial |
| `packages/shared/src/env.ts` | `ZCodeProductFlavor` gains `zaicode` | flavor type is a closed union used by every consumer | low (type + normalizer) |
| `packages/services/src/session/tasksDatabase/migrations.ts` | frozen `0004_zaicode_product` plus additive `0005_zaicode_routing_backend` | migration ledger must be one owner; routing backend adds one column with a Direct default | low; shipped ledger entries are immutable |
| `packages/services/src/node.ts` | build/register ZAICODE services, executor hook, export | assembly point is a single function; services must register in order | medium (large file, additive blocks) |
| `packages/services/src/index.ts` | browser-safe descriptor exports | public package surface | trivial |
| `packages/services/src/accessor.ts` | two optional accessor fields | accessor contract is closed to direct edits | trivial |
| `packages/client/src/remoteServiceAccess.ts` | two channel proxies | client getters are added per service by design | trivial |
| `packages/desktop/src/host/index.ts` | install/clear ZAICODE executor after service init | executor needs the live host collection; no other seam exists | medium (large file; two small blocks) |
| `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` | register both ZAICODE descriptors through a focused-tested resolver; unavailable stubs are explicit when the remote host omits them | remote collection is a closed registration list | low |
| `packages/desktop/src/main/desktopRuntimeEnv.ts` | ZAICODE runtime application name | runtime identity switch is compile-time flavored | low |
| `packages/desktop/scripts/desktop-product-identity.mjs` | ZAICODE identity entry + strict switch + AUMID lookup fix | centralized identity module is the sanctioned flavor owner | low |
| `package.json` | `dev:zaicode`, `build:zaicode`, `bundle:zaicode`, `zaicode:env:check` scripts | single canonical entrypoints; no upstream build system forked | trivial |
| `tools/start-zaicode-dev.ps1` | now consumes `ZCODE_ZAICODE_IDENTITY=1` + delegates to `pnpm dev:zaicode` | isolation+identity travel as one unit | low |
| `packages/ui/src/SettingsPage.tsx` | ZAICODE settings section render branch | settings render switch is a closed chain | low |
| `packages/ui/src/settings/settingsPageConfig.ts` | ZAICODE section entry | section registry is a closed list | trivial |
| `packages/ui/src/lib/settingsNavigation.ts` | `zaicode` section id | section id union + validator are closed sets | trivial |
| `packages/ui/src/app-shell/types.ts` | `WorkspaceMainView` gains `zaicode` | view union is closed | trivial |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | ZAICODE workspace render branch + sidebar props | view switch is a closed chain | low |
| `packages/ui/src/WorkspaceSidebar.tsx` | ZAICODE nav entry + props | sidebar nav is hardcoded JSX (not data-driven) | low |
| `packages/ui/src/ChatErrorBanner.tsx` | ZAICODE zero-provider message branch | display resolver owns message mapping | low |
| `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`, `Root.tsx`, `quickpick/quickPickCommands.ts`, `settings/CodingPlanUpgradeDialogProvider.tsx`, `settings/model-provider-section/{Detail,StatusCards,providerFamilyConnectionVisibility}.tsx` | ZAICODE mode gates for account/commercial surfaces | the gates must sit at each render surface; a wrapper would leave dead CTAs | low each; re-check on upstream UI refactors |
| `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` | `zaicode.*` keys, including backend/status/Inspector labels | locale maps are flat closed records | trivial (merge blocks) |
| `packages/desktop/src/renderer/src/desktopPlatform.ts`, `preload/index.ts`, `main/desktopMainIpcPlatform.ts`, `shared/src/{channels,platform}.ts`, `client/src/globals.d.ts` | ZAICODE launcher-preference + SAIMAIL init IPC | the platform bridge is one closed object per layer; a method missing in `desktopPlatform.ts` silently disables its Settings control | low (optional methods) |
| `packages/provider/src/model-selection-config.ts` | `isOfficialGlmAccountProviderId`; ZAICODE defers GLM account providers in the initial draft selection | initial selection is resolved in exactly one function | low |
| `packages/ui/src/v4/SessionPane.tsx` | GLM quota -> fallback model switch + toast | quota banner state lives only here | medium (large file; one effect) |
| `packages/ui/src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx` | SAIMAIL button in the first slot; editor group moves after terminal in ZAICODE mode | header action order is hardcoded JSX | low |
| `packages/shared/src/desktopMenu.ts`, `desktop/src/main/{desktopWindowsOpenFolderContextMenu,windowsCuaOperationIndicatorContent,desktopOAuthDeepLink,about}.ts` | product name ZAICODE in native menus, tray, Explorer entry (own registry key), CUA indicator, deep-link dialog | native strings live in main, outside the UI locale maps | low |
| `packages/desktop/build/icon*`, `build/icons/*`, `public/icon_512@2x.png`, `public/logo/icons/*` | binary icons replaced by the operator's SAIPEN mark (square, no rounded corners) | electron-builder reads fixed paths; upstream originals restore with `git -C zcode checkout 872ad96 -- <path>` | trivial (re-copy after rebase) |
| `packages/ui/src/App.tsx`, `WindowsTopLeftLogo.tsx`, `WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx` | app logo from `zaicode/zaicodeBrand.ts` | three hardcoded `logo-zai.svg` imports | trivial |
| `packages/ui/src/DesktopTopOverlay.tsx` | sidebar header: menu-block toggle + running-session meter | overlay owns the sidebar header row | low |
| `packages/ui/src/WorkspaceSidebar.tsx` | menu block hidden by default, default-model bar, priority slots MAIN0..SIDE2, working-first order, conversations section hidden, audio director, archive undo | sidebar layout is hardcoded JSX | medium (large file) |
| `packages/ui/src/WorkspaceSidebarItem.tsx`, `TaskList.tsx` | board strip (blocked/todo/done from the right), START = fresh `/goal cc all`, no empty-project slot, priority-group menu, one-click archive + Archive all + Ctrl+Z | row actions live in the row component | medium |
| `packages/ui/src/WorkspaceSidebarFooter.tsx`, `WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx` | Problip button; operator menu rebuilt (inline zoom/language, Help & about); header help menu removed in ZAICODE | menus are hardcoded JSX | low |
| `packages/ui/src/settingsCodePreview.tsx` | ZAICODE: UI font size +/- stepper, app-theme row hidden | the control is a local component | low |
| `packages/ui/src/v4/composer/newTaskDraft.ts` | new drafts prefer the ZAICODE default model | single seeding function | trivial |
| `packages/ui/src/v4/SessionPane.tsx` | retry/edit align the session model to the composer selection first | replay commands are dispatched only here | low |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | fresh-session requests; earlier sidebar auto-hide + auto-restore | draft creation and auto-collapse live here | low |
| `packages/desktop/src/host/zaicodeRunDispatch.ts` (ZAICODE-owned) | reasoning level clamped to the pool's supported levels | — | — |
| `apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts` | SAIPEN board verdict before the model verifier; 120 s verifier timeout | goal verification has one entry point | low |
| `packages/ui/src/DesktopTopOverlay.tsx` (T-49) | no Windows caption padding on the sidebar-width ZAICODE toolbar | the padding is set on the overlay row | trivial |
| `packages/ui/src/TaskListItem.tsx`, `WorkspaceSidebarItem.tsx`, `WorkspaceHeaderSections.tsx` (T-49) | highlight attributes + title alignment classes on session / project / header titles | titles are rendered inline in these rows | low |
| `packages/ui/src/v4/ConversationTimeline.tsx` (T-49) | virtual rows start on whole pixels in ZAICODE mode | row transform is computed inline | trivial |
| `packages/ui/src/prompt-editor/ChatPromptEditor.tsx` (T-49) | tighter message box while the SAIPEN strip is compact | shell classes are inline | trivial |
| `packages/ui/src/App.tsx` (T-49) | navigation sounds marked as echoes | the navigation effect lives in App | trivial |
| `packages/ui/src/WorkspaceSidebar.tsx` (T-49) | Group / Project row never wraps; words hide below 248 px | toolbar is inline JSX | trivial |
| `apps/zcode-cli/packages/core/src/permission/plan-mode-policy.ts` (T-49) | a model's own EnterPlanMode is denied in ZAICODE mode (`ZAICODE_AGENT_PLAN_MODE=allow` restores) | plan transitions are decided here | low |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` (T-50) | registers the ZAICODE view opener for the SCHEDULER card | the main view switch lives here | trivial |
| `packages/ui/src/v4/ConversationDraftEmptyState.tsx` (T-50) | SCHEDULER readiness card on the home screen | home screen JSX | trivial |
| `packages/shared/src/channels.ts`, `services/src/{accessor,index,node}.ts`, `client/src/remoteServiceAccess.ts` (T-56) | third ZAICODE channel `zaicode-stats`: registration, accessor field, proxy, export | same closed registries as the jobs channel | trivial |
| `packages/services/src/session/tasksDatabase/migrations.ts` (T-56) | additive `0006_zaicode_stats` (own tables `zaicode_stats_events`, `zaicode_stats_cursor`) | the migration ledger has one owner | low; `0004`–`0006` are immutable once shipped |
| `packages/desktop/src/main/index.ts` (T-56) | a packaged app that inherited `TZ` relaunches once without it | Chromium fixes its zone before any later hook | trivial |
| `packages/desktop/src/main/desktopTray.ts` (T-56) | ZAICODE mode: own tray popup menu instead of the native one | the tray is created only here | low |
| `packages/desktop/src/main/desktopApplicationMenu.ts` (T-56) | zaicode flavor leaves out What's new, Feedback, Export logs, Clear all data | the menu template is one function | low |
| `packages/ui/src/app-shell/types.ts`, `App.tsx`, `app-shell/WorkspaceShellLayout.tsx` (T-56) | `saihome` main view, startup view, SAIHOME opener, current-view mirror, render branch | the view union and switch are closed | low |
| `packages/ui/src/lib/taskNotificationOrchestrator.ts`, `hooks/useTaskNotifications.ts` (T-56) | `skipInterrupted`: a stopped turn is not "Task completed" in ZAICODE | the phase -> notification mapping has one owner | trivial |
| `packages/ui/src/WorkspaceSidebarItem.tsx` (T-56) | fixed status/action zone, New session / Files / on-off in the row menu, Shift+Click on/off, OFF dimming | row actions are inline JSX | medium (large file) |
| `packages/ui/src/WorkspaceSidebar.tsx` (T-56) | Shift + hold 2 s slot drop: collision function, drop branch, SLOTS panel mount | the project DnD context is inline | low |
| `packages/ui/src/v4/ConversationDraftEmptyState.tsx` (T-56) | SCHEDULER card removed (moved to SAIHOME); settings title "New task screen" | composer empty-state JSX | trivial |
| `packages/ui/src/WorkspaceSidebar.tsx` (T-58) | ZAICODE: project list rendered without the purpose section (no title / fold / drag), SLOTS / LIVE / + in the toolbar, no scroll mask, `data-zaicode-instant`, session briefs + CONTINUE / DONE strip mount | the section list and toolbar are inline JSX | medium (large file) |
| `packages/ui/src/WorkspaceSidebarItem.tsx` (T-58) | no grab cursor in ZAICODE, CSS hover action zone, continue handle registration, per-session continue | row JSX inline | medium |
| `packages/ui/src/TaskList.tsx`, `TaskListItem.tsx` (T-58) | optional `onContinueTask`: ▶ row action and Alt+Click | the row owns its click / actions | low |

The ledger lists upstream-owned touched files; new ZAICODE-owned source files
remain tracked in the implementation notes and are not duplicated here.

Rebase procedure: re-apply the small blocks above after each upstream update,
keep `0004_zaicode_product`, `0005_zaicode_routing_backend` and `0006_zaicode_stats` frozen (add `0007_...` for schema changes), then run
`C:\nodejs\node.exe scripts\zaicode-env.mjs --check`,
`pnpm typecheck`, `pnpm lint`, `pnpm --filter @zcode/web build` and the ZAICODE
focused tests. Expected conflicts are limited to `node.ts`, `host/index.ts` and
the settings/UI chains.
