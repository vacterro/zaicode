# Message time and readable time selection

SRC-244 / T-335 addresses missing message chronology and overlapping time-picker controls.

## Message chronology

- User and assistant text messages show their local send time and elapsed age without hovering. Streaming and completed assistant messages use the same timestamp.
- The existing durable `row.createdAt` owns message time. Rendering, replay, reconnect, editing and reopening never reset it. Missing or invalid timestamps are omitted rather than fabricated.
- Reuse `messageTimeLabel` for calendar-aware absolute labels. A separate elapsed formatter uses the same timestamp, clamps clock skew to zero, and localizes seconds/minutes/hours/days through `Intl.RelativeTimeFormat`.
- A small memoized metadata leaf reads the existing gated clock; only metadata updates, not message content or accepted state. Show the full local date/time with timezone in the accessible time element's title and the original ISO value in `dateTime`.
- Metadata remains outside the hover-only action controls, wraps within narrow conversations, and does not replace working duration.

```mermaid
sequenceDiagram
    participant Runtime as Existing message owner
    participant Row as Durable conversation row
    participant Metadata as Message time leaf
    participant Clock as Existing gated UI clock
    Runtime->>Row: createdAt (persisted once)
    Row->>Metadata: createdAt
    Clock->>Metadata: minute display update
    Note over Metadata: Local time and elapsed age only; no writes to Row
```

## Time picker

- Reuse `ZaicodeTimeField` and its one draft/commit path; no browser-native picker or second persisted time.
- Present all 24 hours and twelve five-minute stops in separate, full-width six-column sections. Controls remain readable at the user's font sizes, with at least 24px hit targets and no overlapping text or nested scrollbars.
- Preserve direct typing, the 24-hour format, keyboard stepping and exact minutes. The +/- buttons move the complete draft by one minute, including hour and midnight rollover.
- Reuse the shared collision-aware popover for viewport edges and clipping ancestors. The panel fits 640x540 and narrow mobile viewports, opens above a low anchor when needed, and remains keyboard reachable.
- Only Done commits. Cancel, Escape and outside click discard the picker draft. Opening or navigating it never silently changes the saved schedule.
- Keep the existing Golden theme tokens and typography; no new palette, animation or global settings changes.

## Acceptance

1. Fixed message timestamps display absolute time plus localized age for both roles before hover; aging and remount preserve the original send time.
2. Invalid/missing timestamps never render a false current time. Clock skew never produces a negative age.
3. Actual browser interaction selects 23:55, advances across midnight, cancels without committing, and commits the exact draft only with Done.
4. Real rendered controls have non-overlapping bounds at default and larger UI fonts, including 640x540 and a narrow viewport; edge anchors do not place the panel outside the viewport.
5. Focus, typing, Escape, outside dismissal and the original date/time parser regressions pass. Typecheck, full lint, architecture and applicable repository tests pass.

No storage migration, settings reset, provider request, production process replacement or publication is part of this change.
