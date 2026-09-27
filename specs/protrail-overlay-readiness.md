# ProTrail overlay readiness

The desktop main process owns the current configuration, each display's DIP
bounds and the lifetime of its overlay. Each renderer owns only its local
trail. The existing overlay-feed channel carries config, origin and events;
no additional IPC surface or persistence is introduced.

An overlay receives the latest config and display origin when its document
finishes loading, including when Electron still reports `isLoading()`. The
module script has registered the renderer listener by `did-finish-load`.
Readiness is per document and resets at `did-start-loading`. Before readiness,
transient mouse batches are dropped; after readiness, feeds are delivered until
the next load or destruction. Reload resends current state, not stale creation
bounds. Destroyed windows and web contents never receive feeds.

```text
main creates overlay -> did-start-loading -> feeds withheld
renderer module registers onFeed -> did-finish-load
main marks document ready -> sends current config + current DIP origin
did-stop-loading (later) -> subsequent mouse batches keep flowing
reload -> readiness cleared -> listener registered -> current state resent
```

Regression scenarios: monitors at zero, positive and negative origins receive
initial state while loading remains true; bounds/config changes during load
are reflected in initial state; reload blocks feeds until initialization;
destroyed windows are skipped. Physical-pixel conversion remains owned by
`screen.screenToDipPoint`; cursor-poll coordinates are already DIP. Mixed-DPI
and visual pointer alignment require Windows operator acceptance. Web/mobile
do not use these desktop overlays. Existing config and IPC payloads need no
migration.

On Windows the overlay is a native tool window (`type: toolbar`), not a normal
application window. Desktop window managers must not relocate it to the active
monitor after it is shown. `skipTaskbar` alone does not establish this native
classification. Other platforms retain their existing window type. Bounds
remain owned by the display map; user window-manager settings are untouched.
Acceptance includes comparing actual native rectangles after show against all
display bounds, with FancyZones active-monitor placement enabled.
