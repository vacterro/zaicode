# Scheduler continuation identity and status

SRC-170 R001/R002. The existing autostart job store owns configuration and
leased continuation runs. A configured preferred runner is distinct from
the runner currently executing an occurrence. The scheduler shows active
continuation state and runner first, then the next scheduled occurrence.
An old ordinary result remains labelled as a last recorded result;
changing configuration cannot make it the status of the new runner.

A CLI subscription watches its own quota. A retained Watch value belongs
only to an in-app pool or agent; hiding that field must not retain an old
subscription as the effective watch target. Reset occurrence identities
include the watched account. Existing unscoped reset identities are migrated
using their former watch scope, preserving exactly-once history across
account switches and restarts.

Continuation selects fresh quota evidence belonging to the exact account.
Accounts excluded from scheduling stay excluded from continuation. A
pending worker/model preparation rechecks the current dispatch configuration
and lease before sending input. Editing the preferred runner, fallback
order, prompt or target cancels the stale admission. Completion of an old
asynchronous launch cannot reopen a stopped or removed occurrence. Existing
running work retains its actual runner identity until an owned handoff.

```mermaid
sequenceDiagram
    participant UI
    participant Store as Autostart owner
    participant Tick as Continuation executor
    participant Runner
    UI->>Store: Change preferred account / prompt / target
    Tick->>Store: Read fresh config and exact run lease
    Tick->>Runner: Prepare owned dispatch
    Tick->>Store: Recheck config, lease, stop and dispatch gates
    alt Configuration changed or occurrence stopped
        Tick-->>UI: Cancel stale dispatch; preserve current run state
    else Still admitted
        Tick->>Runner: Dispatch once using the selected account/model
        Tick->>Store: Record actual runner and running state
        Store-->>UI: Active runner/state plus separate next occurrence
    end
```

Acceptance: frozen original/fixed cases cover hidden A1 Watch after choosing
A2, account-scoped reset deduplication and legacy migration, A1 limit to A2
handoff, current versus historical status, mismatched account quota, a
configuration change during delayed preparation, and cancellation while
launch acknowledgement is pending. Existing continuation, restart, MAIN,
stop, quota and duplicate tick checks remain green. Native packaged UI
checks the configured runner, active continuation and previous result as
separate observable states. Typecheck, lint, architecture, repository tests,
packaged build and boot precede delivery.
