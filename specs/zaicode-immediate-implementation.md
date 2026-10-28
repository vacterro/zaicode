# Immediate implementation by default (SRC-130 / T-195)

ZAICODE must carry out an actionable request directly. An old session's Plan
state, a model's proactive planning tool description, or a completed plan card
must not make implementation wait for a separate approval step.

## Behavior and ownership

- New, restored and imported composer drafts use full access with Plan off by
  default. Restoring session execution/configuration does not opt the next
  submission into planning. Provider/model selection and draft text survive.
- Planning remains a deliberate `/plan` or Plan-checkbox choice. The existing
  per-session composer draft owns that choice; a small explicit-choice marker
  distinguishes it from legacy drafts and old automatic plan transitions.
  Existing unmarked planning drafts migrate to implementation when read.
- Historical/replayed automatic plan-enter transitions cannot turn Plan on in
  an unmarked draft. Explicit planning can exit normally. Deduplication still
  uses the existing toolCallId; no new runtime state or command queue is added.
- Every ordinary submission freezes `planEnabled: false`; the native runtime
  receives that execution intent through the same v4 command path. Explicit
  Plan freezes true. The existing permission owner continues to reject the
  model's unsolicited EnterPlanMode before full-access permission bypass.
- Model-visible EnterPlanMode instructions match that policy in ZAICODE:
  implement the requested change, investigate as needed, and verify it. The
  upstream product and explicit configured planning override keep their own
  planning policy. Tool identities and ordering stay stable.
- ZAICODE does not render the large successful/historical plan card shown in
  the source image. Recorded content is retained; errors and explicit pending
  planning interactions stay visible. Copying an assistant answer excludes a
  hidden plan tool body. Upstream card presentation is unchanged.

```mermaid
sequenceDiagram
  participant C as Composer draft owner
  participant V as v4 command admission
  participant R as Existing runtime / permission owner
  participant UI as Conversation projection
  C->>C: restore text/model; Plan off unless explicitly chosen
  C->>V: freeze execution intent on submission
  V->>R: same command with planEnabled false
  R->>R: execute edits/tools; reject unsolicited EnterPlanMode
  R->>UI: normal work and outcome events
  UI->>UI: omit successful plan card; retain failures
```

No history deletion, blanket permission grant, model/provider selection change,
or conversation delivery change. Desktop continuous and mobile replayable
transport both carry the existing execution-state field.

## Acceptance

Unchanged regression instruments must fail against the prior product for a
legacy Plan draft and the visible card, and pass for immediate implementation.
Verify restored/imported defaults, text/model preservation, an explicit Plan
choice, replayed transitions, the actual frozen submission and real permission
decision, card/error/upstream rendering, and hook-safe React rerenders. Run
repository typecheck, lint/architecture and relevant/full tests before ship.
