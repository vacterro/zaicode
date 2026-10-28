# T-186: truthful scheduled readiness, bounded Collect, useful hints

Source: ZAICODE SRC-123. The duplicated pasted text contains three distinct requests.

## Behavior and ownership

- The host job service owns Autopilot (`getAutoRun` / `setAutoRun`). The existing
  `zaicodeStore` projects it; sidebar Auto (`zaicodeAuditStore.smartMode`) remains
  the automatic SAIPEN/OUTBOX control. Scheduling must expose the Autopilot gate
  rather than presenting an unattended launch while that gate is off.
- An enabled schedule with Autopilot off is visibly paused on the Scheduler page,
  its rows, sidebar and SAIHOME. Its planned time may be shown as a plan, never
  as an unconditional launch. Scheduler offers the existing Enable Autopilot
  operation. Automatic occurrences remain unconsumed while Autopilot is off;
  missed/catch-up and stop-time semantics remain owned by the existing runner.
  Explicit Run now remains a manual operation.
- OUTBOX remains producer-owned and read-only. Its ready package generation is
  the package ID plus recorded source and role provenance. The existing composer
  command sender remains the sole submission path. One application-level guard
  admits each ready generation once per workspace identity, including across
  composer busy/draft cycles, Auto toggles and composer remounts. Different
  workspaces and genuinely new packages remain independent. Failed local
  admission does not consume the attempt. Manual Collect permits an explicit
  retry. No timeout may manufacture a new generation.
- A hint that only repeats a completely visible control label is suppressed.
  Icon-only controls, hidden or truncated labels, shortcuts and explanatory
  descriptions retain their hints. Keyboard accessibility and control labels
  remain intact.

```mermaid
sequenceDiagram
  participant Host as Host job service
  participant Store as Existing Autopilot projection
  participant Runner as Scheduler runner
  participant UI as Scheduler surfaces
  Host->>Store: getAutoRun / confirmed setAutoRun
  Store->>UI: same Autopilot state
  Runner->>Host: read automatic-launch gate
  alt Autopilot off
    Runner->>Runner: preserve occurrence, apply stop rules
    UI->>UI: paused; offer Enable Autopilot
  else Autopilot on
    Runner->>Runner: existing occurrence admission and dispatch
  end
```

Desktop and mobile read the same host contract and OUTBOX provenance. Workspace
identity, rather than a shared filesystem spelling, separates remote workspaces.
No accepted task queue or protocol mutation is introduced in the renderer.

## Acceptance

1. With a ready HUNT package and Auto on, repeatedly cycle composer disabled and
   enabled, change callbacks, toggle Auto, and remount the composer: one automatic
   Collect attempt. A second producer/package and a different workspace each
   receive their own attempt. Local rejection permits a subsequent attempt.
2. With enabled schedules and Autopilot off, Scheduler, sidebar and SAIHOME say
   Autopilot is required, do not claim firing, and preserve scheduled occurrence
   IDs. Enabling the existing host setting restores ordinary readiness. Stop
   rules continue to operate while automatic starts are paused.
3. Hover/focus Model settings with its complete label visible: no repeated-label
   popup. An icon-only control, a truncated/hidden label and a useful explanation
   still show their hints.
4. Same browser regression scenarios fail on the pre-fix subject and pass on the
   repaired subject. Run focused and repository checks; preserve unrelated local
   README, provider-node and release-default changes.
