# Vertical project rail and caption header (T-224 / SRC-154:R001)

The compact project sidebar must retain independently clickable SAIHOME,
project, New and Settings controls. In the actual Windows package, narrowing
the sidebar to 52px bypasses the full sidebar's header space. The still-mounted
caption overlay then covers the first rail control with the application logo.
A visible 32px button is insufficient when another button receives its clicks.

WorkspaceShellLayout owns the sidebar's relation to its existing caption
overlay. When it selects the compact rail, the sidebar content reserves the
same 56px header band already occupied by DesktopTopOverlay. This reservation
applies to the whole rail, on either side, rather than offsets on individual
buttons. The existing rail retains uniform controls, pinned actions and its
one flexible project scroll region, which uses the remaining height.

The existing sidebar-width owner and persistence choose the presentation.
There is no new preference, store, timer, command or migration. The full
sidebar and upstream mode keep their existing layout paths. No cross-module
interface or asynchronous ordering changes are needed.

Acceptance uses an isolated actual Windows package with a real project.
Set the physical viewport to 1280x360, narrow the sidebar through its existing
keyboard resize action, and verify all compact controls lie inside the window,
receive their center hit tests and do not intersect interactive caption
buttons. The unchanged native oracle must reject the pre-fix ff45c6b4 package
and accept the rebuilt candidate. The broader T-224 native acceptance retains
the twelve-project short-window scroll check, composer convergence, two-project
pane policy and real restart checks, file-backed Unicode editing and Retry
interaction. Typecheck, lint, architecture and repository tests remain due.

## Persisted pane policy precedence (SRC-154:R003)

An actual two-project run also disproves the former policy acceptance. With
`everywhere=true` durably stored, a previous per-owner collapsed memory still
keeps the next project's pane closed. The initial, workspace and owner restore
paths all read that old memory before the selected persisted policy.

useAppPanels remains the single pane-state owner. Its one persisted-preference
projection subscribes to the selected scope for the current workspace/session.
An explicit persisted answer wins, then the old memory serves only an unset
policy, then the existing content default applies. A settings mode change
reprojects the same owner; it does not require an unrelated project switch.
Restoration never writes a new choice. Empty content still cannot produce an
empty open pane, and scope changes never create, discard or duplicate tabs.

Event order: an explicit pane command updates its existing memory and selected
persisted scope; restoring an owner reads the latest scope, then fallback memory,
then projects that answer onto the existing pane. The other scope's saved
answers survive a mode change. No new store, persistence key or timer is added.

The unchanged mounted-hook browser oracle must reject the preserved ff45 hook
and accept the correction for global open, global closed, distinct per-owner
answers and an immediate mode change. Native acceptance repeats A-B-A in both
modes and real process restarts, making explicit choices in the selected scope.
