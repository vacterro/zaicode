# SAIPEN live status strip controls (SRC-183)

The live status strip above a session's transcript is always on screen, so the
operator must be able to switch it off, choose its shape, and give it its own
type size without touching the rest of the interface.

## Ownership and behavior

- `ZaicodeSaipenLiveStatusStrip` renders the strip in the four shapes of
  `saipenStatusView`: `compact` (one row), `expanded` (every field in a panel),
  `collapsed` (slim bar) and `off` (nothing renders). The ⇕ chevron cycles
  compact → expanded → collapsed → compact, as before; `off` is reached only on
  purpose.
- Every shape carries an eye-off (Hide) affordance that writes `off`. A hidden
  strip has no on-screen control, so Settings → Layout & home is the documented
  way back; the block's hint says so.
- A right-click anywhere on the strip opens its own settings panel (the shared
  SRC-151 wrapper, `preferenceKey="statusStrip"`): the same shape choice and
  font-size stepper as Settings, one implementation (`ZaicodeSaipenStatusSettings`).
- `saipenStatusFontSize` (8–20 px, default 11) is this strip's alone. All strip
  type sizes are em-based so the one number scales the whole strip; the app-wide
  typography settings do not change and the strip does not change them.
- These are renderer-local preferences, persisted with the other UI prefs under
  the same storage key. No SAIPEN protocol file, ticket state, MAIN ownership or
  side-pane behavior is affected.

## Acceptance

With a real project: the strip shows in compact shape; the chevron walks
compact → expanded → collapsed → compact; the eye-off hides the strip entirely
and Settings → Layout & home brings it back; the font-size stepper resizes the
whole strip (8–20 px) and nothing else; a right-click on the strip opens the
same shape and size controls. Preferences survive a restart.
