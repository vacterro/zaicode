# Changelog

All notable ZAICODE releases. Versions follow semantic versioning. Tags
`vX.Y.Z` identify the workspace on `master`; each entry records the separate
application commit on `zaicode`. The upstream framework version is independent.

## 0.0.2 — 2026-09-30

- Complete 33 UI/CLI locale catalogs and translated user documentation from
  the authenticated T-140/T-113 package. New model controls retain exact key
  and interpolation-token parity across all catalogs.
- T-141: subscription selection reaches the focused chat; model names and
  effort persist; bulk model switches reduce setup clicks. Provider saves
  settle independently, reserve quota appears last, and Windows CLI probes
  receive a closed stdin pipe.
- Cancellation retains failed stops for retry and prevents hidden live tasks.
  Idle audits archive without deleting reports. Sidebars swap, collapse into
  a 52px rail, and keep separate controls in a narrow window. Repeated hover
  sounds follow the chosen overlap mode; shortcut settings share one page.
- T-139: retain the reviewed SAIPEGGLE and SAIASUI corrections.
- Application commit: `e90914815ad3c607132cc6aafeea0a106f848cb4`.
  Validation: 1158 tests pass, two platform skips; packaged sidebar, 640px
  hit targets, locale restart and three-monitor ProTrail pass. The isolated
  free pool answers a first task without configuration.

## Unreleased

### T-134 (SRC-097): one click, free at once, four parts that update on their own

- **ZAICODE-Setup.exe** (`install/`): download, double-click, INSTALL. A window
  in the ZAICODE look shows every step live; TRY AGAIN / Autotroubleshoot /
  Open log when something stops, START ZAICODE at the end. Proven on an empty
  folder: 17/17 steps, then the installed app answered a task on the free pool
  with no setting touched.
- Fixed: an install from nothing cloned the vanished `workspace` branch, and
  the first app build on a fresh Windows died unpacking `.tar.xz` (no `xz` on
  Windows). Both work now.
- **Updates, part by part**: the workspace, the app, SAIPEN and SAIMAIL each
  update alone, by hand or by themselves (Settings -> ZAICODE -> Updates,
  `install/Update-ZAICODE.ps1`). A new app build is staged while ZAICODE runs;
  local edits and local commits are never overwritten; files the installer or
  a build writes (SAIPEN's launcher, line-ending-only differences) never block
  an update.
- **More control**: every sidebar button and menu line has its own icon slot
  and a show condition (always / while working / while idle / on hover); every
  sound has its own conditions (only in the background / in front, through
  quiet hours, at most once per N seconds); new sounds for free models ready,
  a new free model and updates.
- First start: no "sign-in required" for Claude / Codex logins that were never
  set up, and no stale "no SAIFREN pool" once the free pool is ready.

### T-63 (SRC-048)

- Sidebar: a project whose open session works now shows the Working icon (the
  open chat's own state counts, the list can lag behind).
- SUBCHAT offers every subscription: Antigravity and ZCode chat headless too;
  chats are grouped per project with a Working icon on busy ones; an
  Antigravity chat uses the model pool that still has quota.
- Hard bevels (Wintage FastPrompter look), on by default, with a separate
  switch for list rows.
- Resets: a 5 h window nobody used ("5 h" again at every read) and a window
  blocked by a spent weekly one no longer pose as the next reset.
- Highlights & motion: presets (built-in and own) with file export / import;
  profiles export / import.
- Pop-ups placed on whole pixels: no more blurred todo tooltip.
- Start-up: the SAIPEN splash picture at once; the window appears when it is
  ready instead of half a minute of grey.
- Highlights & motion: own easing curves; separate speed / easing / reach /
  depth / phase for every motion and effect in a mix, colour and strength per
  shape, stacked pictures as layers with blend and own motion.
- The Working icon moves symmetrically everywhere (no perspective slant).

## 0.0.1 — 2026-09-25

First tagged snapshot of ZAICODE over ZCode.

### Product layer (through T-58)

- ZAICODE mode over the unmodified ZCode core: account-free operation, local
  agent queue and agents, delegation, SAIPEN-driven projects with MAIN and
  helper sessions, START / STEP / CONTINUE ALL / DONE.
- Subscription engines and workers (Claude Code, Codex, Antigravity, ZCode),
  limit meters and reset alerts, Dispatch, SCHEDULER, SAIHOME with local
  statistics, timers and alarms, sounds, highlights and motion, Color Studio,
  profiles, zero-setup 9router pools (SAIFREN / SAIOPP), root launcher with
  staged build swap.

### This release (T-59 / T-60)

- Crash safety: sessions a dead process cut off and goals still active continue
  after a restart; running workers start again (switchable).
- Agents inside ZAICODE can no longer stop ZAICODE by process name, image or
  path (cause of the "8 tasks at once crashed" report).
- A queued message on an idle session runs even while a goal is unfinished.
- INTERRUPTED state: cut-off sessions are never counted as DONE.
- ▶ START and Hit & go continue the project's MAIN session instead of opening
  another one.
- Sidebar view "project = MAIN" (default) with CLEAR ALL DONE.
- WORKERS panel docks to the bottom, right, left or top; Redraw; automatic
  answer to "Trust this folder?"; usage-limit detection with keep / close /
  restart after reset.
- Title bar: project name in big letters (configurable); nearest-reset timer
  with the full list of coming resets.
- SCHEDULER: no prompt length cap (long prompts reach CLI workers as a file),
  conditions (stop stopgap work first, only when idle, only marked sessions),
  worst projects first, START into MAIN.
- Renamable sidebar menu lines; grouped rows use the Working icon.
