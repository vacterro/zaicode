# ZAICODE translation drafts

**v0.0.2**

Release surface for translations that are being written but are not yet
reviewed. Nothing in this directory is authoritative; nothing here ships.

## What lives here

| File | Role |
| --- | --- |
| `<locale>.json` | The working draft for that locale. |
| `<locale>.kept.json` | Segments the translator deliberately left in the source language, with a reason. |

## Rules

- **A draft is private until reviewed.** Promotion is a move into the `docs/`
  subtree as `<locale>.reviewed.json`, not an edit here.
- **A kept segment carries a reason.** "Unknown", "brand name" and "product
  name" are reasons. Silence is not.
- **A draft never drops a protected token.** Integrity is checked at review,
  but a draft that lost `{expression0}` costs the reviewer a repair cycle for
  nothing.

See the repository root [README.md](../../../README.md) for the full project.