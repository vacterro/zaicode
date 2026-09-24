# ZAICODE UI

ZAICODE is an operator-oriented multi-agent coding workspace built on the
upstream ZCode codebase. This file is the ZAICODE product-interface contract.
It supplements upstream `zcode/DESIGN.md`; it does not replace or duplicate the
design system. `DESIGN.md` remains authoritative for component styling,
typography tokens, colors, themes, spacing, responsive behavior, accessibility
conventions, and supported platform behavior.

## Product Invariants (SRC-002)

- ZAICODE has no mandatory application account. Cloud authentication is
  provider-specific. The application, workspace, agent management, queue, and
  routing configuration remain available without a Z.ai account.
- Z.ai is an optional external provider and has no privileged product-level
  status inside ZAICODE.

Product identity is separate from provider identity. The visible product is
ZAICODE; provider connections (Z.ai, BigModel, custom providers, local models)
are configuration inside that product.

## Account Model

ZAICODE has no mandatory application account. Cloud authentication is
provider-specific. Workspace access, agent management, queue management,
routing configuration, local-provider configuration, and application settings
remain available without a Z.ai account. Z.ai is an optional external provider
and has no privileged product-level status inside ZAICODE.

## Execution Architecture

Human mental model. These concepts stay visually distinct and never collapse:

```
Agent        reusable execution profile ("who does the work")
Template     starter preset that prefills a new agent (creation helper, launches nothing)
Task         the work to be done
Queue job    a scheduled execution of a task by an agent
Dispatch     start eligible Ready jobs up to the concurrency limit
Route        how the selected agent reaches a runtime provider/model
Resolved     the actual runtime provider/model, only after resolution occurs
```

Conceptual execution path, with implementation status marked truthfully:

```
ZAICODE UI                     implemented (workspace + settings surfaces)
→ Agent / Work Queue           implemented (zaicode_jobs in tasks-index.sqlite)
→ Model pool                   persisted per agent as a provider/model selection
→ Provider / Model             upstream provider architecture
→ Runtime                      upstream task/session runtime
→ Result                       terminal queue state + result summary
```

### Model pools (SAIRoute / SAIFREN / SAIOPP)

SAIFREN and SAIOPP are router combos configured inside the operator's 9router
instance. 9router is reached through one ordinary custom provider, named
SAIRoute for convenience, and each combo appears as a model of that provider.
A model pool is therefore one complete provider/model selection such as
`SAIRoute / SAIFREN` (free: every model reachable from the internet) or
`SAIRoute / SAIOPP` (paid: deep-thinking models).

The agent editor shows a **Model pool** picker: 9router-backed providers
(SAIRoute) first with their pools as direct choices, every other provider
model under "Other models". The same pools are selectable in the chat model
selector because they are ordinary provider models.

The persisted backend enum (`direct|saifren|sairoute|9router`) is kept as an
intent label only: a 9router-backed provider saves `sairoute`, anything else
saves `direct`. Every value executes through the selected provider/model; an
agent without a pool selection fails closed with `route-unresolved` and tells
the operator to pick a pool. Legacy agents that stored only `saifren` get the
`SAIFREN` pool preselected when opened in the editor.

## Modal Policy

Prefer integrated panes, tabs, inline editors, searchable lists, segmented
controls, and direct selections. Avoid chains of modal dialogs and
combobox-heavy configuration; the ZAICODE workspace and settings section follow
this by using inline panels and direct selection controls.

## Product Purpose

The UI should make agent state, queued work, active execution, blockers,
results, and ownership obvious without forcing the operator to open multiple
dialogs.

## Core Principles

- one primary workspace;
- dense but readable;
- desktop-first;
- minimal modal interaction;
- keyboard-friendly;
- no unnecessary combobox-heavy configuration;
- critical execution state always visible;
- explicit agent ownership;
- explicit queue state;
- explicit blocked state;
- explicit provider/model identity;
- no hidden destructive actions;
- persistent operator context across restart;
- no mandatory account wall: with zero configured providers the workspace is
  still usable and shows a truthful "No execution routes configured." state.

## Main Workspace

Intended main-screen regions:

### Navigation / Workspace

Project/workspace selection and high-level ZAICODE navigation.

### Agent Roster

Visible list of configured agents. Each row/card should expose: name; role;
status; model; provider; current job; queue depth where applicable; last
activity; error/blocker indicator.

### Work Queue

Operator-facing ordered task queue. Required task states: Draft, Queued, Ready,
Running, Waiting, Blocked, Completed, Failed, Cancelled. Do not add states the
runtime cannot actually distinguish.

### Active Work

Currently executing agent jobs and meaningful progress/runtime events.

### Inspector

Selected agent/job details without forcing navigation away from the queue.

### Event / Result Surface

Readable execution results, important tool events, errors, and completion
summaries.

## Agent Management

Create Agent; Rename Agent; Edit Role; Edit Instructions; Choose routing
backend; Choose Provider; Choose Model; Enable/Disable; Duplicate; Delete; Run;
Pause only if the runtime supports real pause semantics; Cancel; Queue Task. Do
not implement fake Pause if the engine only supports Cancel.

## Queue Interaction

Add task; edit pending task; reorder eligible tasks; dispatch; cancel; retry
failed; resume blocked task when possible; inspect history; filter by
agent/status/workspace; preserve queue across application restart when
persistence is supported.

First-glance clarity (T-20):

- A flow bar under the header always reads `1 Agents -> 2 Tasks -> 3 Results`
  with live counts, so the system explains itself without the Guide.
- Autopilot (host setting `auto_run`, default on): a task starts as soon as it
  is added, resumed, or a parallel slot frees. Off: tasks wait, and the header
  shows `Run N waiting`. The state is always visible in the header and flow bar.
- Each task row has exactly one primary action matching its state
  (Run / Stop / Retry / Resume); reorder, cancel and remove appear on hover.
- Filters are four plain groups: All, In progress, Needs you (failed/blocked),
  Finished. Every status badge carries a one-line explanation tooltip.
- The Inspector opens the task's real chat session ("Open session").
- The workspace polls every 3 s while any task is active.

## Agent Status Vocabulary

Precise runtime-backed states: Idle, Queued, Starting, Running, Waiting,
Blocked, Completed, Failed, Offline. Map every displayed status to an
authoritative runtime state.

Displayed agent status is derived, never invented:

| Displayed | Authoritative source |
|-----------|----------------------|
| Offline   | `zaicode_agents.enabled = 0` |
| Running   | a non-terminal queue row for this agent with `status = running` |
| Blocked   | a non-terminal queue row for this agent with `status = blocked` |
| Idle      | enabled agent with no running/blocked row |

Job states map 1:1 to queue rows (`draft`, `queued`, `ready`, `running`,
`waiting`, `blocked`, `completed`, `failed`, `cancelled`); no display state is
added that the queue cannot distinguish. `Starting` is not shown because the
queue does not model it separately from `running`.

## Model and Provider Visibility

The UI must show the configured model pool separately from the provider/model
the runtime actually received. Z.ai remains one optional provider.

The configured pool is shown from the agent definition, and the editor reports
whether a pool is selected.
When an execution completes, the actual selection reported by the executor is
stored on the job (`actual_model_selection`) and can be shown separately; a
configured value is never presented as the executed value.

## Routing Visibility

The UI must distinguish, and never conflate:

- configured route (what the agent definition says);
- selected route (what the operator dispatched);
- resolved provider/model (what the runtime actually received);
- fallback selection and its reason.

A configured value is never displayed as the actual execution identity when
resolution failed or fell back. The Inspector groups the agent's **Configured**
model pool separately under a **Resolved** heading (session, resolved
runtime provider/model). Before resolution the resolved provider/model reads
"Not resolved yet" rather than echoing the configured value
(`actual_model_selection`). A `route-unresolved` failure is shown as
unavailable and names the missing route instead of showing a fabricated model.

## Permissions

Dangerous or privileged tool actions must respect the existing permission
system. Subagents must not silently gain broader permissions than their parent
or configured profile. ZAICODE agent definitions persist `permissionMode`,
`allowedTools`, and `disallowedTools`; the desktop executor projects these to
the upstream permission runtime, with the denylist winning conflicts. The
editor preserves both lists when an unrelated field or plan mode is changed.
The upstream permission engine remains authoritative.

## Startup Behavior

Fresh ZAICODE installation:

1. starts without cloud login;
2. opens the product shell;
3. allows workspace access;
4. allows configuration (settings, agents, queue editing);
5. truthfully reports missing execution routes ("No execution routes
   configured.") without redirecting into account creation.

## Persistence

- Runtime-authoritative: job status, attempt, run/session ids, terminal outcome,
  heartbeat/lease, retry lineage, blocked reasons — queue rows in
  `tasks-index.sqlite` (`zaicode_jobs`).
- Persisted configuration: agent definitions (`zaicode_agents`), including the
  routing backend and tool policy, and queue settings such as the per-workspace
  concurrency limit (`zaicode_settings`). Migration `0005_zaicode_routing_backend`
  adds the backend column with a Direct default; migration `0004_zaicode_product`
  remains frozen.
- Local UI preference: selected agent/job in the inspector, and the workspace
  view choice; these are not execution truth.
- Derived display state: agent display status, queue depth, active-work
  counters, provider/model labels — computed from the rows above.

## Keyboard Workflow

The first ZAICODE milestone adds no new global shortcuts. All ZAICODE actions
are reachable through visible controls (roster, queue panel, inspector, header),
so no existing ZCode shortcut is shadowed or remapped. Adding shortcuts is
deferred until a collision audit against `packages/ui/src/lib` shortcut
definitions is done.

## Responsive Behavior

Preserve usable Web behavior but prioritize the Windows desktop workspace.

The ZAICODE workspace is a three-region desktop layout (roster | queue |
inspector). On narrow Web viewports the panels remain reachable through normal
page scrolling; a collapsible/stacked layout is future work.

## Standalone Identity

ZAICODE has its own centralized desktop identity flavor
(`packages/desktop/scripts/desktop-product-identity.mjs`): app id
`dev.zaicode.app`, product name `ZAICODE`, executable/package name `zaicode`,
its own userData root (`ZAICODE`), deep-link/updater identity slots, and its own
single-instance ownership through the separate userData path. An installed
production ZCode and a ZAICODE build can run simultaneously without sharing
mutable state. ZAICODE never imports or migrates the production ZCode profile
automatically; any future import is an explicit operator action.

## Development Entry Points

ZAICODE canonical lane (product mode + identity asserted together, fail-closed):
`pnpm dev:zaicode` (dev), `pnpm build:zaicode` (web+desktop build), `pnpm bundle:zaicode`
(package), `pnpm zaicode:env:check` (flavor verification). All go through
`zcode/scripts/zaicode-env.mjs`. Legacy upstream entrypoints (`dev:desktop:test`,
`dev:desktop:prod`, `bundle:desktop`) remain but do not imply ZAICODE identity.
The dev/build/bundle wrappers preserve the launching Node executable for child
pnpm processes; `.mise.toml` selects the project-pinned Node and pnpm versions.

## Non-Goals (first ZAICODE milestone)

No distributed multi-machine scheduler; no arbitrary agent nesting; no visual
node editor; no complex DAG workflow engine; no autonomous infinite execution;
no replacement of ZCode's model/provider stack; no rewrite of the terminal; no
replacement of upstream permission architecture.

## Settings Information Architecture (target)

General, Appearance, Models & Routing, Agents, Browser, Plugins, MCP Servers,
Skills, Commands, Hooks, Usage. Adapt the existing settings architecture; do
not duplicate settings pages merely to achieve these labels. SAIRoute is a
normal provider in Models & Routing; SAIFREN/SAIOPP are its models. ZAICODE
does not configure 9router itself.

## Profiles, Icons, Appearance (ZAICODE mode)

- The sidebar footer never shows "Connect". It shows the active local profile
  (generic icon + name). Profiles are local display identities with no
  credentials; add, rename, re-icon and delete them from the footer menu.
- Every swappable icon is a named slot in `packages/ui/src/zaicode/zaicodeIconSlots.tsx`
  (edit the default there; hot reloads in dev) and can be overridden live from
  the ZAICODE workspace "Icons" panel with an image URL, `data:` URI or text.
- All Wintage palettes (`_WIN95THEME/Wintage/themes`) are selectable from the
  footer menu ("Wintage palette"); data lives in
  `packages/ui/src/zaicode/zaicodePalettes.ts`. Default: OLED Vintage (black
  surfaces, #A0A0A0 text, never pure white). "Upstream colours" disables it.
- Pixel mode (default on): no CSS-controlled antialiasing — square corners, no
  shadows/blur/transitions, no font-smoothing hints, pixelated images, crisp
  SVG edges, Verdana UI face. Glyph rasterization on Windows is still done by
  Chromium/DirectWrite; CSS cannot switch it to fully aliased text.

## Account and Commercial Surfaces (SRC-002)

- No mandatory account connection; no account-required onboarding gate.
- No Connect-account CTA in primary navigation, no Upgrade CTA, no Coding Plan
  or Start Plan promotion, no subscription pricing cards in normal ZAICODE
  navigation.
- Optional provider connection (including Z.ai) remains reachable through
  Models & Routing configuration.
- With zero configured providers: show "No execution routes configured." and
  keep workspace, agent management, queue editing, and routing configuration
  available. Do not redirect to account creation.
