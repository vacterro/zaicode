# ZAICODE Implementation Notes

Technical documentation for the ZAICODE product layer built on the upstream ZCode
checkout. `UI.md` remains the interface/product contract; this file covers
implementation, bootstrap, queue lifecycle, and upstream-update strategy.

## 1. Bootstrap development

- Upstream source: `zcode/` (branch `main`, baseline commit
  `872ad960de7ec172591f7e1952f7849229f94521`, package version 3.14.0,
  Apache-2.0). The upstream install is never modified; ZAICODE lives beside it.
- Toolchain: the repository pins `pnpm@10.33.2` (`package.json#packageManager`)
  and `node 24.14.0` (`mise.toml`). The isolated pnpm 10 install used here is
  `.tools/pnpm10`; the machine's global pnpm 11 ignores the pinned overrides and
  must not be used for installs.
- Every command needs a complete PATH; the agent shell does not inherit machine
  PATH entries. Prepend `.tools\pnpm10\node_modules\.bin;C:\nodejs;` plus the
  machine and user PATH.
- Install + prepare + build: `pnpm bootstrap`.
- Gates: `pnpm typecheck`, `pnpm lint` (0 errors expected; ~70 pre-existing
  warnings), `pnpm architecture:check --changed`, `pnpm --filter @zcode/web build`,
  `pnpm --filter @zcode/desktop run build:no-runtime-assets`.
- Focused tests: there is no root test runner; this feature's tests are
  `node:test` files executed with tsx from the package directory:
  `node --import tsx --test test/zaicodeJobs.test.ts` (in `packages/services`).

## 2. Starting ZAICODE

- Canonical dev/build lane: product mode and identity are centrally established by
  `zcode/scripts/zaicode-env.mjs` (`ZCODE_ZAICODE_MODE=1` + `ZCODE_ZAICODE_IDENTITY=1`)
  and assert-fail-closed on divergence. Use `pnpm dev:zaicode`, `pnpm build:zaicode`,
  `pnpm bundle:zaicode` (resp. `node scripts/dev-zaicode.mjs|build-zaicode.mjs|bundle-zaicode.mjs`).
  `tools/start-zaicode-dev.ps1` consumes the same env via `pnpm dev:zaicode`.
  The dev/build/bundle wrappers preserve the launching Node executable for
  child pnpm processes via the repository's pinned-Node path helper; the normal
  pinned launch context is supplied by `.mise.toml`.
- Legacy direct dev path (`pnpm dev:desktop:test` etc.) still obeys the two
  switches individually; the canonical ZAICODE lane never relies on callers
  remembering both.
- `tools/start-zaicode-dev.ps1` isolation: `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`,
  `ZCODE_DESKTOP_USER_DATA_DIR`, `ZCODE_DESKTOP_HOME_DIR`, `ZCODE_DATA_BASE_DIR`
  and `ZCODE_ZAICODE_MODE=1`+`ZCODE_ZAICODE_IDENTITY=1` are all pointed inside `.zaicode/`.
- The isolation is deliberate: the installed production ZCode and ZAICODE must
  not share mutable state. Verified smoke: app starts, workspace is created under
  `.zaicode/data/.zcode/workspace/default`, and production `~/.zcode/v2/setting.json`
  is not touched.
- ZAICODE product mode (`ZCODE_ZAICODE_MODE`) gates commercial/account surfaces;
  it does not remove provider login, which stays reachable through Models &
  Routing.

### Packaged app (daily use)

- Start: double-click `ZAICODE.exe` in the workspace root (or `ZAICODE.lnk`).
  The launcher (`tools/launcher/ZaicodeLauncher.cs`, build with
  `tools\launcheruild.cmd`) sets ZAICODE mode + identity + `SAIPEN_HOME`,
  runs `zcode/packages/desktop/dist/win-unpacked/ZAICODE.exe` without a console
  and restarts it after a crash (Settings toggle, `%APPDATA%\ZAICODE\zaicode-launcher.json`).
- Rebuild while the app is open: `pnpm bundle:zaicode` detects the locked live
  build and stages into `packages/desktop/dist-next/`; the launcher swaps it in on
  the next start and keeps the old build as `win-unpacked.previous`.
- Known gap: the packaged agent currently uses the default CLI data root
  (`~/.zcode/cli`), the same one as an installed production ZCode. Only the
  dev lane (`tools/start-zaicode-dev.ps1`) is fully isolated. Moving it is an
  operator decision because existing ZAICODE sessions live there.

### SAIPEN inside ZAICODE

- Agent prompt (`apps/zcode-cli/packages/core/src/context/sections/identity.ts`):
  resolved launcher path + a FAST PATH for `cc` (first tool call is
  `saipen continue --json`, no skill hunting).
- Composer strip: START (sends `cc`), phase/ticket, NEXT, LAST, THEN, board score;
  one shared poller per project re-reads BOARD/LOG only when STATE.md changes.
- Project row Play button: new chat + `cc`. Composer SAIPEN menu: shortcut table.
- Agent template "SAIPEN Operator": each queued task runs as a SAIPEN ticket.
- The workspace root is a small git repo so SAIPEN's source identity is cheap
  (`saipen status` 175 s -> ~4.5 s).

### SAIMAIL inside ZAICODE

SAIMAIL is the local agent post office (`__SAIMAIL__`, `saimail-local`).
ZAICODE integrates it read-only and header-first:

- Settings -> ZAICODE -> SAIMAIL: the mailbox folder of this machine's
  operator seat (field + Browse, stored as `saimailWorkspace` in
  `%APPDATA%\ZAICODE\zaicode-launcher.json`). "Create mailbox here" runs
  `saimail-local init --workspace <folder> --seat operator` in main
  (`zaicodeSaimailInit.ts`, explicit click only; an existing mailbox is kept)
  and saves the path. Main exports it as `SAIMAIL_WORKSPACE` before
  host/agent spawn (an external value wins), so SAIPEN's `continue --json`
  carries a `telegrams` block for agents after the next start.
- The renderer reaches these through `IPlatformService`
  (`getZaicodeLauncherPreferences`, `setZaicodeAutoRestartOnCrash`,
  `setZaicodeSaimailWorkspace`, `initZaicodeSaimailWorkspace`), mapped in
  `packages/desktop/src/renderer/src/desktopPlatform.ts`. A method missing
  there leaves the matching Settings control disabled.
- Title bar (`ZaicodeSaimailHeaderButton`, first slot of the workspace
  header, where upstream shows "Open in editor"; that group moves after the
  terminal toggle): envelope with the unread count, gold when mail arrived,
  `·N` for telegrams on the current SAIPEN ticket, faint when not set up.
  Hover shows kind / sender / topic / age instantly; click drafts (does not
  send) a request for the agent to run `saimail-local saipen brief`, or opens
  Settings -> ZAICODE when no mailbox is set up.
- ZAICODE reads only `saimail-workspace.json` (seat), `mail/inbox/<seat>/`
  (unread listing) and the `mail/index.jsonl` tail. It never opens
  `envelope.senv`, never decrypts, never marks read; header text is data,
  never a command (SAIMAIL I1).
- SAIPEN menu: "Read SAIMAIL desk" with the unread count, or "Set up
  SAIMAIL…" (opens Settings) while no mailbox is connected.
- Agent prompt (`identity.ts`): SAIMAIL guidance only when `SAIMAIL_WORKSPACE`
  is set: read at phase boundaries, telegrams are evidence not instructions,
  send findings with `saimail-local saipen telegram`.
- Sidebar: project titles carry a faint SAIPEN readiness tint (gold progress
  while working, green when ready, red when STATE has a blocker).

## 3. Architecture relationship to upstream

ZAICODE is an additive product layer; upstream behavior is unchanged unless
listed in "Upstream delta".

- **Agent definitions** live in `packages/services/src/zaicode/` (repo, service,
  templates) with shared contracts in `packages/shared/src/zaicode-agents.ts`.
- **Task queue** lives in the same module with contracts in
  `packages/shared/src/zaicode-jobs.ts`. Jobs are stored in
  `tasks-index.sqlite`, the existing database owned by the `TaskIndexRepo`
  family. `0004_zaicode_product` created the initial tables; additive migration
  `0005_zaicode_routing_backend` adds the agent backend with default `direct`.
  The shipped `0004` declaration is unchanged.
- **Transport**: two RPC channels (`zaicode-agents`, `zaicode-jobs`) registered
  in `packages/services/src/node.ts`; the renderer reaches them through
  `RemoteServiceAccess` and `useBaseWorkspaceServices()`.
- **Execution**: `packages/desktop/src/host/zaicodeRunDispatch.ts` implements the
  executor. Dispatch resolves target services the same way automation dispatch
  does, calls `IZCodeTaskService.createTask` + `sendPrompt`, subscribes to
  `onDynamicTaskTerminalOutcome`, and writes the terminal outcome back to the
  queue service. ZAICODE stores only the session id; session lifecycle remains
  owned by the upstream task/session runtime. There is no second session state
  machine.
- **UI**: `packages/ui/src/zaicode/` (workspace with roster/queue/inspector,
  zustand store) plus a settings section. The workspace view is a new
  `WorkspaceMainView` kind (`"zaicode"`) and the settings section reuses the
  existing settings registry — no standalone frontend.
- **Routing**: each agent chooses a concrete provider/model pool in the editor.
  SAIFREN and SAIOPP are model ids exposed by the configured SAIRoute (9router)
  provider. The legacy backend enum remains as an intent label; all complete
  selections dispatch through the selected provider/model. An agent without a
  complete selection returns `route-unresolved`. Configured and actual runtime
  selections are stored separately.
- **GLM off by default**: official GLM account providers
  (`account:zai-*`, `account:bigmodel-*`; legacy `builtin:*`) are detected by
  `isOfficialGlmAccountProviderId` (`@zcode/provider`). In ZAICODE mode a new
  draft never defaults to them while an operator provider (SAIRoute) is
  selectable; GLM stays pickable by hand and is the last resort. When a GLM
  session hits a quota/limit banner, `SessionPane` switches the next
  submission to the first non-GLM model and shows a toast (once per error).
- **Tool policy**: allow/deny lists and permission mode persist on the agent;
  the executor passes them to runtime enforcement, and editor saves preserve
  the lists when changing unrelated fields or plan mode.

## 4. Where agent definitions live

- Persisted table: `zaicode_agents` in `tasks-index.sqlite`
  (`packages/services/src/session/tasksDatabase/zaicode-v4.ts`, extended by
  `zaicode-backend-v5.ts`).
- Fields: stable id (`zaicode-agent:<uuid>`, never changes on rename), name,
  role, instructions, enabled, routing backend (default `direct`), model
  selection reference, provider/model id references, optional reasoning level,
  tool/permission policy, template id, timestamps. Migration 0005 adds only the
  backend column and does not rewrite existing model, provider, or policy data.
  Credentials are never stored; only provider/model identifiers are referenced.
- Built-in templates (Coordinator, Implementer, Auditor, Researcher) live in
  `packages/services/src/zaicode/zaicodeTemplates.ts`. Application logic never
  hardwires specific template or agent names.
- Every persisted row is validated with zod on read; malformed rows are reported
  as diagnostics instead of being silently dropped or executed.

## 5. Queue lifecycle

Statuses: `draft -> queued -> ready -> running -> waiting/blocked ->
completed/failed/cancelled`, with an explicit transition table in
`packages/shared/src/zaicode-jobs.ts`; terminal states never transition out.

- **Admission**: `create` inserts a `queued` row with a workspace-scoped
  `sort_order`. With **Autopilot** (`zaicode_settings.auto_run`, default on) the
  service pumps right after `create`, `resume` and every `reportRunOutcome`, so
  queued work starts by itself up to the concurrency limit. With Autopilot off,
  dispatch is explicit (`dispatch`, `pump`). The auto pump is fire-and-forget:
  failures are logged, and the stored queue stays the only truth.
- **Single-flight claim**: `dispatch` performs one atomic
  `UPDATE ... WHERE status IN ('queued','ready','blocked')`; a second dispatch
  returns the existing running row and never starts a second execution.
- **Execution lease**: the claiming service instance records `host_id` and
  heartbeats running rows every 30s. `reconcileStaleRuns` blocks running rows
  whose heartbeat is older than 2 minutes (crash/restart), so a restart never
  converts `running` into `completed`.
- **Terminal writes**: `reportRunOutcome` is conditional on `run_id` + `attempt`.
  Stale completions (an old run arriving after a retry) are rejected, and
  duplicate completion/cancel calls are idempotent.
- **Retry lineage**: `retry` creates a new row with `retry_of_job_id` pointing at
  the failed/cancelled/blocked original; the original keeps its terminal state.
- **Blocked reasons**: `agent_missing`, `agent_disabled`,
  `dispatch_unavailable` (no host executor), `interrupted_by_restart`, or the
  dispatch failure text. `resume` returns a blocked job to `queued`.
- **Concurrency**: per-workspace limit persisted in `zaicode_settings`
  (`max_concurrency_per_workspace`), default 1, clamped to 1..4. The gate counts
  running rows in storage, never UI state.
- **Ordering**: deterministic by priority desc, then `sort_order`, then
  `created_at`; `reorder` swaps positions with an adjacent eligible job.

## 6. Creating an agent and queuing a task

- UI: open the ZAICODE workspace from the sidebar, or Settings -> ZAICODE.
  - Create: "New agent" in the roster, or a template button; fill name, role,
    instructions, backend, provider/model identifiers, permission mode, save.
  - Queue a task: "Queue task" in the queue panel, pick an agent, title,
    instructions, priority; Coordinator jobs may name a delegation target.
  - Dispatch: per-job play button, or "Dispatch queue" to run up to the
    concurrency limit.
  - Settings -> ZAICODE: choose a Wintage palette, interface/code fonts, sizes,
    line height, ligatures, and crash restart behavior. Appearance persists in
    renderer storage; restart preference is in `zaicode-launcher.json` under
    Electron `userData`.
  - The plan counter opens one floating Todo window. It starts docked, can be
    detached and dragged, and remembers its window state.
  - In the ZAICODE conversation composer, START sends the SAIPEN `cc` shortcut.
    The NEXT EXACT ACTION line reads the current workspace's
    `.saipen/STATE.md` via the workspace file service every three seconds.
    It shows `—` when that state file is absent or unreadable.
- Windows launcher: `ZAICODE.lnk` opens `ZAICODE.cmd` / `ZAICODE.ps1`, which
  starts `zcode/packages/desktop/dist/win-unpacked/ZAICODE.exe` and retries
  nonzero exits when crash restart is enabled (default on; capped after five
  rapid failures). The desktop process also recovers a crashed renderer.
- Service API (host/remote): `IZaicodAgentService` (`list`, `create`, `update`,
  `duplicate`, `remove`, `listTemplates`, `createFromTemplate`) and
  `IZaicodJobService` (`list`, `create`, `dispatch`, `pump`, `cancel`, `retry`,
  `resume`, `remove`, `reorder`, `reportRunOutcome`, concurrency get/set).

## 7. Orchestration (bounded probe)

- A top-level Coordinator job may carry a delegation (operator-selected target
  agent + instructions). When the Coordinator turn completes successfully, the
  queue service creates one child job (`parent_job_id` = coordinator job) and
  pumps it through the same real dispatch path.
- Depth is exactly one: child jobs cannot carry delegation (the service drops the
  field), so no recursive spawning exists. Concurrency limits apply to the child
  as well.
- Observability: the child row and the parent linkage are visible in the queue
  and inspector; the parent's result remains its own terminal state, and the
  child is linked, not merged.

## 8. Current limitations

- UI interaction (click-through of the workspace view) was not exercised in this
  session; verification is typecheck, lint, unit tests, production web/desktop
  builds, and a desktop startup smoke. Interactive E2E is the next testing step.
- Coordinator delegation is operator-configured; the coordinator agent cannot yet
  create child jobs by itself (no runtime tool exposing queue mutation).
- Pause is not offered because the upstream runtime has no pause semantics;
  cancel is used instead.
- Provider/model fallback: the actual selection reported by the executor is
  stored (`actual_model_selection`) and displayed separately from the configured
  selection, but upstream fallback behavior itself is not re-implemented.
- SAIRoute requires a configured and enabled provider with selectable 9router
  pool models. The app does not supply 9router credentials or endpoints.
- Remote workspace service descriptors are registered, with an explicit
  unavailable stub where the remote host does not provide ZAICODE services;
  remote execution has not been validated interactively.
- UI interaction (click-through of the workspace view) has not been exercised
  in the current T-12 continuation; source and focused tests do not prove
  interactive behavior.
- Upstream pre-existing failures are not regressions: the desktop dev log emits
  `[cua-product-helper] invalid-runtime-manifest`, lint carries ~70 warnings, and
  the dev app exits by itself after idle (`app_quit`, exit 0).

## 9. Upstream update / rebase strategy

- Keep upstream edits narrow and documented. ZAICODE additions are new files
  under `packages/{shared,services,client,desktop,ui}/src/zaicode*`,
  `packages/services/src/session/tasksDatabase/zaicode-v4.ts`,
  `packages/shared/src/zaicode-routing.ts`,
  `packages/desktop/scripts/desktop-product-identity.mjs` (ZAICODE flavor),
  `packages/desktop/src/host/zaicodeRunDispatch.ts` and
  `zaicodeRemoteWorkspaceServices.ts`, plus the settings and workspace
  registrations. The per-file ledger with rebase risk lives in
  `docs/ZAICODE_UPSTREAM_DELTA.md`; the baseline receipt is
  `docs/ZAICODE_BASELINE_RECEIPT.md`.
- Upstream files touched: `packages/services/src/session/tasksDatabase/migrations.ts`
  (additive `0005_zaicode_routing_backend` entry; `0004` remains frozen),
  `packages/services/src/node.ts` (assembly),
  `packages/services/src/index.ts` + `accessor.ts`, `packages/client/src/remoteServiceAccess.ts`,
  `packages/desktop/src/host/index.ts` (executor install/clear),
  `packages/ui/src/SettingsPage.tsx`, `settingsPageConfig.ts`,
  `lib/settingsNavigation.ts`, `app-shell/types.ts`,
  `app-shell/WorkspaceShellLayout.tsx`, `WorkspaceSidebar.tsx`,
  `packages/shared/src/channels.ts`, `index.ts`, and the two locale files.
- Rebase procedure: `git fetch` upstream, update `zcode/`, re-apply the small
  upstream-file edits above (they are additive and localized), keep
  `0004_zaicode_product` as an immutable migration entry (never edit its SQL;
  add a new migration for changes), then run typecheck/lint/build and the
  ZAICODE unit tests.

## 10. Operator UI wave (T-31, 2026-09-24)

ZAICODE-owned modules added in this wave (all under `zcode/packages/ui/src/zaicode/`
unless noted):

- `zaicodeBrand.ts` — app logo (SAIPEN mark) for the window chrome; desktop
  icons in `packages/desktop/build/` are the same mark on a square background.
- `zaicodeSidebarPrefs.ts` — sidebar layout preferences (menu block hidden by
  default, priority slots MAIN0/MAIN1/SIDE0/SIDE1/SIDE2, working-first order,
  compact rows) and the published list of running sessions.
- `ZaicodeSidebarHeaderTools.tsx` — menu toggle and the running-session meter
  (count + one Battlezone readiness cell per worker) in the sidebar header.
- `zaicodeDefaultModel.ts`, `ZaicodeDefaultModelBar.tsx` — default model for
  new sessions, switched with one click (SAIRoute pools as buttons).
- `zaicodeAudio.ts`, `ZaicodeAudioPanels.tsx` — FastPrompter ambience (loop
  while any session runs; computalk1.wav at 0.03 by default) and Problip
  (interval blip metronome: six sounds, eight interval modes, skip-while-busy,
  day/week/month/total counters). Footer metronome button + Settings panels.
- `zaicodeArchiveUndo.ts` — one-click archive with a Ctrl+Z undo stack
  (single sessions and "Archive all sessions" per project).
- `apps/zcode-cli/packages/core/src/runtime/methods/saipen-goal-verdict.ts` —
  `/goal` in a SAIPEN workspace is decided from `.saipen/BOARD.md` +
  `STATE.md`: open TODO/DOING tickets continue with the next ticket; only
  human-blocked tickets left completes a continuation goal (`/goal cc all`).
  Other objectives on a clear board still go to the model verifier, which now
  times out after 120 s instead of hanging.

The composer SAIPEN strip: START (`/goal cc all` in a fresh session), STEP
(`cc` here), CLEAR (fresh empty session), phase chip tinted by board state,
and a MODES row (HUNT/TEST/CLEAN/WIKI/TRANSL/CREW) that opens a fresh session
running that SAIPEN sub-role.

## 11. Engines, workers, limits, autostart, sounds (T-34, 2026-09-24)

Subscriptions become worker engines (see UI.md "Engines, Workers, Limits and
Autostart"). Modules:

- `packages/shared/src/zaicode-engines.ts` — shared records and the pure rules:
  vendor parsers (Claude `/usage` text, Codex `rateLimits`, Antigravity
  `/usage` JSON, Z.ai monitor envelope), effective windows (elapsed reset =
  full, pool-aware gating, per-model weeklies never block the account),
  bottleneck/availability, and the autostart decision function
  (exactly-once event ids, catch-up window, wait-for-quota).
- `packages/desktop/src/main/zaicodeEngines.ts` — discovery of `~/.claude*`,
  `~/.codex*`, `agy`, the ZCode plan entry; hidden, deadline-bounded probes
  (children killed with taskkill /T); sweep timer (default 5 min, first sweep
  8 s after start), `zaicode-engines-cache.json` so the meter has numbers at
  launch; external PowerShell worker windows; HKCU Run "start with Windows"
  (points at the root launcher); next free `~/.claude-accountN` /
  `~/.codex-accountN` for a second login. IPC in `desktopMainIpcPlatform.ts`,
  push channel `zaicode:engines-changed`.
- `packages/ui/src/zaicode/zaicodeEngines.ts` — renderer mirror of the engine
  state, active engine, worker command lines (PowerShell; YOLO flags per vendor;
  the tab closes with the CLI's exit code).
- `zaicodeWorkers.ts`, `ZaicodeWorkersDock.tsx` — workers (reworked in T-36,
  section 12). Terminals use `TerminalSession` with a persistent registry key
  and an empty workspace key, so hiding or moving a worker or switching
  projects never kills it; `TerminalSession.initialInput` types the command
  once the shell prompt appears.
- `ZaicodeEngineBar.tsx` (sidebar), `ZaicodeLimitMeter.tsx` (title bar meter +
  refill/low alerts), `ZaicodeLimitViews.tsx`, `ZaicodeProjectEngines.tsx`
  (project ⋯ menu launcher row, running-worker chips).
- `zaicodeAutostart.ts` + Settings -> Engines & limits (`settings/ZaicodeEnginesSettings.tsx`).
- `zaicodeSoundEvents.ts` (+ `zaicodeSoundBus.ts`) + Settings -> Sounds
  (`settings/ZaicodeSoundSettings.tsx`): 43 action rows, WebAudio gain in dB,
  own files in IndexedDB, `data-zaicode-sound` for declarative buttons. The old
  six-cue table migrates into the `agent.*` rows.
- `zaicodeKeys.ts` — layout-independent hotkeys (`KeyboardEvent.code`).
- `zaicodeFancyZones.ts`, `ZaicodeFancyZoneOverlay.tsx` — FastPrompter Ctrl+Q
  clone: Quarters / Columns / Presets (S saves, Del removes, 10 max), picker
  under the pointer, fast mode, hotkey switch.
- `useZaicodeRightClickDrag.ts` — pointer-captured right-drag; main places the
  window at the real cursor (`zaicode:window-drag`).
- `zaicodeScrollGuard.ts` — resets hidden horizontal scroll inside the sidebar.
- `zaicodeSessionRoles.ts`, `ZaicodeRoleGlyph.tsx` — pixel role glyphs for MAIN,
  side sessions and subSaipen helpers, recorded at launch.
- `ZaicodeGroupedRowDecor.tsx` — Group view project stripe + todo cells + role.
- `saipen-goal-verdict.ts` — only secrets, money, physical, destructive, legal
  or explicitly operator-only blockers stop `/goal cc all`; everything else is
  pushed back ("decide yourself"), at most twice per blocker.

Tests: `node --import tsx --test test/zaicode*.test.ts` (packages/ui) covers the
parsers, gating, autostart, sound defaults, keys, zones, roles and SAIMAIL
history; the goal verdict test runs from `packages/services`.

## 12. Control wave: layout, timers, hotkeys, notifications, workers v2 (T-35 + T-36, 2026-09-25)

Settings get a **ZAICODE** group (`settings/settingsPageConfig.ts`): ZAICODE,
Layout & home, Engines & limits, Workers & terminal, Sounds, Notifications,
Timers, Hotkeys, Help. Everything that also has a right-click panel uses the
same component in both places.

- Runtime: `zaicode/ZaicodeAppRuntime.tsx` (mounted in `App.tsx`) runs the timer
  heartbeat, notification cards (`ZaicodeToastHost`), the Timers window, the
  in-app hotkey dispatcher and the global-hotkey bridge
  (`desktop/src/main/zaicodeGlobalHotkeys.ts`, IPC `SetZaicodeGlobalHotkeys`).
- Layout: `zaicodeLayoutPrefs.ts` (sidebar header buttons + menu lines, ordered,
  new ids append), `ZaicodeHeaderToolbar.tsx`, `ZaicodeSidebarNavBlock.tsx`,
  `ZaicodeLayoutListEditor.tsx`, `settings/ZaicodeLayoutSettings.tsx`;
  session ring and meter-cell navigation in `zaicodeSessionNav.ts`.
- Timers (FastPrompter port): `zaicodeTimers.ts`, `zaicodeDuration.ts`,
  `zaicodeProductivity.ts`, `zaicodeIntervalRules.ts`, `zaicodeTimerStore.ts`,
  `useZaicodeTimerEngine.ts`, the Timers window/tabs and the title-bar clock
  `ZaicodeTopbarClock.tsx` (mounted before the limit meter in
  `WorkspaceHeaderActionSection.tsx`).
- Notifications: `zaicodeNotifications.ts` scenarios (cards, Windows
  notification, length, quiet hours) and fresh marks (glow). Wired: agent turns
  (`hooks/useTaskNotifications.ts`), refills per named window
  (`zaicodeLimitRefills.ts` in `useZaicodeLimitAlerts`), low quota, worker
  exit/crash, autostart fire/missed, SAIMAIL arrivals, Problip goals.
- Limit meters (T-36): `zaicodeMeterPrefs.ts` — FastPrompter's gauge filters
  (hide 0% used, only engines whose 5h window can work now, per-surface scope,
  per-engine meter hide), fill direction, vendor tint, names, and the sidebar
  tile availability tint. `ZaicodeMeterSettings.tsx` is shown in Settings ->
  Engines & limits and on a right-click of the meter. Percent text uses
  `zaicodeRemainingTextColor` (readable at 0%).
- Workers v2 (T-36): a worker lives in the bottom **WORKERS panel**
  (`ZaicodeWorkersPanel.tsx`, rendered under the workspace body in
  `WorkspaceShellLayout.tsx`; split row/column/grid with draggable dividers, or
  tabs; height drag; solo) or in its own window (`ZaicodeWorkersDock.tsx`:
  snapping to halves/quarters/maximize, bottom edge docks back, magnetic edges,
  8 resize handles) or as a chip in the tray (anchor: bottom left/centre/right,
  left/right middle; label "engine · project"). Geometry rules are pure in
  `zaicodeWorkerLayout.ts`; preferences in `zaicodeWorkerPrefs.ts`; shared
  pieces in `ZaicodeWorkerParts.tsx`; the sidebar list in
  `ZaicodeSidebarWorkers.tsx`. Workers use Terminus by default:
  `TerminalSession` accepts `fontFamilyOverride` / `fontSizeOverride`, applies
  them after the face loads and repaints rows after a re-attach; the terminal
  registry's `detachDom(key, fromHost)` only detaches from the container that
  still owns the element, so moving a worker between panel and window never
  blanks it; the initial command survives a remount.
- Sounds: `ZaicodeSoundPicker.tsx` (kinds by length, audition on hover / wheel /
  arrows) in every Sounds row; Problip and a compact Ambience sit together in
  Settings -> Sounds -> Background.
- Home screen: the "Empty" marker and the empty SAIMAIL line are off by default
  (`zaicodeUiPrefs.ts` `homeRev` moves old stored values once); a hover link on
  the home block opens Layout & home.
- Memory: `ZaicodeMemoryExplainer.tsx` explains what is remembered, where
  (`~/.zcode/cli/memories/projects/<project>/memory/`), cost and scope.
- ZAICODE page: ready-made teams (`ZaicodeTeamPresets.tsx`) and a guided tour
  (`ZaicodeTour.tsx`); Help is `settings/ZaicodeHelpSection.tsx` (F1).

Tests: `test/zaicodeWave35.test.ts` (timers, durations, productivity, interval
rules, hotkeys, layout lists, session ring, sound kinds, quiet hours, refills,
text colours) and `test/zaicodeWave36.test.ts` (meter rules, split / snap /
magnet / clamp geometry, worker store, worker prefs, home migration, team
presets, worker hotkeys).

## 13. Composer, CLEAR, model binding, Dispatch (T-37, 2026-09-25)

Status: verified by unit tests and a staged build (evidence
`.saipen/evidence/T-37-composer-dispatch.md`); the GUI click-through is an
operator step (T-9).

- CLEAR empties the current session in place. New v4 command
  `clearConversation` (`shared/src/zcode-protocol-v4/command.ts`), native
  handler in `bootstrap/.../handlers/fork-edit-retry.ts`: stop the running turn
  (pauses an active goal), clear the goal, drop queued inputs, then
  `runtime.rewindConversationToStart` (core `rewind-message.ts`), the same
  same-session branch cut edit/retry use, anchored before the first user
  prompt. Nothing is deleted from the store. Refused in selection side chats.
  Settings -> Layout & home -> Composer buttons switches CLEAR to "open a new
  session" (`zaicodeUiPrefs.clearMode`).
- The model picked in a composer is what START runs next:
  `adoptZaicodeComposerModel` (`zaicodeDefaultModel.ts`) makes it the default
  for fresh sessions and releases a subscription engine selected on the
  sidebar (toast). The GLM quota fallback does not go through it.
- Drafts: switching sessions inside the 350 ms persistence debounce wrote
  nothing for the scope being left; `persistV4ComposerDraftContent` now saves
  that snapshot (mode and model of the scope kept).
- Dispatch (header button, Alt+D): project x engine / launcher, opened as its
  own PowerShell console (`launchZaicodeExternalWorker`, AUDAPACK style) or as
  an in-app worker. Launchers (Terminal, OpenCode, your own command lines) are
  edited in Settings -> Workers & terminal. Files: `zaicodeDispatch.ts`,
  `ZaicodeDispatchPanel.tsx`, `settings/ZaicodeDispatchSettings.tsx`.
- START / STEP / CLEAR hotkeys are registered by the composer strip; the
  composer that last took focus handles them.

Tests: `packages/ui/test/zaicodeWave37.test.ts`,
`apps/zcode-cli/packages/bootstrap/test/clearConversation.test.ts` (run from
`packages/services` with `node --import tsx --test`).

## 14. Router: 9router providers, keys and pools from ZAICODE (T-38, 2026-09-25)

Status: verified by unit tests, a transport test against a fake 9router and a
live read of the real one (evidence `.saipen/evidence/T-38-router.md`); GUI
click-through is an operator step.

Settings -> ZAICODE -> Router (9router), also opened from the SAIRoute label of
the sidebar pool row. 9router stays the owner of providers, keys, models and
pools; ZAICODE calls its dashboard API with 9router's own CLI credential
(computed in main, never sent to the renderer) and re-reads after every change,
so the dashboard and ZAICODE agree (decision D-8).

- Overview: running / not reachable, version (warns when the 9router_extra
  patches are missing), today's requests and tokens, Start (`9router -t
  --skip-update`), Open dashboard, and 9router_extra's `apply-update.ps1` run
  in a visible console after a confirm.
- Providers & keys: every connection with on/off, Test and remove; add an
  OpenAI- or Anthropic-compatible provider with its key in one step; add
  another key to a custom provider (9router rotates them as a key pool).
  OAuth subscriptions are connected in the 9router dashboard.
- Pools: strategy (Fallback / Round robin / Fusion), ordered model list with
  move / remove, add a model with search over 9router's models, create and
  delete pools.
- Files: `shared/src/zaicode-router.ts` (allow-list, records),
  `desktop/src/main/zaicodeRouterTransport.ts`, `desktop/src/main/zaicodeRouter.ts`,
  `ui/src/zaicode/zaicodeRouter.ts`, `ui/src/settings/ZaicodeRouter*.tsx`.

## 15. Vendor subscriptions as in-app models (T-40, 2026-09-25)

Status: unit-tested; not yet exercised against a live 9router list (evidence
`.saipen/evidence/T-40-vendors-as-models.md`).

A vendor CLI runs its own agent loop, so it cannot be a ZAICODE model. A
subscription connected in 9router (Codex, Antigravity, Claude Code, …) can:
9router serves it as `<alias>/<model>` over the same `/v1` endpoint the
SAIRoute provider uses. Router -> "Subscriptions as models" lists those models
per connection and adds one to the SAIRoute provider (Add), optionally making
it the default for new sessions (Use). The sidebar engine tile's menu has
"Use <short> inside ZAICODE as a model…". The quota is the CLI's own; vendor
terms on proxying consumer subscriptions apply.

## 16. Calm interface, local time, reset readings, sound picker (T-39, 2026-09-25)

Status: unit-tested (including a regression pair for the reset reading) and
bundled; GUI behaviour is an operator check (evidence
`.saipen/evidence/T-39-calm-clock-resets-sounds.md`).

- Calm interface (Settings -> Layout & home, hotkey `ui.calm`): no animations
  or transitions, no dimming or blur, no hover pop-ups; `<html>` classes
  `zaicode-no-motion`, `zaicode-no-dim`, `zaicode-no-popups`.
- Local time: ZAICODE main removes an inherited `TZ` before anything is
  spawned (`zaicodeTimeZone.ts`), so clocks, timers and agents use the Windows
  zone. The clock has a 12-hour switch that every time display follows
  (`formatZaicodeTimeOfDay`), plus weekday, year, ISO week and zone name.
- Claude quota resets are read in the zone the CLI prints; a reset further
  away than its window is dropped as a misread.
- Sound picker: click listens, wheel / arrows listen while "listen" is on,
  double-click / Enter / "use" picks; hovering is silent and never scrolls;
  a closed picker changes only on Shift+wheel.

## 17. Agent-initiated delegation (T-10, 2026-09-25)

Status: service-level tests with the real queue and a real folder; not yet
exercised with a live coordinator model (evidence `.saipen/evidence/T-10-delegation.md`).

Within the operator's rules (SRC-033): only a running top-level coordinator
job delegates, depth exactly 1, at most N helpers per job (default 3, 0 = off),
allowed helper roles, parent link on every child, the run id as the token. The
coordinator's prompt names a request folder; the agent writes `<name>.json`
(`role` or `agentId`, `title`, `instructions`), ZAICODE answers in
`<name>.result.json` and reports each helper's final state as
`<childJobId>.done.json`. Settings -> ZAICODE -> Delegation holds the limits.

## 18. System Read Model (T-41, 2026-09-25)

Status: unit-tested, live-checked against this workspace's SAIPEN 8.0.1
(evidence `.saipen/evidence/T-41-read-model.md`).

One answer to "is this project working": `ZaicodeProjectRuntimeSnapshot`
(`shared/src/zaicode-runtime-snapshot.ts`) is assembled per project from the
owners' facts -- SAIPEN's own projection (`saipen status --json`, run and cached
by the desktop main process until STATE/BOARD/LOG change), running and waiting
sessions, and workers. `zaicodeProjectRuntimeState` is the one verdict
(blocked / waiting / working / pending / done / idle) and
`ZAICODE_RUNTIME_STATE_COLOR` its one colour; the sidebar strip, the composer
chip and the SAIPEN pane all read it.

- ZAICODE does not re-interpret the protocol: phase, next action, blocker and
  the next ticket printed on the composer and the SAIPEN pane come from the
  projection (`zaicodeSaipenHeadline`); BOARD/LOG parses are display only
  (progress bars, titles, the log list). Without a projection (no launcher,
  remote workspace, error) the file parse is used and marked `source: "files"`.
- The /goal verdict in the agent CLI asks the same projection first
  (`readSaipenGoalProjection`: SAIPEN_HOME, else STATE's `saipen_home`); the
  board parse only names BLOCKED tickets for the autonomy push and is the
  fallback when SAIPEN cannot answer.

## 19. Full-system headless E2E (T-44, 2026-09-25)

Status: 10/10 PASS on this machine (evidence `.saipen/evidence/T-44-e2e/`).

`packages/ui/test/e2e/zaicodeSystem.e2e.ts` drives cold start -> SAIPEN
projection -> engines -> START's `/goal cc all` verdict -> Work claimed by a
worker process -> SAIMAIL telegram between two real seats -> worker killed and
the next generation resuming the same ticket -> router outage and recovery ->
a restarted read path -> VERIFY -> DONE, asserting ZAICODE's own read paths at
each step. GUI-only steps are printed in the report for the operator (T-9).

## 20. Overflow, Color Studio, notification delivery, reset glow, LOG order, photo list (T-45, 2026-09-25)

Status: unit-tested (`ui/test/zaicodeWave45.test.ts`), GUI behaviour is an
operator check (evidence `.saipen/evidence/T-45-ui-wave.md`).

- Icon rows never clip: the header toolbar moves what does not fit into a
  "⋯" panel (`ZaicodeOverflowRow`), other rows wrap.
- Color Studio (Settings -> Colors): theme -> own themes (all 21 colours,
  copy / rename / delete / from one colour / export / import) -> whole-palette
  shifts -> single overrides of any app colour variable; contrast report,
  live preview, undo.
- Notifications: Deliver to Per moment / In-app / Windows / Both; native
  Windows toasts from the main process (`zaicode:show-notification`).
- Reset glow: every reset whose time passed glows at once; it ends by the
  operator's rules (time, seen, clicked, quota in use) and can fade.
- SAIPEN pane LOG: oldest-first / newest-first. Profile photos: kept in a
  list, right-click delete with confirmation.

## 21. Zero-setup SAIFREN / SAIOPP router (T-46, 2026-09-25)

Status: main-process chain proven against a real, fresh 9router (8/8,
including the first token through SAIFREN from the real free providers, a
crash that heals itself, and the Autotroubleshoot repairs); app side unit
tested; evidence `.saipen/evidence/T-46-zero-setup-router.md`.

- Router host (`desktop/src/main/zaicodeRouterHost.ts`, `zaicodeRouterProcess.ts`):
  Auto / My 9router / ZAICODE's own. ZAICODE's own 9router runs from the
  shipped package under ZAICODE's executable as Node: nothing to install.
- Setup (`zaicodeRouterSetup.ts`, `zaicodeRouterBootstrap.ts`, catalog
  `shared/src/zaicode-free-catalog.ts`): keyless free providers wired into
  9router, SAIFREN created or topped up, SAIOPP present, ZAICODE's own 9router
  key, first-token probe. The app side (`ui/src/zaicode/useZaicodeRouterAutoSetup.ts`)
  adds the SAIRoute provider with SAIFREN + SAIOPP and makes SAIFREN the
  default for new tasks when no working default exists.
- Free-model scan: daily; new free models from the providers' own lists are
  appended and announced ("Today free model X added to SAIFREN").
- Router -> Overview: Autotroubleshoot (router, credential, pools, key, first
  token, per-model probes), Scan now, one-paste free keys (OpenRouter, Gemini,
  Groq, NVIDIA NIM, Cerebras, Mistral, OpenCode Zen), SAIOPP via the router's
  OAuth provider page.

## 22. Highlights & motion, message box, crisp resize, sound fixes (T-49, 2026-09-25)

Status: unit-tested (`ui/test/zaicodeWave49.test.ts`, core `test/zaicodePlanMode.test.ts`);
GUI behaviour is an operator check (evidence `.saipen/evidence/T-49-ui-wave.md`).

- Highlights & motion (Settings -> ZAICODE): the Working icon (picture, motion,
  speed, reach, size, direction, ticks, colour, glow, keep moving in the calm
  interface) and seven highlight targets, each with effect, shape, colour,
  strength and speed. `zaicode/zaicodeHighlights.ts` returns `data-zh*`
  attributes and custom properties; `zaicode/zaicodeMotionCss.ts` animates one
  registered number (`--zh-k`) per effect and draws every shape from it, so
  any effect works with any shape and nothing runs in JavaScript per frame.
- Message box: compact mode (one row of square icon buttons) and a switch for
  every part of the SAIPEN strip (`zaicodeComposerPrefs.ts`,
  `prompt-editor/ZaicodeSaipenCompact.tsx`).
- Crisp after resize: `zaicode/zaicodePixelSnap.ts` moves centred columns and
  worker terminals by their sub-pixel remainder; chat rows and worker windows
  use whole pixels.
- Sounds: navigation sounds are echoes of the action that caused them and stay
  silent right after it (`zaicodeSoundBus.ts`); the sound picker takes several
  kinds at once and keeps the search box focused.
- Agents in ZAICODE never switch themselves into plan mode (SAIPEN plans);
  `ZAICODE_AGENT_PLAN_MODE=allow` restores the tool.
- SAIFREN / SAIOPP: 1 000 000 context, 131 072 output.

## 23. Hit and go, SCHEDULER, responsive agent workshop (T-50, 2026-09-25)

Status: unit-tested (`ui/test/zaicodeWave50.test.ts`, `desktop/test/zaicodeHitAndGo.test.ts`);
GUI behaviour is an operator check (evidence `.saipen/evidence/T-50-agents-scheduler.md`).

- Hit and go: an empty job text is `/goal cc all`; a slash command or a bare
  SAIPEN shortcut reaches the agent alone and first (`isZaicodeRawCommand`,
  executor `buildZaicodeJobPrompt`). An agent without a pool runs on SAIFREN
  (`pickZaicodeFallbackPool`). Built-in template "Autopilot" carries
  `hitAndGo: true`; the ZAICODE header's Hit & go button and pool schedules
  in sections use it (made on first use, never by name).
- SCHEDULER = the T-34 autostart engine with sections, agents, a watched
  subscription and a stop time (`shared/src/zaicode-engines.ts`,
  `ui/src/zaicode/zaicodeAutostart.ts`, `zaicodeScheduler.ts`). Surfaces: the
  sidebar menu line, the ZAICODE workspace Scheduler tab
  (`ZaicodeSchedulerPanel.tsx`), the home-screen card and the "prompt ready"
  glow on limit meters (`ZaicodeSchedulerBits.tsx`, highlight `meterPrepared`).
  `ZaicodeAppRuntime` publishes the open projects and the local agent queue
  for the runner; `WorkspaceShellLayout` registers the ZAICODE view opener
  (`openZaicodeWorkspaceView`).
- The upstream Automations line is no longer offered in the ZAICODE menu.
- The agent workshop's inspector overlays the queue below 1100 px.

## 24. SAIHOME, local statistics and the T-56 batch (T-56, 2026-09-25)

Status: unit-tested (`ui/test/zaicodeSaihome.test.ts`, `ui/test/zaicodeWave56.test.ts`,
`services/test/zaicodeStats.test.ts`, `desktop/test/zaicodeTrayMenu.test.ts`,
`desktop/test/zaicodeTimeZone.test.ts`); GUI behaviour is an operator check
(evidence `.saipen/evidence/T-56-saihome.md`).

SAIHOME is the operator home ("what is happening?"); NEW TASK stays the
composer ("what do I want to start?"). They are different views and opening
SAIHOME has no execution side effect.

- View: `WorkspaceMainView` gains `saihome` (`app-shell/types.ts`). App.tsx
  picks the first view from Settings -> Layout & home -> Startup (SAIHOME by
  default, Last active, New task). `WorkspaceShellLayout` renders
  `zaicode/home/ZaicodeHomePage.tsx`, registers `openZaicodeHomeView()`
  (`zaicodeActions.ts`) and mirrors the current view (`mainView`) for the
  sidebar highlight and the "Last active" memory. Entries: the SAIHOME menu
  line (first, `zaicodeLayoutPrefs.ts`), header tool `home` (off by default),
  hotkey `ui.home` (Alt+H), tray menu.
- One snapshot: `ZaicodeHomePage` assembles every module's slice from the
  owners' stores (engines, meter prefs, SCHEDULER, router + router host,
  running / waiting sessions, workers, SAIPEN via T-41's
  `useZaicodeProjectRuntime`) plus one feed (`home/zaicodeHomeFeed.ts`: stats,
  recent activity, all queue rows, router refresh), refreshed on open and every
  N seconds only while visible. Pure read model `home/zaicodeHomeModel.ts`
  (limits wall rows with truth state, queue counts, routing health, NEEDS YOU
  items with what / why / impact / one action). Project probes
  (`home/ZaicodeHomeFleet.tsx`) reuse the sidebar's shared SAIPEN pollers.
- Local statistics: migration `0006_zaicode_stats`
  (`services/src/session/tasksDatabase/zaicode-stats-v6.ts`) adds
  `zaicode_stats_events` (stable source-scoped ids, token columns NULL when
  unmeasured) and `zaicode_stats_cursor`. `services/src/zaicode/zaicodeStatsService.ts`
  (channel `zaicode-stats`) reads the agent usage store read-only
  (`model_usage`, `turn_usage`, joined to `session.directory`;
  `zaicodeStatsSources.ts`), finished queue runs (`zaicode_jobs`) and worker
  sessions the renderer records (`useZaicodeWorkerStatsRecorder`). Replays and
  restarts insert nothing twice (INSERT OR IGNORE, cursor + 5 min overlap);
  Clear sets a floor so nothing older is read back. Aggregation
  (`shared/src/zaicode-stats.ts`): quarter-hour SQL buckets turned into local
  days with Intl in the operator's IANA zone (DST / zone change / rollover
  safe), periods today / yesterday / last 7 / week / last 30 / month / all,
  streaks, grid intensity, documented derived metrics with "not enough data".
- Clock: `home/ZaicodeAnalogClock.tsx`, SVG, own 1 Hz state (smooth sweep only
  while motion is allowed); nothing else re-renders per second.
- Event journal: `home/zaicodeHomeJournal.ts`; `notifyZaicode()` records the
  work-relevant scenarios before card / quiet-hour filters; the Recent card
  merges it with queue runs and worker sessions.
- Settings: `home/ZaicodeHomeSettings.tsx` in Layout & home (startup, preset,
  density, reset layout, clock, statistics measure / week start / grid days,
  refresh, privacy: explanation, JSON export, clear). The old "Home screen"
  block is now "New task screen"; the SCHEDULER card left the composer.

Other T-56 items:

- Clock time: an inherited `TZ` (agent shells export `TZ=UTC`) is removed by
  the launcher (`ZaicodeLauncher.cs`, `ZAICODE.ps1`) and, for a packaged app
  that still got one, `shouldRelaunchForLocalTimeZone` relaunches once
  without it (Chromium fixes its zone before main runs).
- A turn the operator stopped (`completedInterrupted`) raises no "Task
  completed" card (`taskNotificationOrchestrator.ts`, `skipInterrupted`).
- Tray: ZAICODE draws its own right-click menu (`main/zaicodeTrayMenu*.ts`,
  Golden Default tokens) without Clear all data / update check / About; the
  zaicode flavor's application menu drops What's new, Feedback, Export logs and
  Clear all data; the footer Help menu offers ZAICODE Help instead of the
  vendor's docs / issue form.
- Project row: a fixed 60 px zone (idle: working / waiting / OFF; hover: MAIN,
  START, more) so the name never moves; new session and files moved into the
  more menu. Worker rows keep their buttons laid out (no height jump).
- Shift+Click switches a project off / on (`zaicodeProjectSwitch.ts`; service
  `setWorkspaceDisabled`, setting `disabled_workspaces`): dimmed, OFF badge,
  queue `pump` skips it, the SCHEDULER skips it.
- Shift + drag and hold 2 s opens the SLOTS drop panel (`ZaicodeSlotDrop.tsx`):
  every slot, also empty or folded, is a target.
- Timers, SCHEDULER and quiet hours use `ZaicodeTimeField` /
  `ZaicodeMomentField` (`ZaicodeTimeFields.tsx`, parser `zaicodeClockText.ts`):
  typed 24-hour times, 00:00 is midnight, explicit All-day box on sound rows,
  no native picker.

## 25. Sidebar speed, CONTINUE ALL / DONE, mixes, Freebuff metrics (T-58, 2026-09-25)

Source: SRC-043 (nine operator items).

- Sidebar lag: every project row used to subscribe to whole lists (running
  sessions, waiting sessions, every worker); any streaming update or a worker
  window drag re-rendered all rows. Rows now read counts through selectors
  (`zaicodeProjectRuntime.ts`, `useZaicodeWorkersSelector` in
  `zaicodeWorkers.ts`, the worker chips' signature string), the session-nav
  store keeps unchanged `waiting` / `recent` / `projectList` arrays
  (`zaicodeSessionNav.ts`), the scroll container has no CSS mask in ZAICODE
  mode, `[data-zaicode-instant]` removes every transition inside the sidebar,
  and a compact project row mounts its actions once and swaps status /
  actions with CSS `group-hover` (no React render per hover).
- Projects root: in ZAICODE mode the project list renders without the
  `WorkspacePurposeSection` (no title, no fold, no section drag); an old
  folded preference is ignored (`projectsSectionOpen`). SLOTS / LIVE / + moved
  into the toolbar row. The row's `cursor-grab` is gone (drag unchanged).
- Continue (`zaicode/zaicodeContinue.ts`, host half `zaicodeContinueHost.ts`):
  the sidebar publishes one `ZaicodeSessionBrief` per loaded session; each
  project row registers how to reach its own host. Sending uses the off-peak
  resume path: `resumeTask` (hydrates a cold session), then one v4 command --
  `sendGoalCommand` for a goal (never "/goal ..." as prose), `sendText`
  otherwise, `heldQueueDisposition: keepQueueAndSend`. A project without MAIN
  gets `createTask` + the command, and the new session becomes MAIN.
  `planZaicodeContinueAll` is pure and tested; the button shows the plan
  before the click. `zaicodeDoneUnseen` orders unseen finished sessions
  oldest first; opening clears `unreadAt` (upstream navigation), so DONE walks
  them like an inbox. Hotkeys `session.nextDone` (Alt+Right) and
  `session.continueAll` (unbound).
- SAIHOME probes are ref-counted (`ZaicodeHomeFleet.tsx`): the sidebar strip
  and SAIHOME both mount them; a project's row leaves the store only when its
  last probe unmounts.
- Mixes (`zaicodeCombo.ts`, `ZaicodePrefCombo`): highlight rules hold
  `effects[]` / `shapes[]`, the Working icon `images[]` (up to three stacked)
  and `motions[]`; old single values are read as one-item lists. CSS: each
  effect animates its own registered channel `--zh-e-*`, `--zh-k` is their
  product; shapes match with `~=`; underline + bar share one box-shadow;
  mixed icon motions animate `--zw-r1..r3/ry/s/ty/o1/o2` read by one
  transform / opacity; a single motion keeps the plain keyframes.
- Opacity bug: blink / breathe animate `opacity`, which overwrote the slider;
  the resting opacity is now `filter: opacity()`. Reach sets Blink's dark
  phase (`--zw-blink-low`).
- Black on black: `body` had no colour, so portaled surfaces (Timers) that
  forgot a text class drew browser-default black; ZAICODE sets
  `html.zaicode-fonts body { color: var(--color-foreground) }`.
- Clock: countdowns bold in FastPrompter's colours; the reset label in the
  vendor colour (`zaicodeProductivityColor`, `ZAICODE_CLOCK_INTERVAL_COLOR`).
- Freebuff (metrics only): vendor `freebuff` (`ZAICODE_METRICS_ONLY_VENDORS`,
  `isZaicodeMetricsOnlyAccount`), parser `parseFreebuffSession` (Freebucks
  day pool = remaining of limit, wallet in the plan line; legacy plan / free
  pools kept apart), desktop discovery from Freebuff Desktop's
  `~/.config/freebuff-desktop/state.json` (proven codebuff host entries
  only) and one read-only GET to `www.codebuff.com/api/v1/freebuff/session`
  (no redirects, 512 KB cap, token only in the header). Config
  `readFreebuff` (default on). Launch surfaces use
  `launchableZaicodeAccounts`; `launchZaicodeWorker` refuses metrics-only
  accounts.
