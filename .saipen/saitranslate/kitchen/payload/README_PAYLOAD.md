# ZAICODE locale payloads

**v0.0.2**

Release surface for the per-locale payload directories — the assembled files a
running ZAICODE actually reads. This is the last stage before a string reaches
the screen.

## What lives here

One directory per locale (`ar-SA`, `bg-BG`, `cs-CZ`, `da-DK`, `de-DE`, `ded`,
`el-GR`, `es-ES`, and the rest), each holding that locale's assembled catalogue
and its review and repair records.

## Rules

- **A payload directory is generated, never edited by hand.** A hand edit is
  overwritten by the next assembly and lost without a trace. Fix the catalogue
  upstream and reassemble.
- **The payload is what ships.** A translation reviewed upstream but missing
  here is not in the build; a payload present here but not reviewed is a defect.
- **Protected tokens are checked at assembly.** A locale directory whose token
  set does not match the source catalogue is quarantined, not shipped.

See the repository root [README.md](../../../README.md) for the full project.