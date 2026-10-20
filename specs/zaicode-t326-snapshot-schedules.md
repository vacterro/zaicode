# T-326: Save Settings excludes user schedules

This eliminates fresh installations inheriting another user's scheduled jobs
and showing their missed-schedule alerts. SRC-237 changes the export policy:
user schedules remain local runtime configuration, rather than release defaults.

`captureZaicodeSettingsSnapshot` remains the single export projector. It excludes
the whole `zaicode-autostart-v1` family, whether rules are enabled, disabled,
empty or malformed. The mixed `zaicode-timer-prefs-v1` family retains clock,
temporary-timer and other ordinary preferences while omitting custom
`intervalRules` and their `missed` runtime markers. Legacy nested copies in saved
presets/profile containers, including JSON-encoded payloads, follow the same
recursive projection. The existing session/history guard still applies.

Save Settings never removes, rewrites or disables schedules in localStorage or
the runtime database. Reading an explicit existing profile still returns its
unchanged rules. New bundled defaults contain no user autostart family or custom
timer rules. Regenerate them only through the existing canonical Save All capture
from an isolated bundled baseline; preserve unrelated preference bytes, cueAudio
and ProTrail OFF. No production profile or executable replacement is involved.

Regression proof uses synthetic schedules, an unchanged original/fixed export
oracle, writable-storage tripwires, nested legacy containers and an independent
factory-data check. Existing schedule-preservation assertions are updated to the
stronger SRC-237 export exclusion, while preserving actual runtime rule storage.
