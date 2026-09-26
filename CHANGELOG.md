# Changelog

All notable ZAICODE releases. Versions follow semantic versioning; the tag
`vX.Y.Z` marks the `main` branch (application source) and `workspace-vX.Y.Z`
the `workspace` branch (this root: launcher, docs, SAIPEN memory).

## Unreleased

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
