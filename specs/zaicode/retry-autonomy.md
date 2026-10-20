# Retry autonomy (T-281 / SRC-183)

An inherited Global ON retry preference currently reports OFF and schedules
nothing when the independent Audits Auto switch is OFF. The user's failed turn
therefore waits for a manual action despite its visible ON preference.

`zaicodeEffectiveAutoRetry` remains the single retry decision. It reads the
session > project > global retry preference, session auto-continue OFF, and
the durable stop-all ledger. Audits smart mode has no retry authority. Its
switch only controls its existing audit work. Pane countdown, background retry,
error-paused queue and crash resume use the same decision; the button and notice
show that decision. The panel offers retry settings without a misleading route
to Audits. No new preference, migration or retry state is introduced.

Retry ON schedules transient failures automatically with the existing exponential
backoff and attempt budget. Explicit retry OFF, session OFF, manual Stop, closed
error notices, exhausted budgets, quota walls and disabled projects keep their
existing authority. A quota fallback can retry through the existing route guard.
The sender rechecks admission at send time; changing Audits mode cannot cancel
or unlock a retry. Recovery after a renderer reload retains the safety ledger.

```mermaid
sequenceDiagram
    participant Error as Failed session
    participant Owner as Pane / background / queue
    participant Policy as Existing retry policy
    participant Host as Conversation command host
    Error->>Owner: Retryable failure
    Owner->>Policy: Scoped preference + session OFF + stop-all
    Policy-->>Owner: Allowed
    Owner->>Owner: Schedule bounded backoff; publish ledger
    Owner->>Policy: Recheck before sending
    Policy-->>Owner: Still allowed
    Owner->>Host: Existing retry / continue command
```

Acceptance uses unchanged red/green regressions with Audits OFF and inherited
Global ON, plus a browser fixture mounting the real pane and background hooks.
It proves an automatic command actually fires, the button agrees, no double
send occurs, explicit OFF cancels a pending retry, and quota/budget/stop controls
remain effective. No provider request or paid inference is needed. Typecheck,
lint, architecture and the full suite must pass before the shared native build.
