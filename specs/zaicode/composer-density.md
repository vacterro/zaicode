# Composer density (T-280 / SRC-182)

The workspace composer must spend space on editing and usable controls. The
reported 1440px window has a healthy router message occupying an entire header
row, an OUTBOX row containing only two small controls, and widely separated
toolbar groups. Empty layout rows and automatic spacers have no product purpose.

## Ownership and layout

- `ChatPromptEditor` owns the shell and passes the existing OUTBOX projection to
  `ZaicodeSaipenControls`. The OUTBOX controls sit in the same wrapping action
  row as START, STEP, CLEAR, phase and the strip settings. They keep their current
  command admission, collect guard, disabled conditions and settings behavior.
- SAIPEN action rows pack their controls from the left with a 4px gap. A narrow
  window wraps actual controls; it never allocates a blank spacer row. Full strip
  explanatory lines remain controlled by the existing preferences.
- The ordinary ZAICODE toolbar packs attachment/mode, model choices and send
  controls in reading order. Model names truncate within their buttons, with full
  names in tooltips. Narrow layouts wrap controls without clipping or overlap.
  Send/Stop stays reachable and is never hidden by the width fitting ladder.
- A ZAICODE dock with no adjacent status panel uses the available pane width and
  8px outer padding, independently of the transcript's reading width. An open
  adjacent status panel retains its necessary reservation. Draft input is not
  capped to the upstream centered greeting width.
- The compact workspace router projection omits `preferred` and `restored`
  success states. Recovery, fallback and unavailable states remain visible;
  Settings retains the complete router state. No new router state is created.

These are ZAICODE presentation changes. Upstream ZCode layout, existing user
preferences, accepted queues, MAIN ownership and provider configuration keep
their existing owners and command paths. No migration or remote delivery change.

## Acceptance

Use an isolated packaged Electron profile with a real project, compact and full
SAIPEN preferences, actionable OUTBOX and the existing model controls. At 1440px,
OUTBOX shares the SAIPEN action row when it fits, neighboring controls have
bounded gaps, and the composer has no arbitrary transcript gutters. At 640px
and wider, controls remain contained and Send/Stop remains reachable. Repeated
resize converges and keyboard focus, compact toggle, model selection, OUTBOX
popover and toolbar actions keep working. No paid inference is required.

The unchanged native oracle must reject the old layout and accept the repair.
Record screenshots and pixel geometry, plus focused regressions, typecheck,
lint and architecture checks. Keep artifacts separate from the running app;
building or checking a candidate must not restart the operator's sessions.
