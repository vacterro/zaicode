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
