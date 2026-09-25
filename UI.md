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

## Engines, Workers, Limits and Autostart (SRC-029)

The operator's own subscriptions are execution engines next to the in-app
model pools. They are discovered, never configured by hand:

- Claude Code: every `~/.claude` and `~/.claude-*` home with its own
  credentials (A1, A2, ...); Codex: every `~/.codex` / `~/.codex-*` home
  (C1, C2, C3, ...); Antigravity: the `agy` CLI and its saved login (AG);
  ZCode: the Coding Plan entry of `~/.zcode/v2/config.json` (ZC). Freebuff is
  not an engine.
- Quota is read with each vendor's own read-only call — `claude -p /usage`,
  `codex app-server account/rateLimits/read`, `agy -p /usage`, the Z.ai
  monitor endpoint — so reading never spends quota. A failed read keeps the
  last good numbers (stale), an elapsed reset reads full, and a spent window
  only blocks the shorter windows of its own pool.
- The sidebar top is the engine picker (no combobox): model pools on one row,
  subscription tiles on the next, each tile filled by the quota it has left.
  Click selects the engine START uses; double-click starts a worker in the
  current project; right-click starts, reads, fixes or hides.
- A worker is the subscription's CLI running in the project folder inside
  ZAICODE (see "Workers" below). "Separate PowerShell window" starts it outside
  ZAICODE instead.
- The title bar AI limit meter shows every visible engine (Stacked / Bars /
  Dots); hover for the full breakdown, click for Settings -> Engines & limits,
  right-click for what it shows (see "Limit meters" below).
- Refill and low-quota alerts fire once per window per reset cycle.
- Troubleshooting is one click and never implicit: "Connect everything" lists
  the exact login / install commands before running them in WORKERS tabs.
- Autostart jobs start an engine (or ZAICODE's own START) in a project once,
  daily, every N minutes, or when a quota window refills. Each occurrence
  fires exactly once, a moment older than the catch-up window is MISSED
  rather than launched late, and a job whose engine has no quota waits.

## Sounds (SRC-029)

Every ZAICODE action has its own row in Settings -> Sounds: on/off, sound
(the whole bundled library, filterable, or the operator's own file), mix or
cut, gain in dB relative to the master volume, preview. Call sites only name
the event; nothing about which sound plays is hard-coded where it plays.

## Keyboard layouts

ZAICODE hotkeys match the physical key (`KeyboardEvent.code`), so Ctrl+Q,
Ctrl+Z and the zone picker keys work on every keyboard layout.

## Workers (SRC-031)

Workers are docked by default, never floating over the chat: the bottom
WORKERS panel behaves like a normal terminal panel under the whole workspace
body (toggle from the sidebar list, the header button or Alt+W; drag its top
edge to resize, double-click to maximize).

- Split shows every docked worker side by side, stacked or as a grid; dividers
  drag, double-click = even. Tabs shows one at a time. A pane can fill the
  panel (solo) and go back.
- Any worker moves to its own window and back. A window snaps: side edge =
  half, corner = quarter, top = maximize, bottom edge = dock into the panel;
  its edges stick to the work area and other worker windows.
- Minimized workers (and, optionally, the hidden panel's workers) stack as
  chips labelled "engine · project" at the chosen anchor: bottom left / centre
  / right, or the middle of the left / right edge.
- The sidebar lists every worker under the engine tiles with the same buttons.
- Stopping a running worker asks first (setting). Hiding, minimizing or moving
  never stops one. Workers use the bundled Terminus face by default.

## Limit meters (SRC-031)

The same panel in Settings -> Engines & limits and on a right-click of the
title bar meter: hide engines with 0% used, show only engines whose 5h window
can work now (a spent weekly gates it; one Antigravity pool is enough), apply
those rules to the meter and/or the sidebar tiles, hide single engines from the
meter only, bars show quota left or used, vendor tint, names over Bars / Dots,
and the availability tint strength of the sidebar tiles (0 = off). Tiles that
need sign-in always stay visible.

## Settings, New task screen, help (SRC-030 / SRC-031, T-56)

- All ZAICODE pages form one Settings group: ZAICODE, Layout & home, Engines &
  limits, Workers & terminal, Sounds, Notifications, Timers, Hotkeys, Help.
- The New task screen (the empty composer) is quiet by default: no "Empty"
  marker, no empty SAIMAIL line; a faint "New task screen" link appears on
  hover. It is not the home; SAIHOME is.
- Memory explains itself in plain words (what, where, cost, who uses it).
- Help lists every control in one line; the ZAICODE page offers ready-made
  teams and a guided tour.

## SAIHOME (T-56)

SAIHOME != NEW TASK. SAIHOME answers "what is happening?"; NEW TASK (the
composer) answers "what do I want to start?". The ZAICODE workspace answers
"what work, agents and tasks exist?", the SCHEDULER "what starts later and
why?", WORKERS "what runs in terminals?", Settings "how should it behave?".

- SAIHOME is its own main view. The SAIHOME menu line (first), Alt+H, the
  tray menu and the optional header button open it. Opening it creates no
  session, task or job; switching projects from it only selects the project.
- Startup (Layout & home): SAIHOME (default for a fresh profile), Last active,
  New task.
- Modules and their authoritative sources:

| Module | Source |
|--------|--------|
| Clock | the machine clock (local zone; an inherited `TZ` never reaches the app) |
| Now | running sessions (sidebar), workers, queue rows, statistics, engine resets, SCHEDULER |
| Needs you | router state, engines, T-41 project verdicts, waiting sessions, SCHEDULER, statistics sources |
| Tokens & work, Activity, Numbers | local statistics service (`zaicode_stats_events`) |
| AI limits | engine quota snapshots (Engines & limits); prepared-meter highlight from the SCHEDULER |
| Scheduler | SCHEDULER jobs and their decisions |
| Projects, SAIPEN | T-41 ProjectRuntimeSnapshot per project (SAIPEN projection, sessions, workers) |
| Agents | running / waiting sessions, workers, queue rows |
| Routing | router host (mode, restarts, last error), router API (pools, providers), free-model scan |
| SAIMAIL | the SAIMAIL desk (hidden when nothing is unread) |
| Recent | queue runs and worker sessions (statistics) + the app event journal (`notifyZaicode`) |

- Truth: every value is authoritative, derived, estimated, stale or
  unavailable, and says which on its tooltip. Unknown is shown as "—", never 0.
  A ratio without data reads "not enough data".
- Statistics are local only. Tokens are measured for in-app model requests
  (the agent usage store, shared with ZCode on the same machine); CLI worker
  sessions have no token counts and are shown as unmeasured runtime, never as
  zero-token work. Coverage = model time ÷ (model time + worker time).
- Periods: today, yesterday, last 7 days, this week (Monday or Sunday start),
  last 30 days, this month, all time, in the operator's time zone (DST safe).
- Layout: presets EVERYTHING (default), MINIMAL, OPERATOR, STATS, FACTORY, and
  CUSTOM (Edit layout: order, visibility, compact / normal / large). Columns
  follow the window width in whole pixels; empty modules take no space;
  healthy states stay one line.
- Clock settings: size, second hand, smooth sweep (only when motion is
  allowed), numerals, date, zone, 24 / 12-hour digital line, second zone.

## Sidebar controls (T-56)

- Project row: the name keeps one width; a fixed zone on the right shows
  working / waiting / OFF while idle and ◆ MAIN, ▶ START, … on hover (new
  session and files are in …). Controls that appear on hover never change a
  row's height.
- Shift+Click a project: switched off (dimmed, OFF). The queue does not
  auto-dispatch its jobs and the SCHEDULER skips it; opening it by hand still
  works. Shift+Click again switches it on.
- Shift + drag a project and hold 2 s: the SLOTS panel opens; every slot, also
  an empty or folded one, takes the drop.
- Tray: ZAICODE's own menu (Open, SAIHOME, New task, WORKERS, Timers, Settings,
  Quit). No Clear all data, update check or vendor links.
- A turn the operator stops raises no "Task completed" card.
- Times are typed in ZAICODE's own fields (24-hour, 00:00 = midnight, arrows
  step); no native time picker.

## Sidebar and session controls (T-58)

- The project list is the root of the sidebar: no "Projects" title, nothing
  to fold or drag above it. SLOTS, LIVE and + (add project) sit in the
  toolbar row. A project row shows no grab hand; dragging still works.
- The sidebar answers instantly: no hover / selection fades, no scroll mask;
  rows re-render only when their own facts change (counts, not lists).
- CONTINUE ALL (big button under the menu) runs a plan it shows before the
  click (hover or right-click): stopped goals are taken up again with the
  same objective, failed turns continue (`cc`, or `continue` without
  SAIPEN), a SAIPEN project with open tickets and nothing running continues
  its MAIN session with `/goal cc all` (or starts a MAIN). Finished sessions,
  running ones, switched-off projects and questions that wait for a human
  are left alone. Hotkey: none by default (Settings -> Hotkeys).
- DONE n: the oldest finished session you have not opened yet; opening it
  marks it seen, so the next press lands on the next one. Right-click lists
  them all. Hotkey Alt+Right.
- A session row's ▶ (on hover) and Alt+Click continue that session without
  opening it; a session that waits for your answer opens instead.
- Mixing (Shift+Click) in Highlights & motion: effects, shapes, working-icon
  motions and pictures (up to three stacked). Plain click picks one; the
  neutral choice (Steady, Still) clears the mix. The Opacity slider applies
  under every motion; Reach sets how dark Blink goes.
- Title-bar clock: every countdown is bold in FastPrompter's colours; the
  nearest limit reset in the vendor's colour.
- Freebuff is shown for its limits only (meter, clock, SAIHOME); it never
  appears as an engine, in Dispatch or in the SCHEDULER.
