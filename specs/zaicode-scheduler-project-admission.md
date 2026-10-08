# Scheduler project admission and requested interaction fixes

SRC-171, SRC-172, SRC-173 and SRC-174. This eliminates false readiness and
consumed reset occurrences when every target project is switched off.
The existing project switch remains the authority for automatic dispatch;
the autostart store remains the sole owner of occurrence history.

An enabled schedule with no enabled target displays `project OFF` (or
`no target projects`) before the scheduled moment. A blocked occurrence
does not enter firedEvents, disable a one-shot schedule or advance the last
actual run time. Enabling the target within the existing catch-up window
allows the same occurrence to dispatch once. An expired occurrence remains
missed. The executor rechecks project admission before recording dispatch.
Section schedules may run their enabled targets while disabled targets stay
excluded. Production lifecycle logs record admission, dispatch and outcome
once per meaningful change, without prompt text or project paths. The row
shows the current block reason and timestamps its last recorded result.

Sidebar pointer dragging snaps to the existing 264 px default within 12 px
in both sidebar placements, and releases outside that range. The existing
rail threshold, maximum width and persistence owner still apply. Snapping
does not rewrite stored custom widths merely by reading them.

Repeated use of the SAIPEN state control closes the currently visible state
pane. A collapsed pane is revealed. Another project's explicit inspection
target replaces the previous one. Generic side-pane Add actions still open
their requested tab. Existing side-pane/session owners perform the change.

```mermaid
sequenceDiagram
    participant Tick as Scheduler tick
    participant Switch as Project switch owner
    participant Store as Autostart owner
    participant Runner
    Tick->>Switch: Resolve current enabled targets
    alt No enabled target
        Tick-->>Store: No occurrence consumption
        Tick-->>Tick: Show blocked reason; log gate change
    else At least one enabled target
        Tick->>Switch: Recheck before dispatch
        Tick->>Store: Persist occurrence once
        Tick->>Runner: Dispatch admitted targets
        Tick->>Store: Persist timestamped outcome
    end
```

Acceptance uses unchanged original/fixed oracles for disabled-project
decisions, eligible section targets, missed catch-up, sidebar snap boundaries
and repeated state-control clicks. Required typecheck, lint, architecture,
repository tests, packaged boot and isolated native interactions precede
delivery. Build is explicitly requested; live user sessions are preserved.
# Native layout invariant

The draft inspector reserves its width in the existing workspace shell so its
STATE trigger remains reachable with a real pointer. A second click closes the
same global inspector even if a workspace opener has since registered.

## Quota refresh boundary invariant

The existing quota snapshot owner retains the last observed real vendor reset
for the same account, window key and quota pool when a read advances the reset
or reports an untouched new cycle. The scheduler evaluates that unconsumed
boundary before the next reset, retaining its safety delay, catch-up expiry
and account-scoped occurrence id. Cache serialization preserves the boundary.
Idle sliding timers cannot create a boundary; no local recurring timer or
unobserved intermediate reset is synthesized. A metrics-only shared identity
cannot start another Windows user's local single-login CLI.
