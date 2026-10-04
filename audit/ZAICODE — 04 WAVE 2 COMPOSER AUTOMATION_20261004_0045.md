ZAICODE

WAVE 2 — COMPOSER AUTOMATION CONTROLS

Use the existing tickets:
- T-198 / SRC-132
- T-201 / SRC-135
- T-204 / SRC-138

Do not create duplicates.

A. AUTO-GOAL — T-204

Add a compact composer control:

AUTO-GOAL ON/OFF

Scope:
per project.

Default:
ON for a new project unless existing migration policy requires preserving an
explicit prior preference.

User intent:
when Auto-Goal is ON, every ordinary user prompt behaves as if the operator also
supplied `goal cc all`, without forcing the operator to send a second message.

IMPORTANT IMPLEMENTATION CONTRACT

Do not mutate the visible/stored user text by secretly concatenating characters
onto it.

Represent Auto-Goal as structured dispatch intent.

The UI should show that Goal mode is active for the dispatch, but the message
body remains exactly what the user typed.

The authoritative SAIPEN ingress should receive the equivalent goal intent once.

Avoid duplication:
- if the user explicitly sends `/goal ...`, do not inject a second goal;
- if the action itself is a control command that must not become a project goal,
  preserve current command semantics;
- retries must not multiply goal ingress.

Persist by stable project identity.

B. AUTO RETRY — T-201

Add an obvious composer-adjacent Auto Retry control.

States:
- OFF
- SESSION
- PROJECT
- GLOBAL

The active state must be visually obvious.

Semantics:

SESSION:
only current session retries eligible failures automatically.

PROJECT:
all eligible sessions in this project.

GLOBAL:
eligible sessions/projects across ZAICODE.

Do not retry every failure blindly.

Retry only errors classified as safely retryable according to the authoritative
execution/router layer.

Use:
- bounded attempts;
- backoff;
- cancellation;
- stable logical run identity;
- exactly-one accepted result.

Quota exhaustion should cooperate with the existing route/fallback circuit logic
rather than hammering the same exhausted provider.

Manual STOP disables pending retry for that logical execution.

Persistence must match scope.

C. CTRL+CLICK SCHEDULER / WORKER ELIGIBILITY — T-198

The subscription/readiness tiles used around Worker/Scheduler controls should
support:

Ctrl+Click:
toggle whether that account/subscription is eligible for scheduled Worker
dispatch.

This is an eligibility toggle, NOT an immediate model launch.

Required UI:
- obvious enabled/disabled visual state;
- tooltip describing Ctrl+Click;
- current quota/readiness telemetry remains visible;
- disabled account is excluded from scheduler route candidates;
- normal click keeps its existing behavior.

Never disable the account/provider globally merely because it is excluded from
Scheduler eligibility unless that is already the explicit product contract.

Persist by stable provider/account identity.

AUTOMATION CROSS-CHECK

Prove:
- Auto-Goal + Auto Retry can coexist;
- retries do not create repeated `/goal` receipts;
- Scheduler eligibility does not affect manual user model selection unexpectedly;
- global Auto Retry cannot resurrect manually stopped work;
- project/session switching does not leak one project's Auto-Goal preference into
  another.

WAVE ACCEPTANCE

- T-198, T-201, T-204 individually verified;
- exact scope persistence proven across restart;
- no duplicate logical turns;
- no duplicate SAIPEN goal ingress;
- normal manual composer behavior unchanged when controls are OFF.
