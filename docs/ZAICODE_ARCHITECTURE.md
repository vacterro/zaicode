# ZAICODE Architecture — upstream ZCode subsystem map

Scope: source-verified map of the upstream checkout at
`zcode/` (commit `872ad960de7ec172591f7e1952f7849229f94521`, branch `main`,
package version 3.14.0, Apache-2.0). All paths below are relative to `zcode/`
unless stated otherwise. Verification: direct source reads; no fixes implied.

Related sources: handoffs `SRC-001`–`SRC-005`; account-independence directive
`SRC-002`.

## 1. Agent definitions

| Topic | file:line | Symbol | Owns |
|---|---|---|---|
| Agent profile contract | `apps/zcode-cli/packages/core/src/subagent/profile.ts:21` | `AgentProfile` | name, description, systemPrompt, tools, skills, mcpServers, modelSelection, permissionMode, memory, background |
| Built-in Explore | `.../core/src/subagent/profile.ts:66` | `createBuiltInExploreAgentProfile` | read-only toolset |
| Built-in general-purpose | `.../core/src/subagent/profile.ts:115` | `createBuiltInGeneralPurposeAgentProfile` | tools `["*"]` |
| Built-in/user merge | `.../core/src/subagent/profile.ts:89` | `normalizeAgentProfiles` | built-ins registered first; user/project override by name |
| Markdown profile parse | `.../core/src/subagent/profile.ts:154` | `parseAgentProfileFromMarkdown` | frontmatter -> profile; required name/description |
| Project-profile hardening | `.../core/src/subagent/profile.ts:185`, `apps/zcode-cli/packages/bootstrap/src/subagents.ts:115` | permissionMode strip | project `.zcode/agents` cannot escalate to bypass/yolo |
| User/project loader | `apps/zcode-cli/packages/bootstrap/src/subagents.ts:49` | `loadZCodeAgentProfiles` | `<storageRoot>/agents` (user) + `<cwd>/.zcode/agents` (project) |
| Plugin loader | `.../bootstrap/src/subagents.ts:126` | `loadPluginAgentProfiles` | `agents/<name>.md`, namespaced ids |
| Override state | `.../bootstrap/src/subagents.ts:256` | `readAgentState` | `v2/agents-state.json`: disabled ids, model overrides |
| Runtime wiring | `.../bootstrap/src/app/create-app.ts:208` | `zcodeSubagentProfiles` | profiles into app config |
| UI CRUD types | `packages/shared/src/subagents-types.ts:43,91,148` | `AgentSummary`, `SubAgentConfig`, `createAgentStateId` | agent list/create/update/delete contract |
| CRUD service (desktop) | `packages/services/src/subagents/subagentsService.ts:543-754` | `createSubagentsService` | persistence of user/plugin agents + overrides |

## 2. Subagent spawn, model override, permissions

| Topic | file:line | Symbol | Owns |
|---|---|---|---|
| Execution contract | `apps/zcode-cli/packages/contracts/src/interfaces/subagent.port.ts:113` | `SubagentPort` | launch/run/start/stopTask/sendMessage |
| Override contract | `.../contracts/src/interfaces/subagent.port.ts:24` | `SubagentRunOptions.modelOverride` | explicit per-run override |
| Port implementation | `.../core/src/subagent/runner.ts:131` | `createExploreSubagentPort` | task spawn, watchdog, registry |
| Selection precedence | `.../core/src/runtime/helpers/subagent-selection.ts:15` | `resolveSubagentSelection` | override > profile model > parent; unresolved explicit -> error, no silent fallback |
| Child runtime | `.../core/src/runtime/methods/subagent.ts:239` | `new AgentRuntime(...)` | per-subagent child runtime |
| Child permission mode | `.../core/src/runtime/methods/subagent.ts:473` | `resolveSubagentPermissionMode` | Explore defaults yolo; others inherit parent |
| Child tool allowlist | `.../core/src/runtime/methods/subagent.ts:490` | `resolveSubagentToolAllowlist` | parent ∩ profile, forced disallow, MCP filter |
| Agent tool entry | `.../core/src/tool/handlers/agent.ts:174,287` | `agentHandler`, `taskToolEntry` | tool call -> port.launch; Claude-Code `Task` alias |
| Permission engine | `.../core/src/permission/service.ts:82,97,136` | `PermissionService`, `checkPermission`, `mode.yolo` | allow/ask/deny engine; `auto` mode unimplemented |
| Tool gate | `.../core/src/tool/executor/permission-flow.ts:41` | `resolveToolPermission` | context, rules, hooks, broker race, verdict |

## 3. Session lifecycle

| Topic | file:line | Symbol | Owns |
|---|---|---|---|
| Create (V4) | `.../bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts:35` | `createSession` | draft semantics, config apply |
| Create core | `.../bootstrap/src/zcode-protocol/server-operations.ts:1237` | `createSessionWithProjection` | record materialization + registry |
| Resume legacy | `.../bootstrap/src/zcode-protocol/server-operations.ts:1518` | `resumeSession` | rehydrate persisted record |
| Cold resume (V4) | `.../bootstrap/src/zcode-protocol-v4/cold-session-resume.ts:43` | `ColdSessionResumeCoordinator` | cold subscribe/resume |
| Runtime resume | `.../core/src/runtime/methods/resume.ts:59` | `resumeFromStore` | messages, mode, permissions, todos, goal |
| Stop | `.../bootstrap/src/zcode-protocol/server-operations.ts:2584` | `stopSession` | aborts active turn; goal -> paused (2606). No pause state |
| Turn machine | `.../core/src/agent/turn-state.ts:25,44,181` | `TurnPhase`, `TurnState` | idle..completing/error; guarded transitions |
| Event projection | `.../contracts/src/events/event-reducer.ts:74` | `EventReducer` | `SessionProjection` from events |
| Store contract | `.../contracts/src/interfaces/session-store.port.ts:1089` | `SessionStorePort` | session/message/entry/todo/target facts |
| SQLite store | `.../adapters/src/storage/session-store/sqlite-session-store.ts:225-738` | `SqliteSessionStore` | CLI-owned agent session DB (`~/.zcode/cli/db/db.sqlite`) |
| Residency | `.../bootstrap/src/zcode-protocol/session-resident-pool.ts:57` | `SessionResidentPool` | idle TTL 10 min, high-water 16, LRU |
| Desktop sessions | `packages/services/src/zcode-session/zcodeSessionService.ts:221-486` | `createSession`, `resumeSession`, `setModel`, `setMode` | desktop-continuous lifecycle over agent service |

## 4. Queue-like structures and classification

Classified per handoff rule (never call it a task queue just because the symbol says queue).

| # | Structure | file:line | Payload | Persistence | Classification |
|---|---|---|---|---|---|
| 1 | `RuntimeCommandQueue` | `.../core/src/runtime/command-queue.ts:144` | `RuntimeCommand` (prompt, continuation, task-notification, subagent-message, control) | in-memory | execution queue |
| 2 | `CommandInbox` | `.../bootstrap/src/zcode-protocol-v4/command-inbox.ts:107` | `CommandEnvelope` | in-memory + durable lookups; settled LRU 512/session | UI pending-input queue |
| 3 | `session_input` ledger | `.../adapters/src/storage/session-store/migrations.ts:685`; repo `.../repositories/session-inputs.ts:34` | text/attachments/intent, delivery startNow/guide/queue, status admitted/promoted/... | durable sqlite (CLI store) | session queue |
| 4 | `ActiveTurn.pendingInputs` | `.../core/src/runtime/types.ts:775`; `.../runtime/methods/steering.ts:57` | `PendingTurnInput[]` | in-memory (durable shadow #3) | UI pending-input queue |
| 5 | `QueueState` projection | `packages/shared/src/zcode-protocol-v4/snapshot.ts:208` | `QueueItem[]`, autoDrain, pauseReason | not persisted | UI pending-input queue |
| 6 | Queue commands | `.../bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts:71-291` | delete/edit/reorder/setAutoDrain/sendQueuedNow | via #3 | UI pending-input queue |
| 7 | Session mailbox | `.../adapters/src/mailbox/index.ts:15`; hook `.../core/src/hooks/session-mailbox.ts:11` | `SessionMailboxEnvelope` | durable files unread/->read/ | notification queue |
| 8 | `InMemoryRuntimeTaskRegistry` | `.../core/src/runtime-task/registry.ts:112` | `RuntimeTaskSnapshot` (agent/bash/workflow/mcp) | in-memory | background-task queue |
| 9 | `BackgroundTaskTracker` | `.../core/src/tool/executor/background-tasks.ts:86` | pollers/snapshots | in-memory | background-task queue |
| 10 | Background notifications | `.../core/src/runtime/methods/background-notifications.ts:10,166` | `TaskNotificationRuntimeCommand` + ledger row | in-memory queue + durable #3 row | notification queue |
| 11 | `automations` + `automation_runs` | `packages/services/src/session/tasksDatabase/schema-v1.ts:81,127`; `automationRepo.ts:224,689` | `ZCodeAutomation`, run ledger with `running/claimed_at/dispatch_status/attempts/retry_at` | sqlite `~/.zcode/v2/tasks-index.sqlite` (WAL, BEGIN IMMEDIATE) | persistent work queue |
| 12 | `off_peak_tasks` | `schema-v1.ts:148`; `offPeakTaskRepo.ts:155,552` | `ZCodeOffPeakTask`, FIFO `queued_at ASC`, stale reclaim 10 min | sqlite tasks-index | persistent work queue |
| 13 | Off-peak settle outbox | `offPeakTaskRepo.ts:793` | terminal rows `settled_at IS NULL` | sqlite | notification queue |
| 14 | Desktop cron scheduler | `packages/desktop/src/scheduler/index.ts:87` | dispatch requests for #11/#12 | works on tasks-index | persistent work queue (dispatcher) |
| 15 | Dynamic-workflow `AskScheduler` | `apps/zcode-cli/packages/dynamic-workflow/src/engine/scheduler.ts:38` | ask nodes per actor | in-memory + durable `dwf_*` journal (`session-store/migrations.ts:797`) | persistent work queue (journal-backed) |
| 16 | Legacy `WorkflowGraphScheduler` | `.../core/src/workflow/scheduler.ts:34` | workflow nodes | JSON snapshot + events.jsonl | persistent work queue |
| 17 | Host task command queue | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:258,489` | `ZCodeTaskRuntimeCommand` (`send_prompt`) | in-memory Map per task | session queue |
| 18 | Task owner lease | `packages/desktop/src/main/taskRealtimeBus.ts:843-917` | owner command routing | in-memory; runId stale fence | transient ordering mechanism |
| 19 | `tasks` / `task_groups` index | `schema-v1.ts:3-66`; `taskIndexRepo.ts:481` | task catalog rows | sqlite tasks-index | unrelated to work queue (task catalog) |
| 20 | `CuaAgentAdmissionGate`, agent spawn single-flight | `cuaAgentAdmissionGate.ts:20`; `zcodeAgentProcessManager.ts:845` | spawn admission | in-memory | unrelated (resource gates) |

Runtime admission semantics: `.../core/src/runtime/methods/prompt-admission.ts:20`
(busy -> steer or deferred enqueue), `steering.ts:57,201`,
`runtime-command-queue.ts:23-111` (single-flight drain, foreground promotion
lease), auto-drain gate `.../zcode-protocol-v4/queue-auto-drain.ts:7`
(drains only when autoDrain ∧ queued ∧ idle ∧ goal complete).

## 5. Durable-queue reuse verdict (handoff M2 question)

Durable queues exist and are extendable: `automations`/`automation_runs`,
`off_peak_tasks` (both in `tasks-index.sqlite`, schema v1 migrations
`tasksDatabase/migrations.ts:46-86`), dynamic-workflow journal, legacy workflow
snapshots. `session_input` is a durable per-session input queue.

Absent: a generic durable operator-facing **job queue** outside those
domain-specific structures, and any durable host/mobile command queue
(#17 is memory-only).

Reuse over duplication: an operator job queue should be a new table set in
`tasks-index.sqlite` (same DB owner: `TaskIndexRepo` family,
`packages/services/src/session/tasksDatabase/`) or extend `automations` if
semantics fit. Do not create a second session state machine: job -> session
binding should use existing session records and `workspaceIdentity`/`workspacePath`
keying (`packages/shared/src/task-realtime-core.ts:78`).

## 6. RPC, events, persistence, identity, UI seams

- RPC: `packages/rpc` channels; canonical channel names
  `packages/shared/src/channels.ts:74` (`zcode-task:93`, `zcode-agent:97`,
  `zcode-session:99`, `off-peak-task:146`); registration
  `packages/services/src/collection.ts:9`; client getters
  `packages/client/src/remoteServiceAccess.ts:50`.
- Runtime -> UI: V4 topics `packages/shared/src/zcode-protocol-v4/transport.ts:307-389`
  (conversation / sessions-index / workspace-config), subscription routes
  `packages/services/src/zcode-agent/zcodeAgentService.ts:4925-5576`; UI stores
  `packages/ui/src/v4/sessionsIndexStore.ts:16`,
  `packages/ui/src/v4/conversationProjectionStore.ts:88`.
- Persistence: data root `packages/services/src/paths.ts:9-40`
  (`ZCODE_DATA_BASE_DIR` override), `~/.zcode` + `~/.zcode/v2`;
  `tasks-index.sqlite` (`paths.ts:186`); settings
  `packages/services/src/setting/settingService.ts:55`;
  CLI session DB `~/.zcode/cli/db/db.sqlite`
  (`apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts:7`).
- Workspace identity: canonical key `resolveWorkspaceKey`
  (`packages/shared/src/task-realtime-core.ts:78`) =
  `workspaceIdentity?.trim() || workspacePath`; remote identity builders
  `packages/shared/src/remote-workspace-identity.ts:46`; persisted columns
  `workspace_key/workspace_path/workspace_identity` (`schema-v1.ts:4-6`).
- UI state: `packages/ui/src/store/zcodeSessionStore.ts:16`,
  `tabStore.ts:24`, `subagentsStore.ts:110`; service access only via hooks
  (`packages/ui/src/hooks/useServices.tsx:21`,
  `useWorkspaceServices.tsx:54`).
- Extension seams for ZAICODE UI: settings section registry
  `packages/ui/src/lib/settingsNavigation.ts:4-46` +
  `settingsPageConfig.ts:57-159` + `SettingsPage.tsx:1893`; workspace main view
  union `app-shell/types.ts:120` + `WorkspaceShellLayout.tsx:1747`; side pane
  tab union `lib/workspaceSidePane.ts:516`; queue UI precedent
  `packages/ui/src/v4/ConversationQueuePanel.tsx:31`; new service path =
  descriptor (`channels.ts` -> `node.ts:2422` -> `remoteServiceAccess.ts`).

## 7. Account/auth dependencies (SRC-002 investigation target)

Not yet traced to source depth. Known entry points to audit next:
provider selection (`packages/provider/src/effective-model-selection.ts:17`,
`model-selection-config.ts:28`), onboarding/login surfaces
(`apps/zcode-cli/packages/cli/src/run.ts` login/logout; desktop auth/account
services under `packages/services`), and desktop main runtime env
(`packages/desktop/src/main/desktopRuntimeEnv.ts:549`). Deliverable: a
dependency map proving the launch path to workspace + agent config + queue
without any account, plus the centralized ZAICODE product capability layer
described in SRC-002.

## 8. Desktop identity, provider stack, lifecycle owners (SRC-004 addendum)

| Topic | file:line | Symbol | Owns |
|---|---|---|---|
| Identity flavors (production/preview/zaicode) | `packages/desktop/scripts/desktop-product-identity.mjs:8-31` | `desktopProductIdentities` | appId, productName, linux exe/pkg names, CUA-helper variant |
| Flavor resolution + strict switches | `.../desktop-product-identity.mjs:59-79` | `resolveDesktopProductFlavor`, `isZaicodeIdentityRequested` | `ZCODE_ZAICODE_IDENTITY` / `ZCODE_PREVIEW_IDENTITY` (strict 1/0) |
| Windows AUMID | `.../desktop-product-identity.mjs:85-90`; `packages/desktop/src/main/index.ts:1910` | `resolveWindowsAppUserModelIdForFlavor` | packaged AUMID = flavor appId; dev fallback `cn.aminer.zcode` |
| Packaged appId | `packages/desktop/electron-builder.config.js:453` | `desktopProductIdentity.appId` | installer identity |
| Runtime identity roots | `packages/desktop/src/main/desktopRuntimeEnv.ts:41-78` | `runtimeApplicationName`, `runtimeUserDataPath`, `runtimeHomePath` | app name + userData/sessionData path |
| Single-instance lock | `packages/desktop/src/main/index.ts:1816` | `app.requestSingleInstanceLock` | per-userData lock (isolation follows the separate userData root) |
| Data roots | `packages/services/src/paths.ts:9-40,186` | `getAppConfigDir`, `getTasksIndexDatabasePath` | `~/.zcode`, `~/.zcode/v2/tasks-index.sqlite` (ZAICODE keeps these inside its isolated profile) |
| Provider registry / effective selection | `packages/provider/src/effective-model-selection.ts:17`, `model-selection-config.ts:28` | effective selection resolution | provider/model resolution + validation |
| Account provider runtime | `packages/services/src/model-provider/providerConfigRuntime.ts`, `packages/services/src/oauth/*` | provider config runtime, OAuth service | optional provider auth; never required for workspace/queue |
| Runtime + agent process | `packages/services/src/node.ts:1281` (`createLocalServices`), `docs/ZAICODE_IMPLEMENTATION.md` §3 | host service assembly, CLI agent spawn | session/runtime ownership stays upstream |
| ZAICODE routing abstraction | `packages/shared/src/zaicode-routing.ts` | `resolveZaicodRoutePlan` | configured → resolved selection; fails closed; SAIFREN/SAIRoute/9router are declared boundaries |
| ZAICODE job execution | `packages/desktop/src/host/zaicodeRunDispatch.ts` | `createZaicodeJobExecutor` | queue job → createTask/sendPrompt → terminal writeback |
| UI stores | `packages/ui/src/store/*`, `packages/ui/src/v4/*Store.ts`, `packages/ui/src/zaicode/zaicodeStore.ts` | stores | presentation state only; queue rows stay authoritative |

## 9. ZAICODE agent policy and routing (SRC-005)

`zaicode_agents.backend` is a concrete persisted value. Migration
`0005_zaicode_routing_backend` adds it with a `direct` default while preserving
the historical `0004_zaicode_product` declaration. Agent create/update/read/list
and duplicate retain backend intent. The editor exposes a compact selector;
Direct is executable through the configured provider/model, while SAIFREN,
SAIRoute, and 9router are unimplemented integration boundaries that fail closed
at dispatch. The Inspector separates configured backend/provider/model from
the resolved runtime provider/model.

### Human mental model (T-13)

The operator concepts are kept visually distinct rather than collapsed:

`Agent` (reusable execution profile) → `Task` (work to do) → `Queue job`
(a scheduled execution of a task by an agent) → `Dispatch` (start eligible
Ready jobs up to the concurrency limit) → `Route` (how the agent reaches a
runtime) → `Resolved runtime` (actual provider/model, only after resolution).
`Template` is a starter preset that prefills a new agent; selecting one never
launches anything.

Routing is presented in two levels while the persisted enum
(`direct|saifren|sairoute|9router`) is unchanged — this is a presentation
mapping in `packages/ui/src/zaicode/zaicodeRoutingModel.ts`, not a storage
migration:

| Execution path | Routing profile | Persisted `backend` |
|---|---|---|
| Direct | — | `direct` |
| Router | SAIFREN | `saifren` |
| Router | SAIRoute | `sairoute` |
| Router | 9router Raw | `9router` |

`SAIFREN`, `SAIRoute`, and `9router Raw` are routing profiles/modes associated
with the operator's 9router infrastructure. Only Direct is implemented; the
router profiles are declared boundaries that fail closed at dispatch
(`route-unresolved`) and never silently fall back to Direct. The mapping is a
round-trip identity (`backend → view → backend`), so existing agents load and
save with their original backend meaning preserved.

The editor preserves `allowedTools` and `disallowedTools` while editing other
agent fields or plan mode. The executor projects permission mode and both lists
to runtime enforcement; denylist conflicts win. Service updates retain explicit
replace and clear semantics.

## 10. SAIHOME and local statistics (T-56)

| Topic | Location | Owns |
|---|---|---|
| View | `packages/ui/src/app-shell/types.ts` (`saihome`), `App.tsx`, `WorkspaceShellLayout.tsx` | SAIHOME is a main view distinct from the composer (`chat`); opening it has no side effect |
| Page + snapshot | `packages/ui/src/zaicode/home/ZaicodeHomePage.tsx`, `zaicodeHomeModel.ts` | assembles one read projection per render from the owners' stores; widgets render slices |
| Feed | `packages/ui/src/zaicode/home/zaicodeHomeFeed.ts` | the only SAIHOME caller of services (stats, activity, all queue rows, router refresh), only while visible |
| Project facts | `packages/ui/src/zaicode/home/ZaicodeHomeFleet.tsx` | per-project probes on T-41 `useZaicodeProjectRuntime` over the shared SAIPEN pollers |
| Statistics service | `packages/services/src/zaicode/zaicodeStats{,Service,Repo,Sources}.ts`, channel `zaicode-stats` | ingestion (agent usage store read-only, `zaicode_jobs`, recorded worker sessions), dedupe, cursors, clear floor, export |
| Statistics schema | `packages/services/src/session/tasksDatabase/zaicode-stats-v6.ts`, migration `0006_zaicode_stats` | `zaicode_stats_events`, `zaicode_stats_cursor` in tasks-index.sqlite |
| Aggregation | `packages/shared/src/zaicode-stats.ts` | quarter-hour buckets -> local days (Intl, IANA zone), periods, streaks, derived metrics |
| Event journal | `packages/ui/src/zaicode/home/zaicodeHomeJournal.ts` | work-relevant `notifyZaicode` scenarios, local ring of 80 |

The agent usage store (`~/.zcode/cli/db/db.sqlite`, tables `model_usage`,
`turn_usage`, `session`) belongs to the agent CLI; ZAICODE opens it read-only,
checks the columns it needs and reports the source unavailable otherwise.

## Uncertainties

Codebase-memory index was built during the 2026-09-23 continuation; graph
coverage remains metadata-level evidence and source reads/tests are used for
the ZAICODE paths. CLI `db.sqlite` migration mechanism not traced;
`packages/shared/src/zcode-protocol/index.ts` legacy surface not fully
enumerated (V4 is the active wire); some `product-projection.ts` interaction
internals not line-mapped; remote off-peak server behavior is outside the repo.
